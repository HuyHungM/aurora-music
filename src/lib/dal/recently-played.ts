import type { PrismaClient } from "@/generated/prisma/client";
import type { Track } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack } from "@/lib/dal/catalog";
import { mapRecentlyPlayed } from "@/lib/dal/mappers";
import type { RecentlyPlayed } from "@/lib/domain";

const RECENT_LIMIT = 50;

export async function recordPlayed(
  userId: string,
  track: Track,
  db: PrismaClient = prisma,
  playedAt: Date = new Date(),
): Promise<void> {
  const trackId = await upsertTrack(db, track);
  await db.recentlyPlayed.create({ data: { userId, trackId, playedAt } });
  const count = await db.recentlyPlayed.count({ where: { userId } });
  if (count > RECENT_LIMIT) {
    const oldest = await db.recentlyPlayed.findMany({
      where: { userId },
      orderBy: { playedAt: "desc" },
      select: { id: true },
      skip: RECENT_LIMIT,
    });
    if (oldest.length > 0) {
      await db.recentlyPlayed.deleteMany({
        where: { userId, id: { in: oldest.map((row) => row.id) } },
      });
    }
  }
}

export async function listRecent(
  userId: string,
  limit = 20,
  db: PrismaClient = prisma,
): Promise<RecentlyPlayed[]> {
  const rows = await db.recentlyPlayed.findMany({
    where: { userId },
    include: { track: true },
    orderBy: { playedAt: "desc" },
    take: limit,
  });
  return rows.map(mapRecentlyPlayed);
}