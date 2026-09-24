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
import { isFormatConsumable } from "./format-validation";
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
  /** Optional format validator (tests inject synchronous/mock probes). */
  validateFormat?: (url: string) => Promise<boolean>;
}

export function createYouTubeResolver(
  client: YouTubePlaybackClient,
  options: YouTubeResolverOptions = {},
): YouTubeResolver {
  const validate = options.validateFormat ?? isFormatConsumable;

  async function pickPlayableFormat(
    candidates: PlaybackFormatCandidate[],
  ): Promise<PlaybackFormatCandidate | null> {
    const ranked = rankAudioFormats(candidates);
    for (const candidate of ranked) {
      let ok = false;
      try {
        ok = await validate(candidate.url);
      } catch {
        // A broken probe is not evidence about the format; the next
        // candidate is still worth trying.
        ok = false;
      }
      if (ok) {
        return candidate;
      }
      logger.debug("Playback format skipped", {
        event: "playback_format_skipped",
        mimeType: candidate.mimeType ?? null,
        bitrate: candidate.bitrate ?? null,
        hasVideo: candidate.hasVideo,
      });
    }
    return null;
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

    const format = await pickPlayableFormat(info.formats);
    if (!format) {
      fail(videoId, "stream", "No playable audio format available");
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
