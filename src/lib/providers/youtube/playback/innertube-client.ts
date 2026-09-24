/**
 * Real `YouTubePlaybackClient` over youtubei.js (pinned 18.0.0).
 *
 * SERVER-ONLY. This is the single module allowed to import youtubei.js;
 * everything it produces is normalized into `PlaybackMediaInfo` before it
 * leaves. Anonymous, stateless operation: no login, no cookies persisted,
 * no user data. One lazily created shared session is reused process-wide
 * (sessions hold no per-user state); simultaneous resolutions of the same
 * video share one in-flight request and results are never cached, so an
 * expired URL can never be re-served.
 *
 * Library objects are treated as untrusted input: every consumed field is
 * validated before use, so library upgrades fail closed into typed errors.
 */

import { Innertube } from "youtubei.js";
import type { Misc, Types, YT } from "youtubei.js";
import { Platform } from "youtubei.js";
import vm from "node:vm";

type Format = Misc.Format;
type VideoInfo = YT.VideoInfo;
type PlayerRequestClient = Types.InnerTubeClient;
import { ExtractorError } from "@/lib/domain";
import type {
  PlaybackFormatCandidate,
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "./types";

const PROVIDER_ID = "youtube";
const OPERATION = "getMediaInfo";
const RESOLVE_TIMEOUT_MS = 15_000;

type SessionFactory = () => Promise<Innertube>;

let sharedSession: Promise<Innertube> | null = null;

function defaultSessionFactory(): Promise<Innertube> {
  if (!sharedSession) {
    // generate_session_locally avoids extra round-trips; failures clear
    // the slot so the next call retries with a fresh session.
    sharedSession = Innertube.create({ generate_session_locally: true }).catch(
      (error: unknown) => {
        sharedSession = null;
        throw error;
      },
    );
  }
  return sharedSession;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ExtractorError(PROVIDER_ID, operation, "YouTube playback info timed out", {
          retryable: true,
        }),
      );
    }, RESOLVE_TIMEOUT_MS);
    const handle = timer as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

function toCandidate(format: Format): PlaybackFormatCandidate | null {
  const record = asRecord(format);
  const hasAudio = record?.has_audio === true;
  const hasVideo = record?.has_video === true;
  const url = asNonEmptyString(record?.url);
  // Ciphered formats carry no direct URL until deciphered (YouTube serves
  // `signature_cipher` + a decipher hook instead). They must pass the gate
  // here — the loop below deciphers and only usable URLs are surfaced.
  const decipherable = typeof record?.decipher === "function";
  if (!hasAudio || (!url && !decipherable)) {
    return null;
  }
  const candidate: PlaybackFormatCandidate = {
    url: url ?? "",
    hasAudio,
    hasVideo,
  };
  const mimeType = asNonEmptyString(record?.mime_type);
  if (mimeType) {
    candidate.mimeType = mimeType;
  }
  const bitrate = asPositiveInt(record?.bitrate);
  if (bitrate !== undefined) {
    candidate.bitrate = bitrate;
  }
  const durationMs = asPositiveInt(record?.approx_duration_ms);
  if (durationMs !== undefined) {
    candidate.durationMs = durationMs;
  }
  return candidate;
}

async function decipherUrl(format: Format, player: unknown): Promise<string | undefined> {
  try {
    const decipher = (format as unknown as { decipher?: unknown }).decipher;
    if (typeof decipher !== "function") {
      return undefined;
    }
    const url = await (decipher as (player?: unknown) => Promise<unknown>).call(
      format,
      player,
    );
    return asNonEmptyString(url);
  } catch {
    return undefined;
  }
}

/**
 * Reads the decipher-capable player object from a session using only
 * runtime validation (library internals are untrusted input like any
 * payload). Returns undefined when the shape is unfamiliar so callers
 * fail closed into typed errors instead of throwing on internals.
 */
export function sessionPlayer(session: unknown): unknown {
  const inner = asRecord(asRecord(session)?.session);
  return inner?.player;
}

type EvaluatorEnv = Record<string, string | number | boolean | null | undefined>;

/**
 * Runs a library-extracted player script in a bare `node:vm` context (no
 * Node globals) with a hard timeout. The generated script ends with a
 * top-level `return`, so it is wrapped in a function scope before running.
 * Anything unexpected fails closed (undefined) and the caller skips the
 * format.
 */
export function evaluatePlayerScript(
  data: { output: string },
  env: EvaluatorEnv,
): Record<string, unknown> | undefined {
  try {
    const context = vm.createContext({ ...env });
    const wrapped = `(function(){\n${data.output}\n})()`;
    const result = vm.runInContext(wrapped, context, { timeout: 5000 });
    return asRecord(result) ?? undefined;
  } catch {
    return undefined;
  }
}

let evaluatorInstalled = false;

/**
 * Installs the stdlib evaluator exactly once per process. Safe to call
 * repeatedly (dev HMR, tests); a frozen shim simply keeps failing closed.
 */
export function ensureJsEvaluator(): void {
  if (evaluatorInstalled) {
    return;
  }
  evaluatorInstalled = true;
  try {
    Platform.shim.eval = evaluatePlayerScript;
  } catch {
    evaluatorInstalled = false;
  }
}

function mapInfoError(videoId: string, error: unknown): never {
  if (error instanceof ExtractorError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : "";
  if (/unavailable|deleted|not found|private|unplayable|login required/i.test(message)) {
    throw new ExtractorError(PROVIDER_ID, OPERATION, `Video unavailable: ${videoId}`);
  }
  throw new ExtractorError(
    PROVIDER_ID,
    OPERATION,
    "YouTube playback info failed",
    { retryable: true, cause: error },
  );
}

export interface InnertubeClientOptions {
  sessionFactory?: SessionFactory;
}

/**
 * Primary player-request context.
 *
 * Runtime finding: the session default (WEB) withholds all stream URL
 * material — direct URLs and ciphers — for adaptive formats, and for
 * many videos for muxed formats as well, so candidate extraction yields
 * zero usable formats. The MWEB player context materializes them for
 * the same video id. The session (and its deciphering player) is
 * unchanged; only the per-request player context differs. Exact video
 * identity is unaffected: the request carries the same video id.
 */
const PRIMARY_PLAYER_CLIENT: PlayerRequestClient = "MWEB";

async function requestPlayerInfo(
  session: Innertube,
  videoId: string,
  client: PlayerRequestClient | undefined,
): Promise<VideoInfo> {
  try {
    return client === undefined
      ? await withTimeout(session.getInfo(videoId), OPERATION)
      : await withTimeout(session.getInfo(videoId, { client }), OPERATION);
  } catch (error) {
    mapInfoError(videoId, error);
  }
}

export function createInnertubePlaybackClient(
  options: InnertubeClientOptions = {},
): YouTubePlaybackClient {
  ensureJsEvaluator();
  const sessionFactory = options.sessionFactory ?? defaultSessionFactory;
  const inflight = new Map<string, Promise<PlaybackMediaInfo>>();

  async function fetchInfo(videoId: string): Promise<PlaybackMediaInfo> {
    let session: Innertube;
    try {
      session = await withTimeout(sessionFactory(), OPERATION);
    } catch (error) {
      mapInfoError(videoId, error);
    }

    // Primary: MWEB player context. Fallback: default context (previous
    // behavior) when MWEB yields zero usable candidates or fails
    // retryably. Genuinely unavailable videos throw non-retryably and
    // never fall back.
    let info: VideoInfo;
    try {
      info = await requestPlayerInfo(session, videoId, PRIMARY_PLAYER_CLIENT);
    } catch (error) {
      if (error instanceof ExtractorError && error.retryable === false) {
        throw error;
      }
      info = await requestPlayerInfo(session, videoId, undefined);
    }
    let media = await normalizeMediaInfo(session, info, videoId);
    if (media.formats.length === 0) {
      info = await requestPlayerInfo(session, videoId, undefined);
      media = await normalizeMediaInfo(session, info, videoId);
    }
    return media;
  }

  async function normalizeMediaInfo(
    session: Innertube,
    info: VideoInfo,
    videoId: string,
  ): Promise<PlaybackMediaInfo> {
    // Typed access, runtime-validated: library payloads are untrusted.
    const details = asRecord(info.basic_info);
    if (!details) {
      throw new ExtractorError(PROVIDER_ID, OPERATION, `Video unavailable: ${videoId}`);
    }

    const streaming = asRecord(info.streaming_data);
    // Both adaptive (usually audio-only) and regular (muxed) format lists
    // are candidates; format selection prefers audio-only and treats muxed
    // as a last resort. Either list may be absent per response.
    const adaptive = streaming && Array.isArray(streaming.adaptive_formats)
      ? streaming.adaptive_formats
      : [];
    const regular = streaming && Array.isArray(streaming.formats)
      ? streaming.formats
      : [];
    const rawFormats = [...adaptive, ...regular];
    const player = sessionPlayer(session);
    const formats: PlaybackFormatCandidate[] = [];
    for (const raw of rawFormats) {
      const base = toCandidate(raw as Format);
      if (!base) {
        continue;
      }
      // URLs from adaptive formats may require deciphering; formats that
      // cannot produce a usable URL are skipped, never surfaced.
      const url = await decipherUrl(raw as Format, player);
      if (url) {
        formats.push({ ...base, url });
      }
    }

    const expiresRaw = streaming?.expires;
    const expiresAt =
      expiresRaw instanceof Date && !Number.isNaN(expiresRaw.getTime())
        ? expiresRaw
        : undefined;

    const durationSeconds =
      typeof details.duration === "number" && Number.isFinite(details.duration) && details.duration > 0
        ? details.duration
        : undefined;

    const media: PlaybackMediaInfo = {
      videoId,
      formats,
    };
    const title = asNonEmptyString(details.title);
    if (title) {
      media.title = title;
    }
    if (durationSeconds !== undefined) {
      media.durationMs = Math.floor(durationSeconds * 1000);
    }
    media.isPrivate = asBoolean(details.is_private);
    media.isLiveContent = asBoolean(details.is_live_content);
    media.isUpcoming = asBoolean(details.is_upcoming);
    if (expiresAt) {
      media.expiresAt = expiresAt;
    }
    return media;
  }

  return {
    async getMediaInfo(videoId: string): Promise<PlaybackMediaInfo> {
      const pending = inflight.get(videoId);
      if (pending) {
        return pending;
      }
      const task = fetchInfo(videoId).finally(() => {
        if (inflight.get(videoId) === task) {
          inflight.delete(videoId);
        }
      });
      inflight.set(videoId, task);
      return task;
    },
  };
}
