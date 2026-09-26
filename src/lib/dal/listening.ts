import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Phase 47 "Keep listening" preference.
 *
 * This is a user preference, not recommendation state: a single boolean
 * that says whether generic queue continuation may run. It lives on the
 * user row so it is per-account, needs no cookie and no browser storage
 * (which the repository forbids in production source), and never exposes
 * one listener's setting to another.
 *
 * The recommendation algorithm itself is deliberately NOT persisted: the
 * queue is the artifact, and Phase 47 continues from the current queue
 * after a reload rather than restoring a scoring snapshot.
 *
 * Default is OFF. That preserves the pre-existing documented behaviour
 * (queue ends, playback stops) and makes continuation opt-in rather than a
 * silent change of product semantics.
 */
export async function getKeepListening(
  userId: string,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { keepListening: true },
  });
  return row?.keepListening ?? false;
}

export async function setKeepListening(
  userId: string,
  enabled: boolean,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const row = await db.user.update({
    where: { id: userId },
    data: { keepListening: enabled },
    select: { keepListening: true },
  });
  return row.keepListening;
}
