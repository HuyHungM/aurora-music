"use server";

import { requireUser } from "@/lib/dal/session";
import { recordPlayed } from "@/lib/dal/recently-played";
import type { Track } from "@/lib/domain";
import { guardRateLimit } from "@/lib/http/rate-limit-server";

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
    const user = await requireUser();
    await guardRateLimit("playbackRecord", { userId: user.id });
    await recordPlayed(user.id, track);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
