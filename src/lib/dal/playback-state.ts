import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  validateQueueSnapshot,
  type PersistedQueueSnapshot,
} from "@/lib/player/queue-snapshot";

export interface PlaybackStateSnapshot {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: Date;
  /**
   * Validated versioned queue snapshot when the row carries one.
   * Absent on legacy rows (single-track restore path applies).
   * Never playback URLs — enforced by validateQueueSnapshot.
   */
  queueSnapshot: PersistedQueueSnapshot | null;
}

export interface SavePlaybackStateInput {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  /** Optional versioned queue snapshot (validated again on read). */
  queueSnapshot?: PersistedQueueSnapshot | null;
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
    // Fail-closed: an invalid snapshot reads back as absent, leaving
    // the legacy single-track columns as the fallback.
    queueSnapshot:
      row.queueSnapshot == null
        ? null
        : (validateQueueSnapshot(row.queueSnapshot) ?? null),
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

  // Snapshot payload: validated shape, or null (legacy single-track
  // write). Stored as JSON; the revision CAS below still guards every
  // write, snapshot or not.
  const validatedSnapshot =
    input.queueSnapshot === undefined
      ? undefined
      : validateQueueSnapshot(input.queueSnapshot);
  const queueSnapshotValue =
    validatedSnapshot === undefined
      ? undefined
      : validatedSnapshot === null
        ? Prisma.DbNull
        : (validatedSnapshot as unknown as Prisma.InputJsonValue);

  if (!existing) {
    // First checkpoint: accept only revision 0, start at revision 1.
    if (input.revision !== 0) return false;
    const data: Prisma.PlaybackStateUncheckedCreateInput = {
      userId,
      provider: input.provider,
      providerTrackId: input.providerTrackId,
      position,
      revision: 1,
    };
    if (queueSnapshotValue !== undefined) {
      data.queueSnapshot = queueSnapshotValue;
    }
    await db.playbackState.create({ data });
    return true;
  }

  // Compare-and-swap: only accept when caller's revision matches.
  if (input.revision !== existing.revision) return false;

  const data: Prisma.PlaybackStateUpdateManyMutationInput = {
    provider: input.provider,
    providerTrackId: input.providerTrackId,
    position,
    revision: input.revision + 1,
  };
  if (queueSnapshotValue !== undefined) {
    data.queueSnapshot = queueSnapshotValue;
  }
  const updated = await db.playbackState.updateMany({
    where: { userId, revision: input.revision },
    data,
  });
  return updated.count > 0;
}

export async function clearPlaybackState(
  userId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  await db.playbackState.deleteMany({ where: { userId } });
}
