import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { mapSearchHistory } from "@/lib/dal/mappers";
import type { SearchHistory } from "@/lib/domain";

const HISTORY_LIMIT = 50;

export async function addSearch(
  userId: string,
  query: string,
  db: PrismaClient = prisma,
): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    return;
  }
  await db.searchHistory.create({ data: { userId, query: trimmed } });
  const count = await db.searchHistory.count({ where: { userId } });
  if (count > HISTORY_LIMIT) {
    const oldest = await db.searchHistory.findMany({
      where: { userId },
      orderBy: { searchedAt: "desc" },
      select: { id: true },
      skip: HISTORY_LIMIT,
    });
    if (oldest.length > 0) {
      await db.searchHistory.deleteMany({
        where: { userId, id: { in: oldest.map((row) => row.id) } },
      });
    }
  }
}

export async function listSearchHistory(
  userId: string,
  limit = 20,
  db: PrismaClient = prisma,
): Promise<SearchHistory[]> {
  const rows = await db.searchHistory.findMany({
    where: { userId },
    orderBy: { searchedAt: "desc" },
    take: limit,
  });
  return rows.map(mapSearchHistory);
}

export async function clearSearchHistory(
  userId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  await db.searchHistory.deleteMany({ where: { userId } });
}