"use server";

import { requireUser } from "@/lib/dal/session";
import { recordPlayed } from "@/lib/dal/recently-played";
import type { Track } from "@/lib/domain";

export async function recordPlayedAction(
  track: Track,
): Promise<{ ok: boolean }> {
  try {
    const user = await requireUser();
    await recordPlayed(user.id, track);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
