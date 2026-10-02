/**
 * YouTube media resolver: exact `youtube + videoId` -> ephemeral AudioSource.
 *
 * Handles ONLY youtube sources. No matching, no search, no substitution:
 * given `youtube:VIDEO_ID` it resolves exactly VIDEO_ID or fails with a
 * staged `PlaybackResolutionError`. Never mutates identities, never
 * persists anything, never touches the player.
 *
 * Stages: `match` is unused here by construction (callers supply an exact
 * source; "no playable source" belongs to the PlaybackResolver layer).
 * `resolve` = media information could not be obtained or the video is not
 * playable under policy. `stream` = formats exist but yield no usable URL
 * (or the only URLs are already expired).
 *
 * Live/upcoming policy: rejected. Queue playback expects finite-duration
 * on-demand tracks; seek/restore and expiry reasoning require it.
 */

import type { AudioSource } from "@/lib/domain";
import { isAudioSourceExpired } from "@/lib/domain";
import { ExtractorError, PlaybackResolutionError } from "@/lib/domain";
import type { SourceReference } from "@/lib/domain";
import type { TrackIdentity } from "@/lib/domain";
import { isYouTubeVideoId } from "../normalize";
import { rankAudioFormats } from "./format-selection";
import { probeFormatConsumability, TRANSIENT_PROBE_REASONS } from "./format-validation";
import type { FormatProbeReason, FormatProbeVerdict } from "./format-validation";

/**
 * Wall-clock ceiling for the whole ranked-candidate walk.
 *
 * `FORMAT_VALIDATE_TIMEOUT_MS` bounds ONE probe, and a rejected 403/416 costs
 * two of them, so the ladder was bounded only per candidate. With the
 * documented seven-candidate videos that is ~70s inside one server action.
 *
 * Sized so the best-ranked candidate is never cut off even on a slow edge (one
 * probe is 5s, two is 10s, and the realistic successful path is a single
 * candidate), while capping the pathological tail. The budget only decides
 * what a FAILURE looks like: it can turn a total failure into a slightly
 * earlier total failure, never a success into a failure.
 */
const FORMAT_LADDER_BUDGET_MS = 20_000;
import type { PlaybackFormatCandidate, PlaybackMediaInfo, YouTubePlaybackClient } from "./types";
import { logger } from "@/lib/diagnostics/logger";
import {
  PlaybackResolutionCache,
  resolutionCacheKey,
  sharedResolutionCache,
} from "./resolution-cache";

function trackRef(videoId: string): { provider: string; providerTrackId: string } {
  return { provider: "youtube", providerTrackId: videoId };
}

function fail(
  videoId: string,
  stage: "resolve" | "stream",
  message: string,
  options?: { retryable?: boolean; cause?: unknown },
): never {
  throw new PlaybackResolutionError(trackRef(videoId), stage, message, options);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export interface YouTubeResolver {
  /** The source type this resolver handles. Always "youtube". */
  readonly source: "youtube";
  /** Resolves an exact youtube source reference. */
  resolveSource(ref: SourceReference): Promise<AudioSource>;
  /** Resolves the youtube source carried by an identity (exact id). */
  resolveIdentity(identity: TrackIdentity): Promise<AudioSource>;
}

export interface YouTubeResolverOptions {
  /**
   * Optional format validator (tests inject synchronous/mock probes). An
   * injected validator answers yes/no and carries no reason of its own, so its
   * verdict is recorded as `validator_injected` — the real probe is what
   * produces a diagnosable reason in production.
   *
   * A full {@link FormatProbeVerdict} may be returned instead, which is the
   * only way to exercise the paths that depend on the probe's own
   * observations — notably `boundedRangeOk`, the evidence that separates
   * "this URL is dead" from "this CDN declined the read right now", and with
   * it the retry classification in `pickPlayableFormat`. Production never
   * injects; only the real probe runs there.
   */
  validateFormat?: (url: string) => Promise<boolean | FormatProbeVerdict>;
  /**
   * Short-TTL resolution cache. Defaults to the process-local shared instance;
   * pass `null` to disable (latency baselines, tests measuring cold cost).
   * A test-owned instance with an injected clock gives deterministic expiry.
   */
  cache?: PlaybackResolutionCache | null;
  /** Injected clock for latency measurement; defaults to Date.now. */
  now?: () => number;
}

/**
 * Full-resolution singleflight, keyed by the same normalized key as the
 * cache. Concurrent resolutions of one video share ONE upstream chain
 * (InnerTube + sequential probes) instead of each spending it: the first
 * caller starts the work, every concurrent caller awaits the same promise,
 * and the entry is deleted on settle — success or failure — so a stale or
 * rejected promise can never be awaited twice. Module scope, because a new
 * resolver is constructed per server action call: an instance field would
 * dedupe nothing across requests.
 */
const inflightResolutions = new Map<string, Promise<AudioSource>>();

/** How many callers shared an in-flight resolution instead of starting one. */
let dedupeSharedCount = 0;

/** Test and diagnostics read of the singleflight share counter. */
export function getResolverDedupeSharedCount(): number {
  return dedupeSharedCount;
}

/** Test reset for the singleflight share counter. */
export function resetResolverDedupeSharedCount(): void {
  dedupeSharedCount = 0;
}

/** One rejected candidate, as counted into the all-failed summary. */
interface Rejection {
  reason: FormatProbeReason;
  /**
   * The probe's bounded confirmation read succeeded, so the URL is ALIVE and
   * was only refused the open-ended read. Only the real probe produces this;
   * an injected validator never does, which is what keeps a test double from
   * being able to claim a source is recoverable.
   */
  alive: boolean;
}

/** What `pickPlayableFormat` concluded about a candidate set. */
interface FormatPick {
  /** The winning candidate, or null when none was consumable. */
  candidate: PlaybackFormatCandidate | null;
  /**
   * Every candidate was refused AND at least one was demonstrably alive, i.e.
   * the media exists and the CDN declined the browser's whole-body read. See
   * `pickPlayableFormat` for why that is a transient verdict rather than a
   * permanent one.
   */
  aliveButRefused: boolean;
  /**
   * Every candidate was refused for a reason that says nothing about whether
   * the media exists — rate limiting, a provider fault, a timeout. `every`,
   * not `some`: one 404 among them means the media is gone and that verdict
   * must stay permanent.
   */
  transientRejection: boolean;
}

/**
 * Compact `reason=count` rendering for the summary field. `LogFieldValue` is
 * primitive-only by design, so the counts are formatted rather than nested —
 * and ordered by count then reason so the same failure set always renders the
 * same way.
 */
function summarizeReasons(rejections: Rejection[]): string {
  const counts = new Map<FormatProbeReason, number>();
  for (const { reason } of rejections) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
}

export function createYouTubeResolver(
  client: YouTubePlaybackClient,
  options: YouTubeResolverOptions = {},
): YouTubeResolver {
  const injected = options.validateFormat;
  const cache = options.cache === null ? null : (options.cache ?? sharedResolutionCache());
  const now = options.now ?? Date.now;

  async function verifyFormat(url: string): Promise<FormatProbeVerdict> {
    if (!injected) {
      // Direct egress, deliberately: the googlevideo CDN is reachable from the
      // function and is fetched by the user's browser directly, so only the
      // anti-bot-challenged InnerTube API is proxied (see
      // ../innertube/egress.ts).
      return await probeFormatConsumability(url);
    }
    try {
      const answer = await injected(url);
      if (typeof answer === "boolean") {
        return answer
          ? { consumable: true, reason: "validator_injected" }
          : { consumable: false, reason: "validator_injected" };
      }
      return answer;
    } catch {
      // A broken probe is not evidence about the format; the next candidate is
      // still worth trying. Recording the reason keeps this path as visible as
      // the real one instead of being a silent black hole.
      return { consumable: false, reason: "validator_injected" };
    }
  }

  /**
   * Ranks and probes candidates in order, returning the first consumable one.
   *
   * The `aliveButRefused` flag exists because "no format was consumable" is
   * two different failures wearing the same message. A dead or unreadable
   * source (404, a timeout, a signed URL that has expired) cannot be helped by
   * asking again, so it stays permanent. A source whose every URL answered the
   * bounded read but refused the open-ended one is a different animal: the
   * media is there, and the refusal is a property of the CDN's read policy at
   * that moment rather than of the URL. Measured on 2026-09-27, an 8-minute
   * burst of live-playback tests drove every candidate of one video to
   * `probe_status_403` - all seven, including the progressive format - and an
   * isolated probe of the same video seconds later returned 206 on all seven.
   * Classifying that permanently was why a throttle window left every
   * subsequent track unplayable until the user pressed play again by hand:
   * `classifyFailure` reads `retryable` and had been told "no".
   */
  async function pickPlayableFormat(
    candidates: PlaybackFormatCandidate[],
  ): Promise<FormatPick> {
    const ranked = rankAudioFormats(candidates);
    const rejections: Rejection[] = [];
    // An aggregate budget, because the per-probe timeout alone does not bound
    // the walk: each candidate can cost a whole-body probe plus a bounded
    // confirmation (2 x FORMAT_VALIDATE_TIMEOUT_MS) and the ladder is
    // unbounded, so a video with seven formats could spend ~70s of a server
    // action's wall clock before reporting failure. The budget is generous
    // enough that the best-ranked candidate - the overwhelmingly common
    // success - is never cut off; it only stops a pathological tail.
    const budgetEndsAt = Date.now() + FORMAT_LADDER_BUDGET_MS;
    for (const candidate of ranked) {
      if (Date.now() >= budgetEndsAt) {
        logger.warn("Playback format ladder hit its probe budget", {
          event: "playback_format_budget_exhausted",
          candidateCount: ranked.length,
          rejectedCount: rejections.length,
          budgetMs: FORMAT_LADDER_BUDGET_MS,
        });
        break;
      }
      const verdict = await verifyFormat(candidate.url);
      if (verdict.consumable) {
        if (rejections.length > 0) {
          logger.debug("Playback format fell through to a later candidate", {
            event: "playback_format_fallback",
            rejectedCount: rejections.length,
            selectedItag: candidate.itag ?? null,
            selectedHasVideo: candidate.hasVideo,
          });
        }
        return { candidate, aliveButRefused: false, transientRejection: false };
      }
      rejections.push({
        reason: verdict.reason,
        alive: verdict.boundedRangeOk === true,
      });
      // Never the URL: it is a signed, expiring googlevideo link. `itag` and the
      // probe's own observations identify the candidate precisely instead.
      logger.debug("Playback format skipped", {
        event: "playback_format_skipped",
        itag: candidate.itag ?? null,
        mimeType: candidate.mimeType ?? null,
        bitrate: candidate.bitrate ?? null,
        hasVideo: candidate.hasVideo,
        reason: verdict.reason,
        status: verdict.status ?? null,
        contentType: verdict.contentType ?? null,
        boundedRangeOk: verdict.boundedRangeOk ?? null,
      });
    }
    // A total failure is the case that needs the most context and had the
    // least: one summary so the cause is a count of reasons, not four
    // context-free skip lines.
    const aliveButRefused =
      rejections.length > 0 && rejections.every((r) => r.alive);
    // `every` (not `some`): one 404 among refused candidates means the media is
    // genuinely gone, and that must stay permanent.
    const transientRejection =
      rejections.length > 0 &&
      rejections.every((r) => TRANSIENT_PROBE_REASONS.has(r.reason));
    logger.warn("Playback resolution found no usable audio format", {
      event: "playback_resolution_failed",
      candidateCount: ranked.length,
      validCount: 0,
      rejectedCount: rejections.length,
      topRejectionReasons: summarizeReasons(rejections),
      aliveButRefused,
      transientRejection,
    });
    return { candidate: null, aliveButRefused, transientRejection };
  }

  /**
   * Uncached resolution: InnerTube + policy + ranked probes. Never called
   * directly — always through `resolveVideoId`, which layers the negative
   * cooldown, the cache, and the singleflight map on top.
   */
  async function resolveFresh(videoId: string): Promise<AudioSource> {

    let info: PlaybackMediaInfo;
    try {
      info = await client.getMediaInfo(videoId);
    } catch (error) {
      if (error instanceof PlaybackResolutionError) {
        throw error;
      }
      const retryable = error instanceof ExtractorError ? error.retryable : true;
      fail(videoId, "resolve", "YouTube playback info failed", {
        retryable,
        cause: error,
      });
    }

    if (info.videoId !== videoId) {
      // Exact-ID guarantee: a mismatched response is a failure, not a fallback.
      fail(videoId, "resolve", "YouTube returned another video");
    }
    if (info.isPrivate) {
      fail(videoId, "resolve", "Video is private");
    }
    if (info.isUpcoming) {
      fail(videoId, "resolve", "Upcoming videos cannot be resolved");
    }
    if (info.isLiveContent) {
      fail(videoId, "resolve", "Live streams are not supported");
    }

    // Zero formats is not the same failure as "every format was rejected", and it
    // is not a video that lacks media: it is what a challenged datacenter
    // egress produces — a SUCCESSFUL player response carrying no streaming
    // data. Nothing was rejected, so every downstream reason summary is empty,
    // which made this indistinguishable from a genuinely empty format list.
    const noCandidates = info.formats.length === 0;
    const { candidate: format, aliveButRefused, transientRejection } =
      await pickPlayableFormat(info.formats);
    if (!format) {
      // Retry is opted into by evidence that the failure was not "this video
      // has no media":
      //
      // - `aliveButRefused` — the source answered a bounded read, so the media
      //   exists and a later attempt can succeed.
      // - `transientRejection` — the CDN rate-limited us or faulted. Neither
      //   says anything about whether the media exists, so treating them as
      //   permanent turned a blip into a negative-cached permanent failure.
      // - `noCandidates` — zero formats were even EXAMINED, which is what a
      //   challenged datacenter egress produces (a successful player response
      //   with no streaming data). Nothing was rejected, so "rejected" is the
      //   wrong summary and permanent is the wrong verdict.
      //
      // 404 keeps the permanent default: the media is genuinely gone.
      fail(videoId, "stream", "No playable audio format available", {
        retryable: aliveButRefused || transientRejection || noCandidates,
      });
    }

    const source: AudioSource = { url: format.url };
    if (format.mimeType) {
      source.mimeType = format.mimeType;
    }
    if (typeof format.bitrate === "number" && Number.isFinite(format.bitrate) && format.bitrate > 0) {
      source.bitrate = Math.floor(format.bitrate);
    }
    const durationMs =
      typeof info.durationMs === "number" && Number.isFinite(info.durationMs) && info.durationMs > 0
        ? Math.floor(info.durationMs)
        : undefined;
    if (durationMs !== undefined) {
      source.durationMs = durationMs;
    } else if (
      typeof format.durationMs === "number" &&
      Number.isFinite(format.durationMs) &&
      format.durationMs > 0
    ) {
      source.durationMs = Math.floor(format.durationMs);
    }
    if (isValidDate(info.expiresAt)) {
      source.expiresAt = info.expiresAt;
    }
    // Expired URLs must never be handed out as fresh playback sources.
    // Re-resolution (a fresh call) is the recovery path, not reuse.
    if (isAudioSourceExpired(source)) {
      fail(videoId, "stream", "Resolved source is already expired", { retryable: false });
    }
    return source;
  }

  /**
   * Records a hard failure for the negative-cooldown window. Retryable
   * failures are never recorded: the next attempt may succeed, and a cached
   * "try again" would be a lie told at exactly the moment retry matters.
   */
  function recordNegative(videoId: string, error: unknown): void {
    if (!cache) {
      return;
    }
    if (error instanceof PlaybackResolutionError && error.retryable === false) {
      cache.setNegative(videoId, {
        stage: error.stage,
        message: error.message,
        retryable: false,
      });
    }
  }

  /**
   * One upstream resolution per video no matter how many callers arrive
   * together. The first caller starts `resolveFresh`; concurrent callers
   * await the same promise and are counted in `dedupeSharedCount`. The map
   * entry is deleted on settle — success or failure — so a rejected promise
   * is never awaited twice and a later request always starts fresh work.
   */
  function resolveShared(videoId: string, startedAt: number): Promise<AudioSource> {
    const key = resolutionCacheKey(videoId);
    const existing = inflightResolutions.get(key);
    if (existing) {
      dedupeSharedCount += 1;
      logger.debug("Playback resolution shared an in-flight request", {
        event: "playback_resolution_shared",
        videoId,
      });
      return existing;
    }
    // Captured BEFORE the work starts. If the client reports this URL dead while
    // the resolution is still running, `invalidate()` bumps the epoch, and the
    // write below is skipped: otherwise the in-flight resolution re-inserts
    // the very URL that was just reported unplayable, and the invalidation
    // silently does nothing. The SOURCE is still returned - the caller that
    // asked for it gets what it asked for - only the cache write is dropped.
    const startedEpoch = cache ? cache.epochOf(videoId) : 0;
    const promise = resolveFresh(videoId).then(
      (source) => {
        if (cache) {
          if (cache.epochOf(videoId) === startedEpoch) {
            cache.set(videoId, source);
          } else {
            logger.debug("Playback resolution completed after invalidation", {
              event: "playback_resolution_invalidated_inflight",
              videoId,
            });
          }
        }
        logger.debug("Playback resolved without cache", {
          event: "playback_resolution_latency",
          videoId,
          cacheHit: false,
          stale: false,
          latencyMs: now() - startedAt,
        });
        return source;
      },
      (error: unknown) => {
        recordNegative(videoId, error);
        throw error;
      },
    );
    inflightResolutions.set(key, promise);
    const release = () => {
      if (inflightResolutions.get(key) === promise) {
        inflightResolutions.delete(key);
      }
    };
    // Rejection is handled by the callers and by the branch above; this
    // handler exists only to clear the entry and to keep a shared rejection
    // from surfacing as an unhandled rejection.
    promise.then(release, release);
    return promise;
  }

  async function resolveVideoId(videoId: string): Promise<AudioSource> {
    if (!isYouTubeVideoId(videoId)) {
      fail(videoId, "resolve", `Invalid YouTube video id: "${videoId}"`);
    }
    // Cache disabled (baselines, callers that manage their own): straight
    // through to uncached resolution, still singleflighted.
    if (!cache) {
      return resolveShared(videoId, now());
    }
    const startedAt = now();
    const negative = cache.getNegative(videoId);
    if (negative) {
      logger.debug("Playback resolution refused by negative cooldown", {
        event: "playback_resolution_negative_hit",
        videoId,
      });
      throw new PlaybackResolutionError(
        trackRef(videoId),
        negative.stage,
        negative.message,
        { retryable: false },
      );
    }
    const fresh = cache.getFresh(videoId);
    if (fresh) {
      logger.debug("Playback resolution cache hit", {
        event: "playback_resolution_latency",
        videoId,
        cacheHit: true,
        stale: false,
        latencyMs: now() - startedAt,
      });
      return fresh;
    }
    const stale = cache.getStale(videoId);
    if (stale) {
      // Serve now, refresh behind: the URL is verified live (the stale path
      // never serves a dead URL), and the refresh joins the singleflight map
      // so a concurrent real request and this background one still total one
      // upstream chain. Its rejection is swallowed — the caller already has a
      // usable source, and the failure is recorded for the next lookup.
      logger.debug("Playback resolution served stale", {
        event: "playback_resolution_latency",
        videoId,
        cacheHit: true,
        stale: true,
        latencyMs: now() - startedAt,
      });
      void resolveShared(videoId, now()).catch(() => {});
      return stale;
    }
    return resolveShared(videoId, startedAt);
  }

  return {
    source: "youtube",

    async resolveSource(ref: SourceReference): Promise<AudioSource> {
      if (ref.source !== "youtube") {
        fail(
          typeof ref.id === "string" ? ref.id : "",
          "resolve",
          `YouTube resolver cannot handle source "${ref.source}"`,
        );
      }
      return resolveVideoId(ref.id);
    },

    async resolveIdentity(identity: TrackIdentity): Promise<AudioSource> {
      const reference = identity.sources.find((source) => source.source === "youtube");
      if (!reference) {
        fail("", "resolve", "Identity carries no YouTube source");
      }
      return resolveVideoId(reference.id);
    },
  };
}
