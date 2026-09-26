import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  decodeAppearance,
  encodeAppearance,
  type Appearance,
} from "@/lib/appearance/appearance";

/**
 * Authenticated appearance preference (Phase 53).
 *
 * A nullable `User.appearance` column - not a dedicated table - holding the
 * compact versioned document `encodeAppearance` produces. This is the same
 * decision `dal/locale.ts` made for language and the same one
 * `User.keepListening` made for autoplay: a preference is a column on the
 * account, not a table of its own, and a second table would be a second
 * preference *system* (RULE 2, §10).
 *
 * Null means "no explicit preference" and is genuinely different from a
 * stored default: it falls through to the cookie, and then to
 * `DEFAULT_APPEARANCE`. A user who has never opened Settings has null here,
 * which is what lets an anonymous choice made before signing in survive the
 * sign-in without being either silently adopted or silently discarded.
 *
 * Validation happens on BOTH sides, always. On read, because the column is
 * attacker-adjacent (any value a client ever sent is a candidate) and
 * because a row written by a build that no longer exists must not break the
 * shell. On write, because the same document goes into a cookie and into this
 * column and there is no reason for them to be able to disagree.
 */
export async function getUserAppearance(
  userId: string,
  db: PrismaClient = prisma,
): Promise<Appearance | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { appearance: true },
  });
  if (row?.appearance == null) {
    return null;
  }
  return decodeAppearance(row.appearance);
}

export async function setUserAppearance(
  userId: string,
  appearance: Appearance,
  db: PrismaClient = prisma,
): Promise<void> {
  // Round-tripped through the encoder so the column can only ever hold the
  // compact document, never a resolved object with all eight numbers spelled
  // out. A read therefore has exactly one shape to handle.
  await db.user.update({
    where: { id: userId },
    data: { appearance: encodeAppearance(appearance) },
  });
}
