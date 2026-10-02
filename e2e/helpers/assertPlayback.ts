import type { Page } from "@playwright/test";

/**
 * Playback assertions that read the real media element.
 *
 * WHY NOT THE SLIDER
 *
 * The player owns a media element created with `new Audio()` and never attaches
 * it to the document, so there is no `audio` selector to assert on. The previous
 * playback tests used `input[aria-label="Seek"]` instead, which meant a missing
 * seek control timed out and the failure was reported as NOT_PLAYING - a
 * diagnosis about a slider, for a stream that was playing. A test that cannot
 * tell "the media is not playing" from "the control is not rendered" is not a
 * playback test.
 *
 * These helpers read `PlayerEngine.mediaDiagnostics()` through the probe mounted
 * on the `/e2e-playback` fixture route, so every assertion describes media
 * state. UI selectors remain welcome for asserting CONTROLS; they are simply
 * never the evidence that audio advanced.
 */

/** Mirrors `MediaDiagnostics` in `src/lib/player/engine.ts`. */
export interface MediaState {
  hasSource: boolean;
  readyState: number | null;
  networkState: number | null;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  currentTime: number;
  duration: number;
  errorCode: number | null;
}

/**
 * Why a playback expectation did not hold.
 *
 * The point of enumerating these is that the failure message names the layer
 * that broke. "NOT_PLAYING" is what a missing slider used to produce; the
 * useful answer is which of the five stages actually failed.
 */
export type PlaybackFailureKind =
  /** The probe never appeared: the fixture route did not mount, or the engine never existed. */
  | "UI_SELECTOR_FAILURE"
  /** No signed URL reached the media element: resolution produced nothing. */
  | "RESOLVER_FAILURE"
  /** A source is assigned but the browser never fetched playable bytes. */
  | "MEDIA_REQUEST_FAILURE"
  /** Bytes arrived but the element could not decode them (errorCode 3/4). */
  | "MEDIA_DECODE_FAILURE"
  /** Media is loaded and unpaused, but position is not advancing. */
  | "PLAYER_STATE_FAILURE"
  /** The element never reached a loaded state inside the budget. */
  | "PLAYBACK_TIMEOUT";

export interface PlaybackDiagnosis {
  kind: PlaybackFailureKind;
  message: string;
  state: MediaState | null;
}

/** READY_STATE levels, named so assertions do not carry bare integers. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

declare global {
  interface Window {
    __auroraMediaDiagnostics?: () => MediaState | null;
  }
}

/** Reads the media element once. Returns null when the probe is not mounted. */
export async function readMediaState(page: Page): Promise<MediaState | null> {
  return page.evaluate(() => window.__auroraMediaDiagnostics?.() ?? null);
}

function describeState(state: MediaState | null): string {
  if (!state) {
    return "no media probe on the page (the /e2e-playback fixture did not mount)";
  }
  return [
    `hasSource=${state.hasSource}`,
    `readyState=${state.readyState}`,
    `networkState=${state.networkState}`,
    `paused=${state.paused}`,
    `ended=${state.ended}`,
    `currentTime=${state.currentTime.toFixed(3)}`,
    `duration=${state.duration.toFixed(3)}`,
    `errorCode=${state.errorCode}`,
  ].join(" ");
}

/**
 * Classifies why the media is not advancing.
 *
 * Ordered from the earliest stage that failed to the latest, so the reported
 * cause is the ROOT one: an unassigned source makes "position did not advance"
 * true as well, and reporting the timeout would hide the resolver failure that
 * caused it.
 */
export function diagnosePlayback(
  state: MediaState | null,
  reason: string,
): PlaybackDiagnosis {
  if (!state) {
    return {
      kind: "UI_SELECTOR_FAILURE",
      message: `${reason}. ${describeState(state)}`,
      state,
    };
  }
  if (!state.hasSource) {
    return {
      kind: "RESOLVER_FAILURE",
      message:
        `${reason}. No media source was ever assigned to the element, so ` +
        `playback never started. ${describeState(state)}.`,
      state,
    };
  }
  if (state.errorCode === 3 || state.errorCode === 4) {
    return {
      kind: "MEDIA_DECODE_FAILURE",
      message:
        `${reason}. The browser fetched the media but could not decode it ` +
        `(MediaError code ${state.errorCode}). ${describeState(state)}.`,
      state,
    };
  }
  if (state.errorCode === 2) {
    return {
      kind: "MEDIA_REQUEST_FAILURE",
      message:
        `${reason}. The media request failed in the network layer ` +
        `(MediaError code 2). ${describeState(state)}.`,
      state,
    };
  }
  if (state.readyState !== null && state.readyState < HAVE_CURRENT_DATA) {
    return {
      kind:
        state.readyState <= HAVE_METADATA
          ? "PLAYBACK_TIMEOUT"
          : "MEDIA_REQUEST_FAILURE",
      message:
        `${reason}. A source is assigned but the element never reached ` +
        `readyState ${HAVE_CURRENT_DATA} (HAVE_CURRENT_DATA). ` +
        `${describeState(state)}.`,
      state,
    };
  }
  if (state.paused) {
    return {
      kind: "PLAYER_STATE_FAILURE",
      message:
        `${reason}. The element has playable data but is PAUSED. ` +
        `${describeState(state)}.`,
      state,
    };
  }
  if (state.muted) {
    return {
      kind: "PLAYER_STATE_FAILURE",
      message:
        `${reason}. The element is playing but MUTED, so position may not ` +
        `advance. ${describeState(state)}.`,
      state,
    };
  }
  return {
    kind: "PLAYER_STATE_FAILURE",
    message: `${reason}. ${describeState(state)}.`,
    state,
  };
}

/** One line suitable for `testInfo.attach` or an assertion message. */
export function formatDiagnosis(diagnosis: PlaybackDiagnosis): string {
  return `[${diagnosis.kind}] ${diagnosis.message}`;
}

export interface PlaybackAdvanceOptions {
  /** How long to watch for the position to move. */
  timeoutMs?: number;
  /**
   * Minimum seconds of progress required. Generous on purpose: real audio
   * advances in bursts, and a tight threshold turns a slow CDN into a false
   * failure. Well below the 1-2s watch window, so it still catches a stalled
   * element.
   */
  minAdvanceSeconds?: number;
}

/**
 * Waits until the media element's `currentTime` has actually advanced.
 *
 * This is the assertion the whole live suite was missing: not "a control looks
 * like it is playing" but "the position moved".
 *
 * Polls the element rather than listening for `timeupdate`, because
 * `timeupdate` fires at the engine's throttled cadence and a listener attached
 * after playback started would never see the event that already happened.
 */
export async function expectPlaybackAdvancing(
  page: Page,
  options: PlaybackAdvanceOptions = {},
): Promise<{ before: number; after: number }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const minAdvance = options.minAdvanceSeconds ?? 0.25;
  const deadline = Date.now() + timeoutMs;
  const before = await readMediaState(page);

  let last: MediaState | null = before;
  let reason = "Playback did not start";
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    last = await readMediaState(page);
    if (!last) {
      reason = "The media probe disappeared while waiting for playback";
      continue;
    }
    if (last.errorCode !== null || !last.hasSource || last.paused) {
      reason = "Playback did not start";
      break;
    }
    if (last.currentTime > (before?.currentTime ?? 0) + minAdvance) {
      return { before: before?.currentTime ?? 0, after: last.currentTime };
    }
    reason = "Playback never advanced";
  }

  const diagnosis = diagnosePlayback(
    last,
    last && before && last.currentTime > before.currentTime
      ? `Playback advanced only ${(last.currentTime - before.currentTime).toFixed(3)}s in ${timeoutMs}ms, which is below the ${minAdvance}s threshold`
      : reason,
  );
  throw new Error(formatDiagnosis(diagnosis));
}

/** Asserts the element is loaded and not paused, without waiting for movement. */
export async function expectMediaLoaded(
  page: Page,
  timeoutMs = 60_000,
): Promise<MediaState> {
  const deadline = Date.now() + timeoutMs;
  let state: MediaState | null = await readMediaState(page);
  let reason = "The media element never reported a source";
  while (Date.now() < deadline) {
    if (state && state.hasSource && state.readyState !== null && state.readyState >= HAVE_CURRENT_DATA) {
      return state;
    }
    if (state?.errorCode !== null && state?.errorCode !== undefined && state?.errorCode) {
      break;
    }
    reason = state?.hasSource
      ? `The element stayed at readyState ${String(state.readyState)}`
      : "No media source was ever assigned";
    await page.waitForTimeout(250);
    state = await readMediaState(page);
  }
  throw new Error(formatDiagnosis(diagnosePlayback(state, reason)));
}

/** Asserts the position stops moving after a pause. */
export async function expectPlaybackPaused(
  page: Page,
  watchMs = 2_500,
  driftSeconds = 1.5,
): Promise<void> {
  const before = await readMediaState(page);
  if (!before) {
    throw new Error(
      formatDiagnosis(diagnosePlayback(null, "Cannot assert a pause without a media probe")),
    );
  }
  await page.waitForTimeout(watchMs);
  const after = await readMediaState(page);
  if (!after) {
    throw new Error(
      formatDiagnosis(diagnosePlayback(null, "The media probe disappeared during the pause watch")),
    );
  }
  const drift = Math.abs(after.currentTime - before.currentTime);
  if (drift > driftSeconds) {
    throw new Error(
      formatDiagnosis(
        diagnosePlayback(
          after,
          `Position moved ${drift.toFixed(3)}s while paused, above the ${driftSeconds}s tolerance. A pause that does not stop the element is a player-state failure, not a slow network.`,
        ),
      ),
    );
  }
}

/** Position in seconds. Reads the element, never the seek slider. */
export async function mediaCurrentTime(page: Page): Promise<number> {
  return (await readMediaState(page))?.currentTime ?? 0;
}

/** Duration reported by the element. 0 until metadata has loaded. */
export async function mediaDuration(page: Page): Promise<number> {
  return (await readMediaState(page))?.duration ?? 0;
}