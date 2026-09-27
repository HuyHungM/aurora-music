"use server";

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import { likeTrack, unlikeTrack, isTrackLiked } from "@/lib/dal/like";
import { idSchema, likeTrackSchema, providerIdSchema } from "@/lib/validation/schemas";
import type { Track } from "@/lib/domain";

export async function likeTrackAction(
  track: Track,
): Promise<{ ok: boolean; liked: boolean }> {
  try {
    const user = await requireUser();
    // A client supplies every display field here and `upsertTrack` writes them
    // into a catalog row every user reads, so the payload is parsed through the
    // same contract the playlist add path uses. The parsed value is what is
    // passed on, so a field zod strips (or bounds) cannot reach the DAL by way
    // of the original object.
    const parsed = likeTrackSchema.safeParse({ track });
    if (!parsed.success) {
      return { ok: false, liked: false };
    }
    await likeTrack(user.id, parsed.data.track as Track);
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
    // The ref decides which row is unliked, so it is parsed rather than read
    // straight off the payload.
    const parsed = idSchema.safeParse(track.providerTrackId ?? track.id);
    const provider = providerIdSchema.safeParse(track.provider);
    if (!parsed.success || !provider.success) {
      return { ok: false, liked: false };
    }
    await unlikeTrack(user.id, {
      provider: provider.data,
      providerTrackId: parsed.data,
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
