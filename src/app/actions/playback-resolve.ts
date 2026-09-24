"use server";

import type { SerializedEngineError, SerializedAudioSource } from "@/lib/domain";
import { isSourceType, serializeAudioSource, serializeEngineError } from "@/lib/domain";
import { NormalizationError, PlaybackResolutionError } from "@/lib/domain";
import { logger } from "@/lib/diagnostics/logger";
import { idSchema, providerIdSchema } from "@/lib/validation/schemas";
import { isYouTubeVideoId } from "@/lib/providers/youtube/normalize";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";
import { createYouTubeResolver } from "@/lib/providers/youtube/playback/youtube-resolver";

export type ResolveAudioSourceResult =
  | { ok: true; source: SerializedAudioSource }
  | { ok: false; error: SerializedEngineError };

/**
 * Resolves an exact youtube source into a short-lived AudioSource payload
 * for the browser player. Only youtube is supported: Deezer/Spotify are
 * metadata-only and cross-source matching belongs to future orchestration.
 *
 * The returned URL is ephemeral (never persisted, never identity). The
 * browser receives the minimal serialized AudioSource — no youtubei.js
 * internals, sessions, cookies, or tokens cross this boundary.
 */
export async function resolveAudioSourceAction(
  provider: unknown,
  providerTrackId: unknown,
): Promise<ResolveAudioSourceResult> {
  const providerParsed = providerIdSchema.safeParse(provider);
  const trackParsed = idSchema.safeParse(providerTrackId);
  if (!providerParsed.success || !trackParsed.success) {
    return {
      ok: false,
      error: serializeEngineError(
        new NormalizationError("providerTrackId", "Invalid playback reference"),
      ),
    };
  }
  if (!isSourceType(providerParsed.data) || providerParsed.data !== "youtube") {
    return {
      ok: false,
      error: serializeEngineError(
        new PlaybackResolutionError(
          { provider: providerParsed.data, providerTrackId: trackParsed.data },
          "match",
          "Only YouTube sources can be resolved",
        ),
      ),
    };
  }
  if (!isYouTubeVideoId(trackParsed.data)) {
    return {
      ok: false,
      error: serializeEngineError(
        new NormalizationError("providerTrackId", "Invalid YouTube video id"),
      ),
    };
  }

  try {
    const resolver = createYouTubeResolver(createInnertubePlaybackClient());
    const source = await resolver.resolveSource({
      source: "youtube",
      id: trackParsed.data,
    });
    return { ok: true, source: serializeAudioSource(source) };
  } catch (error) {
    const serialized = serializeEngineError(error);
    // The sanitized result goes to the client; the structured failure
    // (code + retryability, never the URL) goes to server diagnostics.
    logger.error("Playback source resolution failed", {
      event: "playback_resolution_failed",
      provider: "youtube",
      operation: "innertube_resolve",
      videoId: trackParsed.data,
      errorCode: serialized.code,
      retryable: serialized.retryable,
    });
    return { ok: false, error: serialized };
  }
}
