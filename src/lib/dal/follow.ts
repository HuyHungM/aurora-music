import type { PrismaClient } from "@/generated/prisma/client";
import type { Artist } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertArtist } from "@/lib/dal/catalog";
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
  // ONE round trip, not two — the same shape `isFollowing` and `isTrackLiked`
  // already use in this file: put the relation predicate in the `where` instead
  // of resolving the ref to an internal id first. The return type is `void`, so
  // the old "unknown artist → early return" branch was unobservable; a
  // `deleteMany` matching nothing deletes nothing.
  await db.follow.deleteMany({
    where: { userId, artist: { provider: ref.provider, providerArtistId: ref.providerArtistId } },
  });
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
  // ONE round trip. This resolved the ref to an internal `Artist.id` and then
  // asked the question — two sequential statements, on a path the artist page
  // hits on every render. `isTrackLiked` in the sibling module answers the
  // identical question in one query with exactly this shape, and its comment
  // already explains why the relation predicate belongs in the `where`: it lets
  // Postgres use the `@@unique([userId, artistId])` index without a join to
  // resolve the provider ref first.
  const row = await db.follow.findFirst({
    where: {
      userId,
      artist: { provider: ref.provider, providerArtistId: ref.providerArtistId },
    },
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