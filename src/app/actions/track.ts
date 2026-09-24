"use server";

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import { likeTrack, unlikeTrack, isTrackLiked } from "@/lib/dal/like";
import type { Track } from "@/lib/domain";

export async function likeTrackAction(
  track: Track,
): Promise<{ ok: boolean; liked: boolean }> {
  try {
    const user = await requireUser();
    await likeTrack(user.id, track);
    return { ok: true, liked: true };
  } catch {
    return { ok: false, liked: false };
  }
}

export async function unlikeTrackAction(
  track: Track,
): Promise<{ ok: boolean; liked: boolean }> {
  try {
    const user = await requireUser();
    await unlikeTrack(user.id, {
      provider: track.provider,
      providerTrackId: track.providerTrackId ?? track.id,
    });
    return { ok: true, liked: false };
  } catch {
    return { ok: false, liked: false };
  }
}

export async function checkTrackLikedAction(
  providerTrackId: string,
  provider: string,
): Promise<boolean> {
  const userId = await getSessionUserId();
  if (!userId) {
    return false;
  }
  return isTrackLiked(userId, { provider, providerTrackId });
}
