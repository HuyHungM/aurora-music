import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { decodeEQ, encodeEQ, type EQConfig } from "@/lib/audio/eq";

/**
 * Authenticated EQ preference (Phase 53 addendum).
 *
 * A nullable `User.audioEq` column - not a dedicated table - holding the
 * compact versioned document `encodeEQ` produces. This is the same decision
 * `dal/appearance.ts` made for glass, `dal/locale.ts` for language and
 * `User.keepListening` for autoplay: a preference is a column on the account,
 * and a second table would be a second preference *system*.
 *
 * §40 says "do not create another preferences table/system solely for EQ", and
 * this is the reading of that instruction that holds up. A second TABLE would
 * be a second system: a second schema to migrate, a second place for a write to
 * fail, a second thing to back up. A second COLUMN on the existing table, read
 * and written by the same DAL shape, is a second *preference* - which is what
 * this is, and what a listener expects to find.
 *
 * The alternative considered and rejected: nesting the EQ inside the existing
 * `User.appearance` JSON. That would avoid a column, and it would be wrong.
 * `Appearance` is a closed, typed, per-control shape with eight values and its
 * own ranges, its own decoder and its own wire format; adding an audio key
 * would make it a bag of unrelated settings, break its per-field repair, and
 * mean that fixing a glass slider could clobber an equalizer. Two domains, two
 * documents, one table.
 *
 * Null means "no explicit preference" and is genuinely different from a stored
 * default: it falls through to the cookie and then to `DEFAULT_EQ`. A listener
 * who has never opened the equalizer has null here, which is what lets an
 * anonymous choice made before signing in survive the sign-in.
 *
 * Validation happens on BOTH sides, always: on read because the column is
 * attacker-adjacent and because a row written by a build that no longer exists
 * must not break the shell, and on write because the same document goes into a
 * cookie and there is no reason for the two to be able to disagree.
 */
export async function getUserEQ(
  userId: string,
  db: PrismaClient = prisma,
): Promise<EQConfig | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { audioEq: true },
  });
  if (row?.audioEq == null) {
    return null;
  }
  return decodeEQ(row.audioEq);
}

export async function setUserEQ(
  userId: string,
  config: EQConfig,
  db: PrismaClient = prisma,
): Promise<void> {
  // Round-tripped through the encoder so the column can only ever hold the
  // compact document, never a resolved configuration with all ten gains spelled
  // out. A read therefore has exactly one shape to handle.
  await db.user.update({
    where: { id: userId },
    data: { audioEq: encodeEQ(config) },
  });
}
