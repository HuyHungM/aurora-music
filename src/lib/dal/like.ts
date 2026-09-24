import type { PrismaClient } from "@/generated/prisma/client";
import type { Track, TrackRef } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack, findTrackInternalId } from "@/lib/dal/catalog";
import { mapLike } from "@/lib/dal/mappers";
import type { Like } from "@/lib/domain";

export type { TrackRef };

export async function likeTrack(
  userId: string,
  track: Track,
  db: PrismaClient = prisma,
): Promise<void> {
  const trackId = await upsertTrack(db, track);
  try {
    await db.like.create({ data: { userId, trackId } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return;
    }
    throw error;
  }
}

export async function unlikeTrack(
  userId: string,
  ref: TrackRef,
  db: PrismaClient = prisma,
): Promise<void> {
  const trackId = await findTrackInternalId(db, ref);
  if (!trackId) {
    return;
  }
  await db.like.deleteMany({ where: { userId, trackId } });
}

export async function listUserLikes(
  userId: string,
  pagination: { limit?: number; offset?: number } = {},
  db: PrismaClient = prisma,
): Promise<Like[]> {
  const rows = await db.like.findMany({
    where: { userId },
    include: { track: true },
    orderBy: { createdAt: "desc" },
    take: pagination.limit,
    skip: pagination.offset,
  });
  return rows.map(mapLike);
}

export async function isTrackLiked(
  userId: string,
  ref: TrackRef,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const trackId = await findTrackInternalId(db, ref);
  if (!trackId) {
    return false;
  }
  const count = await db.like.count({ where: { userId, trackId } });
  return count > 0;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}