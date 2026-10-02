"use server";

import { requireUser } from "@/lib/dal/session";
import { followArtist, unfollowArtist } from "@/lib/dal/follow";
import type { Artist } from "@/lib/domain";
import { followArtistSchema } from "@/lib/validation";

export async function followArtistAction(
  artist: Artist,
): Promise<{ ok: boolean; following: boolean }> {
  try {
    // `upsertArtist` writes this payload onto the SHARED, unowned `Artist`
    // table — `name`, `image`, `bio` and `genres` — so it gets the same bound
    // the track writers get. Without a schema there is no length ceiling on any
    // of those columns, for any authenticated account.
    const parsed = followArtistSchema.safeParse({ artist });
    if (!parsed.success) {
      return { ok: false, following: false };
    }
    const user = await requireUser();
    await followArtist(user.id, parsed.data.artist as Artist);
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
    // `following` reports the state the caller should DISPLAY. A failed
    // unfollow leaves the user following, so reporting `false` here told
    // callers the opposite of the truth. `FollowButton` masked it by
    // hardcoding its own rollback value, which is exactly the kind of
    // compensation that stops mattering the moment a second caller appears.
    return { ok: false, following: true };
  }
}
