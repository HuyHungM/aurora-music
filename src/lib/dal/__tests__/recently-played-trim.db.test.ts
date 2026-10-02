import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { recordPlayed } from "@/lib/dal/recently-played";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Track } from "@/lib/domain";
import { dbTest } from "./harness";

/**
 * The `recordPlayed` retention trim, pinned at every boundary.
 *
 * WHAT IS UNDER TEST. `recordPlayed` keeps a per-listener ring of at most 50
 * distinct tracks by deleting everything past the 50th newest row. This file
 * pins WHICH rows that is, at 0, 10, 50, 51 and 55 stored rows, because a count
 * that is right while the ring holds the wrong 50 rows is still a bug.
 *
 * THE REGRESSION PROOF IS THE LAST DESCRIBE BLOCK. Behavioural equivalence
 * between the old and new trim was established by
 * `scripts/bench-record-played.mts`, which diffed the retained-row fingerprints
 * of both algorithms and found them identical. What these tests add is the
 * durable version of that: a statement count, so re-adding the pre-count trips a
 * test rather than waiting for someone to re-run a benchmark. Verified by
 * restoring the `count()` call and watching this file fail.
 *
 * WHY SEEDING IS DIRECT. Arranging 50 plays through `recordPlayed` is 50
 * sequential calls of six to eight round trips each against a remote database -
 * over two minutes per case. The starting state is written directly and the call
 * under test is always a real `recordPlayed`.
 */

/** Mirrors `RECENT_LIMIT` in `src/lib/dal/recently-played.ts`. */
const LIMIT = 50;

const namespace = dbTest.providerNamespace();
const users: string[] = [];

/** One minute older than the last, so `playedAt` alone fully orders the ring. */
function playedAt(index: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - index * 60_000);
}

/**
 * A distinct seeded recording.
 *
 * `makeProviderTrack`, NOT `makeTrack`: `makeTrack` derives its artist id as
 * `artist-${index}` with no namespace, so a second fixture anywhere in the
 * database collides on `Artist_pkey`. `makeProviderTrack` namespaces its ids
 * (`partist-${ns}-…`, `ptrack-${ns}-…`), which is what lets this file seed
 * several rings and still be cleaned up by `dbTest.cleanup(namespace)`.
 *
 * `group` is the index and `index` is fixed, so every call is a DIFFERENT
 * recording - same title, artist and duration would be one recording to the
 * canonical matcher, which would collapse the ring this file is measuring.
 */
function distinctTrack(label: string, index: number): Track {
  return dbTest.makeProviderTrack(`${namespace}-${label}`, "youtube", index, 0);
}

/** A fresh user holding `count` seeded plays, newest first. */
async function seedUser(label: string, count: number): Promise<{
  id: string;
  trackIds: string[];
}> {
  const id = await dbTest.createUser(label);
  users.push(id);
  const tracks = Array.from({ length: count }, (_, i) => distinctTrack(label, i));
  await dbTest.seedRecentPlays(id, tracks, tracks.map((_, i) => playedAt(i)));
  return { id, trackIds: tracks.map((track) => track.id) };
}

/** Stored recency track ids for a user, newest first. */
async function storedTrackIds(userId: string): Promise<string[]> {
  const rows = await prisma.recentlyPlayed.findMany({
    where: { userId },
    orderBy: { playedAt: "desc" },
    select: { trackId: true },
  });
  return rows.map((row) => row.trackId);
}

/**
 * The database id of the row `recordPlayed` created for `track`.
 *
 * NOT `track.id`. `upsertTrack` matches on `(provider, providerTrackId)` and lets
 * Postgres generate the primary key, so a track first seen through the write path
 * has a generated id that is what the recency row's foreign key actually holds.
 * Asserting against the domain `id` here would test the wrong column.
 */
async function catalogRowId(track: Track): Promise<string> {
  const row = await prisma.track.findUnique({
    where: {
      provider_providerTrackId: {
        provider: track.provider as string,
        providerTrackId: track.id,
      },
    },
    select: { id: true },
  });
  if (!row) throw new Error(`no catalog row was written for ${track.id}`);
  return row.id;
}

afterAll(async () => {
  for (const id of users) {
    await prisma.recentlyPlayed.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
  await dbTest.cleanup(namespace);
});

describe("retention boundaries", () => {
  it("keeps the first play and deletes nothing on empty history", async () => {
    const id = await dbTest.createUser("trim-empty");
    users.push(id);
    const track = distinctTrack("empty", 900);

    await recordPlayed(id, track, prisma, playedAt(0));

    await expect(storedTrackIds(id)).resolves.toEqual([await catalogRowId(track)]);
  });

  it("deletes nothing when the history is below the limit", async () => {
    const { id, trackIds } = await seedUser("trim-below", 10);

    // A REPLAY, so the row count cannot change through the upsert and any
    // deletion observed afterwards came from the trim and nowhere else.
    await recordPlayed(id, distinctTrack("trim-below", 0), prisma, playedAt(-1));

    await expect(storedTrackIds(id)).resolves.toEqual(trackIds);
  });

  it("deletes nothing when the history sits exactly on the limit", async () => {
    const { id, trackIds } = await seedUser("trim-exact", LIMIT);

    await recordPlayed(id, distinctTrack("trim-exact", 0), prisma, playedAt(-1));

    const after = await storedTrackIds(id);
    // Same rows, not merely the same number: a trim that fired here would have
    // dropped the oldest one.
    expect(after).toHaveLength(LIMIT);
    expect(after).toEqual(trackIds);
  });

  it("drops exactly one row, the oldest, when a new track takes it to limit + 1", async () => {
    const { id, trackIds } = await seedUser("trim-over", LIMIT);
    const fresh = distinctTrack("trim-over", 901);

    await recordPlayed(id, fresh, prisma, playedAt(-1));

    const after = await storedTrackIds(id);
    expect(after).toHaveLength(LIMIT);
    // Newest first: the new play leads, and the OLDEST of the fifty is gone.
    expect(after).toEqual([await catalogRowId(fresh), ...trackIds.slice(0, LIMIT - 1)]);
    expect(after).not.toContain(trackIds[LIMIT - 1]);
  });

  it("drops exactly the excess, oldest first, when well over the limit", async () => {
    const { id, trackIds } = await seedUser("trim-well", LIMIT + 5);

    await recordPlayed(id, distinctTrack("trim-well", 0), prisma, playedAt(-1));

    const after = await storedTrackIds(id);
    expect(after).toHaveLength(LIMIT);
    expect(after).toEqual(trackIds.slice(0, LIMIT));
    // The five oldest are gone; nothing newer was touched.
    expect(after).not.toContain(trackIds[LIMIT]);
  });

  it("moves a replay to the newest position without growing the ring", async () => {
    const { id, trackIds } = await seedUser("trim-replay", LIMIT);
    const oldestId = trackIds[LIMIT - 1] as string;

    await recordPlayed(id, distinctTrack("trim-replay", LIMIT - 1), prisma, playedAt(-1));

    const after = await storedTrackIds(id);
    expect(after).toHaveLength(LIMIT);
    expect(after[0]).toBe(oldestId);
    // A replay updates the row rather than inserting one, so nothing is evicted.
    expect(new Set(after).size).toBe(LIMIT);
  });

  it("never trims another listener's rows", async () => {
    const mine = await seedUser("trim-scope-mine", LIMIT);
    const theirs = await seedUser("trim-scope-theirs", LIMIT);
    const before = await storedTrackIds(theirs.id);

    await recordPlayed(mine.id, distinctTrack("trim-scope-mine", 902), prisma, playedAt(-1));

    // An over-limit trim on one user must not reach another's identically-sized
    // ring: the `deleteMany` predicate carries `userId`, and this is the only
    // place that scoping is checked.
    await expect(storedTrackIds(theirs.id)).resolves.toEqual(before);
    await expect(storedTrackIds(mine.id)).resolves.toHaveLength(LIMIT);
  });

  it("propagates a trim failure rather than reporting a clean record", async () => {
    const { id } = await seedUser("trim-error", LIMIT);
    const fresh = distinctTrack("trim-error", 950);
    const message = "trim delete failed";

    // A thin proxy: every call reaches the real client except the trim's delete.
    // This is the one failure the trim owns, and the upsert that precedes it
    // succeeding must not let a failed delete look like a recorded play.
    //
    // Deliberately not a foreign-key violation: `upsertArtist` and `upsertTrack`
    // both UPSERT, so a bad id creates the row rather than failing, and the
    // earlier version of this test asserted a rejection that never came.
    const failing = new Proxy(prisma as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "recentlyPlayed") {
          return new Proxy(value as object, {
            get(delegate, key) {
              if (key === "deleteMany") {
                return async () => {
                  throw new Error(message);
                };
              }
              const inner = Reflect.get(delegate, key);
              return typeof inner === "function" ? inner.bind(delegate) : inner;
            },
          });
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaClient;

    await expect(recordPlayed(id, fresh, failing, playedAt(-1))).rejects.toThrow(message);
  });
});

describe("no redundant pre-count", () => {
  let counter: ReturnType<typeof dbTest.queryCounter>;

  beforeAll(() => {
    counter = dbTest.queryCounter();
  });

  afterAll(async () => {
    await counter.dispose();
    for (const id of users) {
      await prisma.recentlyPlayed.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
  });

  /** Only the statements touching the recency table; the rest are catalog. */
  function recencyStatements(all: readonly string[]): string[] {
    return all.filter((statement) => statement.includes('"RecentlyPlayed"'));
  }

  it("reads, upserts and checks for a trim - and asks nothing else", async () => {
    const label = "trim-count-below";
    const id = await dbTest.createUser(label);
    users.push(id);
    const [track] = [distinctTrack(label, 0)];
    await dbTest.seedRecentPlays(id, [track as Track], [playedAt(0)]);

    counter.take();
    await recordPlayed(id, track as Track, counter.db, playedAt(-1));
    const recency = recencyStatements(counter.take());

    // Bounded read, the upsert, and the single `skip` query that both decides
    // whether to trim and supplies the rows. Three, and no fourth.
    expect(recency).toHaveLength(3);
    // What this whole block exists for: a `COUNT(*)` here is the removed
    // pre-count, and nothing in this path legitimately counts.
    expect(recency.filter((s) => s.includes("COUNT("))).toHaveLength(0);
  });

  it("adds the delete, not a count, when the ring does need trimming", async () => {
    const label = "trim-count-over";
    const id = await dbTest.createUser(label);
    users.push(id);
    const tracks = Array.from({ length: LIMIT }, (_, i) => distinctTrack(label, i));
    await dbTest.seedRecentPlays(id, tracks, tracks.map((_, i) => playedAt(i)));
    const fresh = distinctTrack(label, LIMIT);

    counter.take();
    await recordPlayed(id, fresh, counter.db, playedAt(-1));
    const recency = recencyStatements(counter.take());

    // The trimming path is exactly one statement more than the not-trimming one,
    // and that statement is the DELETE.
    expect(recency).toHaveLength(4);
    expect(recency.filter((s) => s.includes("COUNT("))).toHaveLength(0);
    expect(recency.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
    await expect(storedTrackIds(id)).resolves.toHaveLength(LIMIT);
  });
});