import type { PrismaClient } from "@/generated/prisma/client";
import type { Artist } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertArtist, findArtistInternalId } from "@/lib/dal/catalog";
import { mapFollow } from "@/lib/dal/mappers";
import type { Follow } from "@/lib/domain";

export interface ArtistRef {
  provider: string;
  providerArtistId: string;
}

export async function followArtist(
  userId: string,
  artist: Artist,
  db: PrismaClient = prisma,
): Promise<void> {
  const artistId = await upsertArtist(db, artist);
  try {
    await db.follow.create({ data: { userId, artistId } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return;
    }
    throw error;
  }
}

export async function unfollowArtist(
  userId: string,
  ref: ArtistRef,
  db: PrismaClient = prisma,
): Promise<void> {
  const artistId = await findArtistInternalId(db, ref);
  if (!artistId) {
    return;
  }
  await db.follow.deleteMany({ where: { userId, artistId } });
}

export async function listUserFollows(
  userId: string,
  pagination: { limit?: number; offset?: number } = {},
  db: PrismaClient = prisma,
): Promise<Follow[]> {
  const rows = await db.follow.findMany({
    where: { userId },
    include: { artist: true },
    orderBy: { createdAt: "desc" },
    take: pagination.limit,
    skip: pagination.offset,
  });
  return rows.map(mapFollow);
}

export async function isFollowing(
  userId: string,
  ref: ArtistRef,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const artistId = await findArtistInternalId(db, ref);
  if (!artistId) {
    return false;
  }
  const count = await db.follow.count({ where: { userId, artistId } });
  return count > 0;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}