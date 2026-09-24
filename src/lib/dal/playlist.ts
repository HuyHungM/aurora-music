import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { Playlist, Track } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack, findTrackInternalId } from "@/lib/dal/catalog";
import { isUniqueViolation } from "@/lib/dal/like";
import { mapPlaylist } from "@/lib/dal/mappers";
import {
  AuthorizationError,
  ConflictError,
  ResourceNotFoundError,
} from "@/lib/errors";
import type { TrackRef } from "@/lib/domain";

const playlistInclude = {
  tracks: {
    include: { track: true },
    orderBy: { position: "asc" },
  },
} as const;

export async function createPlaylist(
  userId: string,
  input: { title: string; description?: string; artwork?: string },
  db: PrismaClient = prisma,
): Promise<Playlist> {
  const row = await db.playlist.create({
    data: {
      userId,
      title: input.title,
      description: input.description,
      artwork: input.artwork,
    },
    include: playlistInclude,
  });
  return mapPlaylist(row);
}

export async function getPlaylist(
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<Playlist | null> {
  const row = await db.playlist.findUnique({
    where: { id: playlistId },
    include: playlistInclude,
  });
  return row ? mapPlaylist(row) : null;
}

export async function listUserPlaylists(
  userId: string,
  db: PrismaClient = prisma,
): Promise<Playlist[]> {
  const rows = await db.playlist.findMany({
    where: { userId },
    include: playlistInclude,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapPlaylist);
}

async function requirePlaylistOwner(
  ownerId: string,
  playlistId: string,
  db: PrismaClient,
) {
  const row = await db.playlist.findUnique({ where: { id: playlistId } });
  if (!row) {
    throw new ResourceNotFoundError(`Playlist ${playlistId} was not found`, "playlist");
  }
  if (row.userId !== ownerId) {
    throw new AuthorizationError("You do not own this playlist");
  }
  return row;
}

export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: { title?: string; description?: string | null; artwork?: string | null },
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const row = await db.playlist.update({
    where: { id: playlistId },
    data: {
      title: input.title,
      description: input.description ?? undefined,
      artwork: input.artwork ?? undefined,
    },
    include: playlistInclude,
  });
  return mapPlaylist(row);
}

export async function deletePlaylist(
  userId: string,
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  await requirePlaylistOwner(userId, playlistId, db);
  await db.playlist.delete({ where: { id: playlistId } });
}

export async function addTrackToPlaylist(
  userId: string,
  playlistId: string,
  track: Track,
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const trackId = await upsertTrack(db, track);
  let result;
  try {
    result = await db.$transaction(async (tx) => {
      const existing = await tx.playlistTrack.findFirst({
        where: { playlistId, trackId },
      });
      if (existing) {
        throw new ConflictError("This track is already in the playlist");
      }
      const aggregate = await tx.playlistTrack.aggregate({
        where: { playlistId },
        _max: { position: true },
      });
      const nextPosition = (aggregate._max.position ?? -1) + 1;
      await tx.playlistTrack.create({
        data: { playlistId, trackId, position: nextPosition },
      });
      return tx.playlist.findUniqueOrThrow({
        where: { id: playlistId },
        include: playlistInclude,
      });
    });
  } catch (error) {
    // Lost a concurrent-insert race after passing the membership check:
    // re-read once to report the duplicate correctly instead of leaking
    // a raw unique violation. A position-slot collision (different track)
    // rethrows untouched — still a safe failure, retried by the user.
    if (isUniqueViolation(error)) {
      const current = await db.playlistTrack.findFirst({
        where: { playlistId, trackId },
      });
      if (current) {
        throw new ConflictError("This track is already in the playlist");
      }
    }
    throw error;
  }
  return mapPlaylist(result);
}

export async function removeTrackFromPlaylist(
  userId: string,
  playlistId: string,
  ref: TrackRef,
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const trackId = await findTrackInternalId(db, ref);
  return db.$transaction(async (tx) => {
    const row = await tx.playlistTrack.findFirst({
      where: { playlistId, trackId: trackId ?? undefined },
    });
    if (!row) {
      throw new ResourceNotFoundError("This track is not in the playlist", "playlistTrack");
    }
    await tx.playlistTrack.delete({ where: { id: row.id } });
    await compactPositions(tx, playlistId);
    const updated = await tx.playlist.findUniqueOrThrow({
      where: { id: playlistId },
      include: playlistInclude,
    });
    return mapPlaylist(updated);
  });
}

export async function reorderPlaylist(
  userId: string,
  playlistId: string,
  orderedRefs: TrackRef[],
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  return db.$transaction(async (tx) => {
    const rows = await tx.playlistTrack.findMany({
      where: { playlistId },
      include: { track: true },
      orderBy: { position: "asc" },
    });
    if (rows.length !== orderedRefs.length) {
      throw new ConflictError(
        "Order must contain exactly one entry per track currently in the playlist",
      );
    }
    const byRef = new Map(
      rows.map((row) => [
        `${row.track.provider}:${row.track.providerTrackId}`,
        row.id,
      ]),
    );
    const missing = orderedRefs.some((ref) => !byRef.has(`${ref.provider}:${ref.providerTrackId}`));
    if (missing) {
      throw new ConflictError("Order references a track that is not in the playlist");
    }
    // Free the target slots first: shifting every row out of 0..n-1 avoids
    // stepping on temporarily occupied positions while applying the new order.
    const shift = rows.length;
    for (const row of rows) {
      await tx.playlistTrack.update({
        where: { id: row.id },
        data: { position: row.position + shift },
      });
    }
    for (let index = 0; index < orderedRefs.length; index += 1) {
      const ref = orderedRefs[index];
      const rowId = byRef.get(`${ref.provider}:${ref.providerTrackId}`);
      if (rowId) {
        await tx.playlistTrack.update({
          where: { id: rowId },
          data: { position: index },
        });
      }
    }
    const updated = await tx.playlist.findUniqueOrThrow({
      where: { id: playlistId },
      include: playlistInclude,
    });
    return mapPlaylist(updated);
  });
}

async function compactPositions(
  db: Prisma.TransactionClient,
  playlistId: string,
): Promise<void> {
  const rows = await db.playlistTrack.findMany({
    where: { playlistId },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.position !== index) {
      await db.playlistTrack.update({
        where: { id: row.id },
        data: { position: index },
      });
    }
  }
}