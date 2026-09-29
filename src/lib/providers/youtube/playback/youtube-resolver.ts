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
import { probeFormatConsumability } from "./format-validation";
import type { FormatProbeReason, FormatProbeVerdict } from "./format-validation";
import type { PlaybackFormatCandidate, PlaybackMediaInfo, YouTubePlaybackClient } from "./types";
import { logger } from "@/lib/diagnostics/logger";

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
    for (const candidate of ranked) {
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
        return { candidate, aliveButRefused: false };
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
    logger.warn("Playback resolution found no usable audio format", {
      event: "playback_resolution_failed",
      candidateCount: ranked.length,
      validCount: 0,
      rejectedCount: rejections.length,
      topRejectionReasons: summarizeReasons(rejections),
      aliveButRefused,
    });
    return { candidate: null, aliveButRefused };
  }

  async function resolveVideoId(videoId: string): Promise<AudioSource> {
    if (!isYouTubeVideoId(videoId)) {
      fail(videoId, "resolve", `Invalid YouTube video id: "${videoId}"`);
    }

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

    const { candidate: format, aliveButRefused } = await pickPlayableFormat(
      info.formats,
    );
    if (!format) {
      // `aliveButRefused` is the only path that opts into a retry: the source
      // answered a bounded read, so the media exists and a later attempt can
      // succeed. Everything else (404, timeout, network error, an injected
      // validator) keeps the permanent default, because re-resolving the same
      // identity cannot change the answer.
      fail(videoId, "stream", "No playable audio format available", {
        retryable: aliveButRefused,
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
