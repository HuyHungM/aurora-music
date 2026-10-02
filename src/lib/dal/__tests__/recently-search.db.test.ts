import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  addSearch,
  clearSearchHistory,
  listSearchHistory,
} from "@/lib/dal/search-history";
import {
  listRecent,
  recordPlayed,
} from "@/lib/dal/recently-played";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();
let userId: string;

function playedAt(secondsAgo: number): Date {
  return new Date(Date.now() - secondsAgo * 1000);
}

beforeAll(async () => {
  userId = await dbTest.createUser("activity");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await dbTest.cleanup(namespace);
});

describe("recordPlayed / listRecent", () => {
  it("records plays and lists them most-recent-first", async () => {
    const first = dbTest.makeTrack(namespace, 1);
    const second = dbTest.makeTrack(namespace, 2);
    await recordPlayed(userId, first, prisma, playedAt(100));
    await recordPlayed(userId, second, prisma, playedAt(10));
    const recent = await listRecent(userId, 10, prisma);
    expect(recent.map((entry) => entry.trackId)).toEqual([second.id, first.id]);
  });

  it("caps history at 50 entries", async () => {
    for (let index = 100; index < 155; index += 1) {
      await recordPlayed(userId, dbTest.makeTrack(namespace, index), prisma, playedAt(index));
    }
    const count = await prisma.recentlyPlayed.count({ where: { userId } });
    expect(count).toBeLessThanOrEqual(50);
    // ROUND-TRIP-BOUND; local timeout, same reasoning as the equivalent test in
    // `dedupe.db.test.ts`, which is commented in full there. Proving a cap of
    // 50 means writing 55 rows sequentially, because each `recordPlayed` trims
    // what the previous one wrote, and each call is ~6-8 round trips. At the
    // measured ~296 ms per round trip against the remote database this project
    // is configured against, 55 of them is over two minutes. Nothing is hung
    // and no query is wrong; the work is simply irreducible for this assertion.
  }, 200_000);
});

describe("addSearch / listSearchHistory / clearSearchHistory", () => {
  it("ignores blank queries", async () => {
    await addSearch(userId, "   ", prisma);
    await expect(
      prisma.searchHistory.count({ where: { userId } }),
    ).resolves.toBe(0);
  });

  it("records searches newest-first", async () => {
    await addSearch(userId, "jazz", prisma);
    await addSearch(userId, "blues", prisma);
    const history = await listSearchHistory(userId, 10, prisma);
    expect(history.map((entry) => entry.query)).toEqual(["blues", "jazz"]);
  });

  it("caps history at 50 entries", async () => {
    for (let index = 0; index < 55; index += 1) {
      await addSearch(userId, `query-${index}`, prisma);
    }
    const count = await prisma.searchHistory.count({ where: { userId } });
    expect(count).toBeLessThanOrEqual(50);
    // ROUND-TRIP-BOUND; local timeout. Same reasoning as the `recordPlayed`
    // cap above. Each `addSearch` is a small transaction - two statements plus
    // BEGIN and COMMIT - but there are 55 of them and they cannot be batched
    // without changing the behaviour under test, since each one trims the rows
    // the previous wrote.
  }, 200_000);

  it("clears the history", async () => {
    await clearSearchHistory(userId, prisma);
    await expect(
      prisma.searchHistory.count({ where: { userId } }),
    ).resolves.toBe(0);
  });
});