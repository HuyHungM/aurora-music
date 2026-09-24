import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export interface PlaybackStateSnapshot {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: Date;
}

export interface SavePlaybackStateInput {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
}

function normalizePosition(position: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.floor(position));
}

export async function getPlaybackState(
  userId: string,
  db: PrismaClient = prisma,
): Promise<PlaybackStateSnapshot | null> {
  const row = await db.playbackState.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    provider: row.provider,
    providerTrackId: row.providerTrackId,
    position: row.position,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

export async function savePlaybackState(
  userId: string,
  input: SavePlaybackStateInput,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const position = normalizePosition(input.position);
  if (input.revision < 0) return false;

  const existing = await db.playbackState.findUnique({ where: { userId } });

  if (!existing) {
    // First checkpoint: accept only revision 0, start at revision 1.
    if (input.revision !== 0) return false;
    await db.playbackState.create({
      data: {
        userId,
        provider: input.provider,
        providerTrackId: input.providerTrackId,
        position,
        revision: 1,
      },
    });
    return true;
  }

  // Compare-and-swap: only accept when caller's revision matches.
  if (input.revision !== existing.revision) return false;

  const updated = await db.playbackState.updateMany({
    where: { userId, revision: input.revision },
    data: {
      provider: input.provider,
      providerTrackId: input.providerTrackId,
      position,
      revision: input.revision + 1,
    },
  });
  return updated.count > 0;
}

export async function clearPlaybackState(
  userId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  await db.playbackState.deleteMany({ where: { userId } });
}
