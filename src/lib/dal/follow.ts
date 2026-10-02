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

export interface FollowedArtist {
  followedAt: string;
  artist: Artist;
}

function mapArtistRow(row: {
  provider: string;
  providerArtistId: string;
  name: string;
  image: string | null;
  bio: string | null;
  genres: unknown;
}): Artist {
  const genres = Array.isArray(row.genres)
    ? row.genres.filter((genre): genre is string => typeof genre === "string")
    : undefined;
  return {
    id: row.providerArtistId,
    provider: row.provider as Artist["provider"],
    providerArtistId: row.providerArtistId,
    name: row.name,
    image: row.image ?? undefined,
    bio: row.bio ?? undefined,
    genres,
  };
}

/**
 * Artists the user follows, most-recent first, for the Library
 * Following Artists collection. Reuses the Follow rows — no second
 * favorites system.
 */
export async function listFollowedArtists(
  userId: string,
  pagination: { limit?: number; offset?: number } = {},
  db: PrismaClient = prisma,
): Promise<FollowedArtist[]> {
  const rows = await db.follow.findMany({
    where: { userId },
    include: { artist: true },
    orderBy: { createdAt: "desc" },
    take: pagination.limit,
    skip: pagination.offset,
  });
  return rows.map((row) => ({
    followedAt: row.createdAt.toISOString(),
    artist: mapArtistRow(row.artist),
  }));
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
  // `findFirst` on the `@@unique([userId, artistId])` index answers the
  // boolean in one round trip; the COUNT it replaces computed a number nobody
  // read and cost a second query to compute it.
  const row = await db.follow.findFirst({
    where: { userId, artistId },
    select: { id: true },
  });
  return row !== null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}