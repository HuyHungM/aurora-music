"use server";

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import { followArtist, unfollowArtist, isFollowing } from "@/lib/dal/follow";
import type { Artist } from "@/lib/domain";

export async function followArtistAction(
  artist: Artist,
): Promise<{ ok: boolean; following: boolean }> {
  try {
    const user = await requireUser();
    await followArtist(user.id, artist);
    return { ok: true, following: true };
  } catch {
    return { ok: false, following: false };
  }
}

export async function unfollowArtistAction(
  artist: Artist,
): Promise<{ ok: boolean; following: boolean }> {
  try {
    const user = await requireUser();
    await unfollowArtist(user.id, {
      provider: artist.provider,
      providerArtistId: artist.providerArtistId ?? artist.id,
    });
    return { ok: true, following: false };
  } catch {
    return { ok: false, following: false };
  }
}

export async function checkFollowingAction(
  providerArtistId: string,
  provider: string,
): Promise<boolean> {
  const userId = await getSessionUserId();
  if (!userId) {
    return false;
  }
  return isFollowing(userId, { provider, providerArtistId });
}
