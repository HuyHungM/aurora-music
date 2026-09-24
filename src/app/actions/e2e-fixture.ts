"use server";

import type { Track } from "@/lib/domain";
import { isYouTubeVideoId } from "@/lib/providers/youtube/normalize";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";

export type E2EPlaybackFixtureResult =
  | { ok: true; track: Track }
  | { ok: false; reason: "disabled" | "invalid-id" | "unavailable" };

/**
 * Live-E2E fixture loader (Phase 17). Available ONLY when
 * AURORA_E2E_LIVE_PLAYBACK=1; otherwise reports disabled (callers 404).
 *
 * Returns a real catalog-style Track for a YouTube id using the production
 * metadata path — no stored URLs, no secrets, no fakes. A valid-format id
 * whose lookup fails still yields a minimal track so the PLAYER (not the
 * page) deterministically hits the resolution error path.
 */
export async function getE2EPlaybackFixtureAction(
  videoId: unknown,
): Promise<E2EPlaybackFixtureResult> {
  if (process.env.AURORA_E2E_LIVE_PLAYBACK !== "1") {
    return { ok: false, reason: "disabled" };
  }
  if (typeof videoId !== "string") {
    return { ok: false, reason: "invalid-id" };
  }
  const decodedId = decodeURIComponent(videoId);
  if (!isYouTubeVideoId(decodedId)) {
    return { ok: false, reason: "invalid-id" };
  }
  try {
    const info =
      await createInnertubePlaybackClient().getMediaInfo(decodedId);
    return {
      ok: true,
      track: {
        id: decodedId,
        provider: "youtube",
        providerTrackId: decodedId,
        title: info.title ?? `E2E ${decodedId}`,
        artistId: "e2e-fixture",
        artistName: "E2E fixture",
        ...(info.durationMs !== undefined
          ? { duration: Math.round(info.durationMs / 1000) }
          : {}),
      },
    };
  } catch {
    return {
      ok: true,
      track: {
        id: decodedId,
        provider: "youtube",
        providerTrackId: decodedId,
        title: `E2E ${decodedId}`,
        artistId: "e2e-fixture",
        artistName: "E2E fixture",
      },
    };
  }
}
