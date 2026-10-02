"use server";

import { requireUser } from "@/lib/dal/session";
import { recordPlayed } from "@/lib/dal/recently-played";
import type { Track } from "@/lib/domain";
import { guardRateLimit } from "@/lib/http/rate-limit-server";
import { isOfflineTrack } from "@/lib/offline/isolation";
import { recordPlayedSchema } from "@/lib/validation";

/**
 * Fires on every natural end of a track, so it is the highest-frequency write
 * path in the product. Budgeted (RULE 12) at a level no listener can reach by
 * listening - 300/minute is about five tracks a second - which means a real
 * person is never affected and an unbounded client loop is.
 *
 * A denial is reported as `{ ok: false }` with no error text: this is a
 * background history write, there is nobody to show a message to, and the
 * client already treats a failure here as non-fatal.
 */
export async function recordPlayedAction(
  track: Track,
): Promise<{ ok: boolean }> {
  try {
    // An offline track is a file on the user's own disk, not catalog data.
    // Recording it would write a `local` row into the user's history and read
    // back later as a track that can never be resolved. Silently skipped
    // rather than refused: this is a background write with no control attached
    // to it, so there is nobody to show a message to.
    if (isOfflineTrack(track)) {
      return { ok: false };
    }
    // Same contract as the other two catalog writers. `recordPlayed` upserts
    // the client payload into the SHARED, unowned catalog, so without this an
    // authenticated user could write unbounded `title`/`artistName`/`genres`/
    // `artworkUrl` onto a row every other user renders. See `dal/catalog.ts`
    // for why that table has no owner column to authorize against.
    const parsed = recordPlayedSchema.safeParse({ track });
    if (!parsed.success) {
      return { ok: false };
    }
    const user = await requireUser();
    await guardRateLimit("playbackRecord", { userId: user.id });
    await recordPlayed(user.id, parsed.data.track as Track);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
