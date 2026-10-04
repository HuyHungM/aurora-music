import type { PrismaClient } from "@/generated/prisma/client";
import type { Track, TrackRef } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack } from "@/lib/dal/catalog";
import { likeIdentityInclude, mapLike } from "@/lib/dal/mappers";
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
  // ONE round trip, not two. This used to resolve the provider ref to an
  // internal `Track.id` first and then delete by it — a read whose only purpose
  // was to produce a value the delete predicate could have expressed directly.
  // `isTrackLiked` in this same file already answers the identical question in
  // one query by putting the relation predicate in the `where`, and this is that
  // shape applied to the write.
  //
  // Behaviour is unchanged: a `deleteMany` whose predicate matches nothing
  // deletes nothing and reports `count: 0`, and the return type is `void`, so
  // the old "catalog miss → early return" branch was unobservable.
  await db.like.deleteMany({
    where: { userId, track: { provider: ref.provider, providerTrackId: ref.providerTrackId } },
  });
}

export async function listUserLikes(
  userId: string,
  pagination: { limit?: number; offset?: number } = {},
  db: PrismaClient = prisma,
): Promise<Like[]> {
  const rows = await db.like.findMany({
    where: { userId },
    include: likeIdentityInclude,
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
  // One query, not two, and no COUNT. A `@@unique([userId, trackId])` row
  // can only be present or absent, so counting it computes a number nobody
  // reads; `findFirst` on the same unique index answers the boolean directly
  // and drops the intermediate Track lookup that resolved the ref to an
  // internal id first.
  const row = await db.like.findFirst({
    where: {
      userId,
      track: { provider: ref.provider, providerTrackId: ref.providerTrackId },
    },
    select: { id: true },
  });
  return row !== null;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}