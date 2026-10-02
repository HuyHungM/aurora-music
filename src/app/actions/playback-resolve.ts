"use server";

import type { SerializedEngineError, SerializedAudioSource } from "@/lib/domain";
import { isSourceType, serializeAudioSource, serializeEngineError } from "@/lib/domain";
import { NormalizationError, PlaybackResolutionError } from "@/lib/domain";
import { logger } from "@/lib/diagnostics/logger";
import { idSchema, providerIdSchema } from "@/lib/validation/schemas";
import { isYouTubeVideoId } from "@/lib/providers/youtube/normalize";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";
import { createYouTubeResolver } from "@/lib/providers/youtube/playback/youtube-resolver";
import { sharedResolutionCache } from "@/lib/providers/youtube/playback/resolution-cache";
import { guardServerAction, type GuardFailureMeta } from "@/lib/api/action-guard";

export type ResolveAudioSourceResult =
  | { ok: true; source: SerializedAudioSource }
  // `error` here is a SerializedEngineError, not a string, so the guard's
  // string field is omitted rather than intersected.
  | { ok: false; error: SerializedEngineError } & GuardFailureMeta;

/**
 * Resolving a source is the most expensive single call in the product: it runs
 * the Innertube client and returns a signed, short-lived media URL. It is also
 * reachable anonymously, so it is budgeted (RULE 12).
 *
 * 120/minute is the loosest budget here because the legitimate rate is real: a
 * listener skipping through a queue resolves once per track, and resolving the
 * next few tracks eagerly is a normal implementation. The point of the budget
 * is to stop an unattended loop, not to slow down a person.
 */
const RESOLVE_OFF_MESSAGE = "Playback is temporarily unavailable right now.";

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
  // Charged before any provider work, and before validation: the cost this
  // protects is the outbound request, so the budget must not depend on whether
  // the arguments happen to be well-formed.
  const denied = await guardServerAction({
    featureOffMessage: RESOLVE_OFF_MESSAGE,
    bucket: "playbackResolve",
  });
  if (denied) {
    return {
      ok: false,
      error: serializeEngineError(
        new PlaybackResolutionError(
          // The real track id is not read before the guard on purpose: a
          // rejected caller should not be able to use this path to probe
          // arguments. The stage is "resolve" and the error is retryable,
          // because a budget denial is transient by construction.
          { provider: "youtube", providerTrackId: "" },
          "resolve",
          denied.error,
          { retryable: denied.code === "RATE_LIMITED" },
        ),
      ),
      code: denied.code,
      requestId: denied.requestId,
      ...(denied.retryAfterMs !== undefined ? { retryAfterMs: denied.retryAfterMs } : {}),
    };
  }
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

/**
 * Drops one video from the resolution cache. Called by the player when a
 * recovery cycle exhausts on a dead URL: the cached entry almost certainly
 * holds that same signed URL, and without invalidation the next attempt
 * would replay the cached poison instead of re-resolving.
 *
 * Best-effort by construction — the cache is process-local, so on a cold
 * function instance there is nothing to drop — and always reported `ok`:
 * a caller that cannot reach the entry holding the poison is in exactly the
 * same position as one that just cleared it. Charged against the resolve
 * budget like any other playback RPC so it cannot become a free loop target,
 * and validated exactly like a resolve so malformed ids never reach the
 * cache keys.
 */
export async function invalidatePlaybackResolutionAction(
  provider: unknown,
  providerTrackId: unknown,
): Promise<{ ok: true }> {
  const denied = await guardServerAction({
    featureOffMessage: RESOLVE_OFF_MESSAGE,
    bucket: "playbackResolve",
  });
  if (denied) {
    return { ok: true };
  }
  const providerParsed = providerIdSchema.safeParse(provider);
  const trackParsed = idSchema.safeParse(providerTrackId);
  if (
    !providerParsed.success ||
    !trackParsed.success ||
    providerParsed.data !== "youtube" ||
    !isYouTubeVideoId(trackParsed.data)
  ) {
    return { ok: true };
  }
  const dropped = sharedResolutionCache().invalidate(trackParsed.data);
  logger.debug("Playback resolution cache invalidated", {
    event: "playback_resolution_invalidated",
    provider: "youtube",
    videoId: trackParsed.data,
    hadEntry: dropped,
  });
  return { ok: true };
}
