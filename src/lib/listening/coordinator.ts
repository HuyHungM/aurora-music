import type { MusicEngine } from "@/lib/music/music-engine";
import { allKeysOf, identityKeyOf, relateQueues } from "@/lib/music/queue-relation";
import { recommendTracksAction } from "@/app/actions/recommendations";

/**
 * Generic queue continuation — "Keep listening" (Phase 47).
 *
 * ```text
 *   RecommendationService  (server, per batch)
 *            ↓
 *   InfiniteListeningCoordinator  (this file: when, how much, is it stale?)
 *            ↓
 *   QueueManager  (sole queue authority — appends only)
 * ```
 *
 * This coordinator decides WHEN to ask, HOW MANY to ask for, whether the
 * listening context still matches, and whether a human has overridden it.
 * It owns no playback, no audio, and no queue state: every append goes
 * through `engine.queue.add`, and QueueManager remains the only authority.
 *
 * It is deliberately NOT radio. Radio is an explicit, user-initiated
 * station with its own seed and its own generation loop; when a station is
 * active, `isExclusiveContinuationActive()` reports true and this
 * coordinator stands down entirely rather than running a second,
 * competing continuation system over the same queue (§55).
 *
 * Memory-only by design: a reload drops the coordinator. The persisted
 * queue survives as ordinary entries and is never re-seeded from a
 * recommendation snapshot, because the queue — not the algorithm — is the
 * artifact worth restoring (§67).
 */

/** Remaining queue items at or below which the next batch is requested. */
export const KEEP_LISTENING_THRESHOLD = 2;
/** Bounded batch size. Never unbounded, never one-at-a-time. */
export const KEEP_LISTENING_BATCH = 6;
/** Absolute per-session cap on generated tracks. */
export const KEEP_LISTENING_MAX_GENERATED = 120;
/**
 * Consecutive non-productive attempts — a provider failure, an empty batch,
 * or a batch that added nothing — before continuation is declared exhausted.
 * This is the retry bound: it counts failures, not just empty results, so a
 * provider that is down stops being retried instead of spinning forever.
 */
export const KEEP_LISTENING_BARREN_LIMIT = 2;
/**
 * Minimum gap between two generations (§62). Stops a pathological loop
 * where a small candidate pool produces one or two tracks per request and
 * the queue is instantly low again. The queue is pre-filled to a
 * threshold-sized runway, so this never delays normal playback.
 */
export const KEEP_LISTENING_COOLDOWN_MS = 15_000;
/** Cap on remembered recommended keys (bounded memory, §49). */
export const KEEP_LISTENING_RECOMMENDED_CAP = 300;

export interface KeepListeningStatus {
  /** The listener's explicit preference. Default OFF. */
  enabled: boolean;
  /**
   * Whether a signed-in listener owns this preference. Anonymous visitors
   * resolve to the OFF default: continuation is never silently enabled for
   * someone who cannot express or persist a choice.
   */
  authenticated: boolean;
  generating: boolean;
  exhausted: boolean;
  /** Translation key for a user-facing error, if any. */
  error: string | null;
  /** Tracks this coordinator has appended since the page loaded. */
  generatedTotal: number;
}

interface CoordinatorState extends KeepListeningStatus {
  recommendedKeys: string[];
  /**
   * Consecutive attempts that produced nothing appendable — a provider
   * failure, an empty batch, or a batch whose every track was already
   * queued. Each costs one attempt of the retry budget so a persistently
   * broken provider terminates instead of retrying forever (§62, §64).
   */
  barrenAttempts: number;
  /** When the last attempt completed, productive or not. */
  lastAttemptAt: number;
}

const INITIAL_STATE: CoordinatorState = {
  enabled: false,
  authenticated: false,
  generating: false,
  exhausted: false,
  error: null,
  generatedTotal: 0,
  recommendedKeys: [],
  barrenAttempts: 0,
  lastAttemptAt: 0,
};

export interface CoordinatorDeps {
  /**
   * True while another continuation system owns the queue (radio). While
   * this returns true this coordinator makes no requests and no appends.
   */
  isExclusiveContinuationActive: () => boolean;
  /** Injectable clock, so cooldown behaviour is testable without timers. */
  now?: () => number;
  /** Injectable request, so the coordinator is testable without a server. */
  request?: typeof recommendTracksAction;
}

export function createInfiniteListeningCoordinator(
  deps: CoordinatorDeps,
) {
  const now = deps.now ?? (() => Date.now());
  const request = deps.request ?? recommendTracksAction;
  let state: CoordinatorState = { ...INITIAL_STATE, recommendedKeys: [] };
  const listeners = new Set<() => void>();
  // Set while the coordinator itself appends, so the watcher never mistakes
  // its own appends for a user override.
  let ownMutation = false;
  /** Queue signature expected after the coordinator's last mutation. */
  let expectedSig: readonly string[] | null = null;
  /**
   * Monotonic context token. Bumped by every human override (queue
   * replaced or cleared) and by `end()`. A response may only be applied
   * when the token it captured is still current — this is what stops a
   * batch requested for playlist A from landing in playlist B's queue
   * (§59, §60).
   */
  let epoch = 0;
  /** Sequence of the newest in-flight request; older ones are dropped. */
  let latestRequestSeq = 0;
  /**
   * Queue signature the in-flight request was captured for. `expectedSig` is
   * null until the coordinator observes a queue change, so on the very first
   * batch there is no baseline to compare against — this is. Without it, a
   * listener who replaces the queue while the FIRST batch is in flight would
   * have that batch land in the new queue, which is the exact override the
   * epoch guard exists to prevent.
   */
  let requestSig: readonly string[] | null = null;

  function emit(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function set(patch: Partial<CoordinatorState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function queueKeysOf(engine: MusicEngine): string[] {
    return engine.queue.items.map(identityKeyOf);
  }

  function seedRefOf(engine: MusicEngine): {
    provider: string;
    providerTrackId: string;
    artistName?: string;
  } | null {
    const current = engine.getState().currentTrack;
    if (!current) {
      return null;
    }
    // Read defensively. `currentTrack` is a TrackIdentity by contract, but a
    // continuation coordinator must not be the thing that turns a shape
    // mismatch into a thrown error inside a fire-and-forget promise.
    const source = current.primarySource;
    if (!source || typeof source.source !== "string" || typeof source.id !== "string") {
      return null;
    }
    return {
      provider: source.source,
      providerTrackId: source.id,
      artistName: current.artists?.[0]?.name,
    };
  }

  function rememberRecommended(tracks: Parameters<typeof allKeysOf>[0][]): void {
    const keys = [...state.recommendedKeys];
    for (const track of tracks) {
      for (const key of allKeysOf(track)) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }
    set({ recommendedKeys: keys.slice(-KEEP_LISTENING_RECOMMENDED_CAP) });
  }

  function remaining(engine: MusicEngine): number {
    const length = engine.queue.length;
    if (length === 0) {
      return 0;
    }
    return length - engine.queue.currentIndex - 1;
  }

  /**
   * Threshold check. Runs on every queue/cursor/order change, and never on
   * progress ticks, so it cannot spin.
   */
  function maybeContinue(engine: MusicEngine): void {
    if (!state.enabled || state.generating || state.exhausted) {
      return;
    }
    if (deps.isExclusiveContinuationActive()) {
      // Radio owns the queue while a station is active. Standing down here
      // (rather than only at request time) means no stale in-flight request
      // is treated as authoritative either.
      return;
    }
    const length = engine.queue.length;
    if (length === 0) {
      // §53: an empty queue is never silently repopulated. A human who
      // clears the queue has answered; they can start playback or a station
      // again if they want music.
      return;
    }
    if (remaining(engine) > KEEP_LISTENING_THRESHOLD) {
      return;
    }
    if (now() - state.lastAttemptAt < KEEP_LISTENING_COOLDOWN_MS) {
      return;
    }
    // The promise is owned here rather than discarded with `void`. Every
    // EXPECTED failure is already handled inside `continueQueue`; this catch
    // exists for the unexpected one, and it routes it into the same bounded
    // retry path. A `void`ed call would instead leave an unhandled rejection
    // in the page — a user-visible error — and would leave `generating` stuck
    // true, wedging the toggle until a reload.
    void continueQueue(engine).catch(() => {
      finishBarren("recommendations.unavailable");
    });
  }

  /**
   * The single terminal handler for an attempt that produced nothing
   * appendable: a rejected request, an error response, a response with no
   * tracks, a batch whose every track was already queued, or an unexpected
   * internal error. Each costs one attempt of the retry budget and stamps the
   * attempt time, so a broken provider is retried a bounded number of times
   * and never on a tight loop.
   */
  function finishBarren(error: string | null): void {
    const barrenAttempts = state.barrenAttempts + 1;
    const exhausted = barrenAttempts >= KEEP_LISTENING_BARREN_LIMIT;
    set({
      generating: false,
      barrenAttempts,
      exhausted,
      lastAttemptAt: now(),
      // A failed request is surfaced once; an exhausted-but-successful empty
      // batch is not an error, it just means the pool ran dry.
      error,
    });
    if (!exhausted) {
      maybeContinuePending();
    }
  }

  /** Re-evaluates a trigger that landed while a batch was in flight. */
  let pendingEngine: MusicEngine | null = null;

  function maybeContinuePending(): void {
    const engine = pendingEngine;
    pendingEngine = null;
    if (engine) {
      maybeContinue(engine);
    }
  }

  async function continueQueue(engine: MusicEngine): Promise<void> {
    if (!state.enabled || state.generating || state.exhausted) {
      return;
    }
    if (state.generatedTotal >= KEEP_LISTENING_MAX_GENERATED) {
      set({ exhausted: true });
      return;
    }
    const budget = Math.min(
      KEEP_LISTENING_BATCH,
      KEEP_LISTENING_MAX_GENERATED - state.generatedTotal,
    );
    if (budget <= 0) {
      set({ exhausted: true });
      return;
    }

    // §46: current-queue context is mandatory. The whole queue is excluded,
    // plus everything already recommended, so a continuation can never
    // re-add what is already queued or what was just suggested.
    const exclude = new Set<string>([
      ...queueKeysOf(engine).flatMap((key) => [key]),
      ...state.recommendedKeys,
    ]);
    for (const item of engine.queue.items) {
      for (const key of allKeysOf(item)) {
        exclude.add(key);
      }
    }
    const capturedEpoch = epoch;
    const seq = ++latestRequestSeq;
    // A trigger that lands while this batch is in flight is remembered and
    // re-evaluated once the batch resolves, so a threshold crossing that
    // happened mid-request is not silently dropped.
    pendingEngine = engine;
    requestSig = queueKeysOf(engine);
    set({ generating: true, error: null });

    let result: Awaited<ReturnType<typeof recommendTracksAction>>;
    try {
      result = await request({
        surface: "continuation",
        currentTrack: seedRefOf(engine),
        excludeKeys: [...exclude].slice(-KEEP_LISTENING_RECOMMENDED_CAP),
        limit: budget,
      });
    } catch {
      result = { ok: false, error: "recommendations.unavailable" };
    }

    // A response is applicable only if nothing changed underneath it: the
    // listener is still in keep-listening mode, no human override happened,
    // no competing system took the queue, and this is the newest request.
    if (
      !state.enabled ||
      state.exhausted ||
      capturedEpoch !== epoch ||
      seq !== latestRequestSeq ||
      deps.isExclusiveContinuationActive()
    ) {
      // Stale. The context that warranted this batch no longer applies, so
      // the remembered trigger is dropped with it — re-evaluating here would
      // be exactly the override this guard exists to prevent.
      //
      // The in-flight latch MUST still be released. Leaving `generating`
      // true here would wedge the feature for the rest of the page load:
      // the toggle would read "generating" forever and no further batch
      // could ever be requested, however low the queue later fell. No
      // attempt is charged — nothing was wasted, the batch was discarded
      // because the listener intervened.
      pendingEngine = null;
      requestSig = null;
      set({ generating: false });
      return;
    }
    requestSig = null;

    const appendable =
      result && result.ok
        ? result.tracks.filter(
            (track) => !allKeysOf(track).some((key) => exclude.has(key)),
          )
        : [];

    if (appendable.length === 0) {
      finishBarren(result && !result.ok ? "recommendations.unavailable" : null);
      return;
    }

    ownMutation = true;
    try {
      for (const track of appendable) {
        engine.queue.add(track);
      }
    } finally {
      ownMutation = false;
    }
    rememberRecommended(appendable);
    expectedSig = queueKeysOf(engine);
    set({
      generating: false,
      barrenAttempts: 0,
      exhausted: false,
      generatedTotal: state.generatedTotal + appendable.length,
      lastAttemptAt: now(),
    });
    // A trigger that landed while this batch was in flight still deserves
    // evaluation once the batch is in place.
    maybeContinuePending();
  }

  return {
    getState(): CoordinatorState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Applies the persisted preference. Called once at startup with the
     * value read from the user's account. Enabling does NOT immediately
     * generate: continuation starts on the next queue change, so turning it
     * on mid-track never hijacks what is playing.
     */
    hydrate(enabled: boolean, authenticated: boolean): void {
      if (state.enabled === enabled && state.authenticated === authenticated) {
        return;
      }
      epoch += 1;
      set({
        ...INITIAL_STATE,
        recommendedKeys: state.recommendedKeys,
        enabled,
        authenticated,
      });
    },

    setEnabled(enabled: boolean): void {
      if (state.enabled === enabled) {
        return;
      }
      epoch += 1;
      // `authenticated` is carried across, exactly as `noteQueueChanged`
      // carries it. It is not a continuation detail — it is who the preference
      // belongs to. Dropping it here made the autoplay control render itself
      // away the moment it was switched on, permanently, because nothing ever
      // re-hydrates: the listener's signed-in state would depend on whether
      // they had used the control yet.
      const who = state.authenticated;
      if (!enabled) {
        // Turning it off must leave an in-flight response harmless: the
        // epoch bump above already guarantees that.
        set({ ...INITIAL_STATE, recommendedKeys: state.recommendedKeys, authenticated: who });
        expectedSig = null;
        return;
      }
      set({
        ...INITIAL_STATE,
        recommendedKeys: state.recommendedKeys,
        enabled: true,
        authenticated: who,
      });
    },

    /**
     * Called on every queue-identity change. Pure additions, removals and
     * reorders keep continuation alive (they are ordinary queue edits);
     * a wholesale replacement or a clear ends it, because that is a human
     * starting something specific (§52, §53, §54).
     */
    noteQueueChanged(queueKeys: readonly string[]): void {
      if (ownMutation) {
        expectedSig = queueKeys;
        return;
      }
      if (expectedSig === null) {
        // No baseline yet. Prefer the signature the in-flight request was
        // captured for: on the very first batch that IS a baseline, and
        // comparing against it is what detects a replace/clear that happened
        // mid-request. Failing that, an empty queue is still unambiguous —
        // "the queue is now empty" is never a legitimate continuation
        // context and always means a human cleared it (§53).
        const baseline = requestSig;
        if (baseline !== null && relateQueues(baseline, queueKeys) === "replaced") {
          epoch += 1;
        } else if (queueKeys.length === 0) {
          epoch += 1;
        }
        expectedSig = queueKeys;
        return;
      }
      const relation = relateQueues(expectedSig, queueKeys);
      if (relation === "replaced") {
        epoch += 1;
        set({
          ...INITIAL_STATE,
          recommendedKeys: state.recommendedKeys,
          enabled: state.enabled,
          authenticated: state.authenticated,
          // The preference itself survives; only the continuation context
          // is dropped. A replaced queue is a fresh start, so the next
          // threshold crossing seeds from the new context.
        });
      }
      expectedSig = queueKeys;
    },

    maybeContinue,

    end(): void {
      epoch += 1;
      set({ ...INITIAL_STATE, recommendedKeys: [] });
      expectedSig = null;
    },

    /** Test seam: the context token a response must still match. */
    getEpoch(): number {
      return epoch;
    },

    /** Test seam: the expected queue signature. */
    getExpectedSig(): readonly string[] | null {
      return expectedSig;
    },
  };
}

export type InfiniteListeningCoordinator = ReturnType<
  typeof createInfiniteListeningCoordinator
>;
