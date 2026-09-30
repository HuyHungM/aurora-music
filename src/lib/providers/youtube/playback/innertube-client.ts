/**
 * Real `YouTubePlaybackClient` over youtubei.js (pinned 18.0.0).
 *
 * SERVER-ONLY. One of the two modules allowed to import youtubei.js; the other
 * is `innertube/transport.ts` (discovery). Everything this file produces is
 * normalized into `PlaybackMediaInfo` before it leaves. Anonymous, stateless
 * operation: no login, no cookies persisted, no user data.
 *
 * THE SESSION IS NOT THIS FILE'S (Phase 55). It used to be. When InnerTube
 * discovery was added, keeping a second `Innertube.create()` here would have
 * meant two sessions per process, so the session moved to
 * `innertube/session.ts` and BOTH halves import it. There is exactly one
 * `Innertube.create()` call in the repository.
 *
 * RESULTS ARE NEVER CACHED, and that is load-bearing rather than an omission.
 * A resolved `googlevideo` URL is signed and expires in hours, so caching one
 * means eventually serving a dead stream to a user who sees a track that will
 * not play (§56). `createInnerTubePlaybackClient` keeps its own in-flight map
 * so simultaneous resolutions of the SAME video share one request — that is
 * deduplication, not caching, and the entry is gone the moment the request
 * settles.
 *
 * Library objects are treated as untrusted input: every consumed field is
 * validated before use, so library upgrades fail closed into typed errors.
 */

import type { Innertube, Types } from "youtubei.js";
import { ExtractorError } from "@/lib/domain";
import { logger } from "@/lib/diagnostics/logger";
import type {
  PlaybackFormatCandidate,
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "./types";
import {
  asNonEmptyString,
  asRecord,
  decipherFormatUrl,
  ensureJsEvaluator,
  sessionPlayer,
  sharedInnertubeSession,
  toFormatCandidate,
} from "../innertube/session";
import type { SessionFactory } from "../innertube/session";
import type { Format, VideoInfo } from "../innertube/session";

const PROVIDER_ID = "youtube";
const OPERATION = "getMediaInfo";
const RESOLVE_TIMEOUT_MS = 15_000;

type PlayerRequestClient = Types.InnerTubeClient;

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

function mapInfoError(videoId: string, error: unknown): never {
  if (error instanceof ExtractorError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : "";
  if (/unavailable|deleted|not found|private|unplayable|login required/i.test(message)) {
    // Preserve the cause for the temporary egress-failover classifier. The
    // public message stays a stable unavailable verdict, while the cause lets
    // failover distinguish a LOGIN_REQUIRED anti-bot response from a
    // genuinely unavailable video without logging provider text.
    throw new ExtractorError(PROVIDER_ID, OPERATION, `Video unavailable: ${videoId}`, {
      cause: error,
    });
  }
  throw new ExtractorError(
    PROVIDER_ID,
    OPERATION,
    "YouTube playback info failed",
    { retryable: true, cause: error },
  );
}

export interface InnertubeClientOptions {
  /**
   * Overrides the shared session. Tests inject a fake; production does not,
   * because one session per process is the point (see the file header).
   */
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

/**
 * Explicit fallback player-request context.
 *
 * The session default (WEB) is NOT a viable fallback: measured on the same
 * videos, its adaptive formats carry neither a direct URL nor a cipher, so
 * `toFormatCandidate` rejects every one and extraction yields zero candidates
 * (exactly the production `candidateCount: 0`). `undefined` must therefore
 * never be passed as a client — that silently reverts to WEB.
 *
 * `IOS` was verified to materialize usable (decipherable) audio formats for
 * every video in the regression set (yuuWdm5tBD0, dQw4w9WgXcQ, jNQXAC9IVRw,
 * kJQP7kiw5Fk, 9bZkp7q19f0, JGwWNGJdvx8, OPf0YbXqDm0, fJ9rUzIMcZQ). It is a
 * single, deterministic fallback, not a client sweep.
 */
const FALLBACK_PLAYER_CLIENT: PlayerRequestClient = "IOS";

async function requestPlayerInfo(
  session: Innertube,
  videoId: string,
  client: PlayerRequestClient,
): Promise<VideoInfo> {
  try {
    return await withTimeout(session.getInfo(videoId, { client }), OPERATION);
  } catch (error) {
    mapInfoError(videoId, error);
  }
}

export function createInnertubePlaybackClient(
  options: InnertubeClientOptions = {},
): YouTubePlaybackClient {
  ensureJsEvaluator();
  const sessionFactory = options.sessionFactory ?? sharedInnertubeSession;
  const inflight = new Map<string, Promise<PlaybackMediaInfo>>();

  async function attempt(
    session: Innertube,
    videoId: string,
    client: PlayerRequestClient,
  ): Promise<PlaybackMediaInfo> {
    const info = await requestPlayerInfo(session, videoId, client);
    return normalizeMediaInfo(session, info, videoId, client);
  }

  async function fetchInfo(videoId: string): Promise<PlaybackMediaInfo> {
    let session: Innertube;
    try {
      session = await withTimeout(sessionFactory(), OPERATION);
    } catch (error) {
      mapInfoError(videoId, error);
    }

    // Primary MWEB, then ONE explicit verified fallback (IOS). The session
    // default (WEB) is never used: it yields zero usable formats, and passing
    // `undefined` as a client would silently select it. If MWEB answers but
    // materialized no usable candidate, the explicit fallback is tried once.
    // Genuinely unavailable videos throw non-retryably and never fall back.
    let attemptedFallback = false;
    let media: PlaybackMediaInfo;
    try {
      media = await attempt(session, videoId, PRIMARY_PLAYER_CLIENT);
    } catch (error) {
      if (error instanceof ExtractorError && error.retryable === false) {
        throw error;
      }
      attemptedFallback = true;
      media = await attempt(session, videoId, FALLBACK_PLAYER_CLIENT);
    }
    if (media.formats.length === 0 && !attemptedFallback) {
      media = await attempt(session, videoId, FALLBACK_PLAYER_CLIENT);
    }
    return media;
  }

  async function normalizeMediaInfo(
    session: Innertube,
    info: VideoInfo,
    videoId: string,
    client: PlayerRequestClient,
  ): Promise<PlaybackMediaInfo> {
    // Typed access, runtime-validated: library payloads are untrusted.
    const details = asRecord(info.basic_info);
    if (!details) {
      throw new ExtractorError(PROVIDER_ID, OPERATION, `Video unavailable: ${videoId}`);
    }

    // Playability is the OUTER verdict YouTube puts on the player response. When
    // it is not OK, there is usually no `streaming_data` at all — which is how a
    // datacenter egress that YouTube challenges (LOGIN_REQUIRED, "Sign in to
    // confirm you're not a bot") reaches us: a valid player response with zero
    // formats, not a network or decipher failure. Both values are short,
    // provider-controlled strings (not a request echo), so recording them is what
    // turns "empty extraction" into an actionable diagnosis.
    const playability = asRecord((info as { playability_status?: unknown }).playability_status);
    const playabilityStatus = asNonEmptyString(playability?.status);
    const playabilityReason = asNonEmptyString(playability?.reason);

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
    // Extraction diagnostics: these are the values that make an empty
    // candidate set explainable instead of a bare zero.
    let formatsSeen = 0;
    let formatsWithPlayablePayload = 0;
    let decipherAttempts = 0;
    let decipherSuccesses = 0;
    let decipherFailures = 0;
    for (let index = 0; index < rawFormats.length; index++) {
      const raw = rawFormats[index];
      formatsSeen++;
      const base = toFormatCandidate(raw as Format);
      if (!base) {
        continue;
      }
      formatsWithPlayablePayload++;
      const { directUrlPresent, cipherPresent, ...candidateFields } = base;
      // URLs from adaptive formats may require deciphering; formats that
      // cannot produce a usable URL are skipped, never surfaced. A failure is
      // recorded (reason/class/message) rather than swallowed into nothing.
      const outcome = await decipherFormatUrl(raw as Format, player);
      decipherAttempts++;
      if (outcome.url) {
        decipherSuccesses++;
        formats.push({ ...candidateFields, url: outcome.url });
      } else {
        decipherFailures++;
        logger.debug("Playback format decipher failed", {
          event: "playback_decipher_failed",
          videoId,
          client,
          formatIndex: index,
          mimeType: candidateFields.mimeType ?? null,
          itag: candidateFields.itag ?? null,
          directUrlPresent,
          cipherPresent,
          reason: outcome.failure?.reason ?? null,
          errorName: outcome.failure?.errorName ?? null,
          errorMessage: outcome.failure?.errorMessage ?? null,
        });
      }
    }
    if (formats.length === 0) {
      logger.warn("Playback extraction produced no usable format", {
        event: "playback_extraction_empty",
        videoId,
        client,
        formatsSeen,
        formatsWithPlayablePayload,
        decipherAttempts,
        decipherSuccesses,
        decipherFailures,
        // WHY it was empty, not just that it was. A present player response with
        // `hasStreamingData: false` and a challenge `playabilityStatus` is an
        // egress/anti-bot condition; `hasStreamingData: true` with formatsSeen 0
        // would instead point at a parser/shape regression. `playabilityReason`
        // is provider copy (URL-redacted by the logger), truncated defensively.
        hasStreamingData: streaming !== null,
        ...(playabilityStatus ? { playabilityStatus } : {}),
        ...(playabilityReason ? { playabilityReason: playabilityReason.slice(0, 120) } : {}),
      });
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
    media.isPrivate = details.is_private === true;
    media.isLiveContent = details.is_live_content === true;
    media.isUpcoming = details.is_upcoming === true;
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

/**
 * Re-exported for compatibility.
 *
 * These three helpers now LIVE in `innertube/session.ts` (Phase 55), because
 * the session and its evaluator are properties of the shared session rather
 * than of the playback half. They are re-exported here so the playback
 * module's public surface is unchanged: the existing tests, and any caller
 * that imported them, keep working without knowing the session moved.
 */
export {
  ensureJsEvaluator,
  evaluatePlayerScript,
  sessionPlayer,
  sharedInnertubeSession as innertubeSession,
} from "../innertube/session";
