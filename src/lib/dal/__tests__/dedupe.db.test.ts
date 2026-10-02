import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addTrackToPlaylist, createPlaylist, reorderPlaylist } from "@/lib/dal/playlist";
import { getLibraryOverview, getPlaylistDetail } from "@/lib/dal/library";
import { listRecent, recordPlayed } from "@/lib/dal/recently-played";
import { findTrackInternalId, upsertTrack } from "@/lib/dal/catalog";
import { ConflictError } from "@/lib/errors";
import { dbTest } from "./harness";

/**
 * Canonical duplicate prevention, exercised through the real DAL against the
 * real database. Nothing here is mocked: the point of these tests is that the
 * DATABASE is the thing that ultimately holds a listener's collections, so a
 * check that only exists in TypeScript would not be enough.
 */
const namespace = dbTest.providerNamespace();
let userId: string;

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);

beforeAll(async () => {
  userId = await dbTest.createUser("dedupe");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await dbTest.cleanup(namespace);
});

async function seedPlaylist(title: string): Promise<string> {
  const playlist = await createPlaylist(userId, { title }, prisma);
  return playlist.id;
}

async function membershipTitles(playlistId: string): Promise<string[]> {
  const detail = await getPlaylistDetail(userId, playlistId, prisma);
  expect(detail).not.toBeNull();
  return (detail?.tracks ?? []).map((entry) => `${entry.provider}:${entry.providerTrackId}`);
}

/** How many recency rows exist for a track's PROVIDER id. */
function recentRowCount(provider: string, providerTrackId: string) {
  return prisma.recentlyPlayed.count({
    where: { userId, track: { provider, providerTrackId } },
  });
}

describe("playlist membership is unique per canonical track", () => {
  it("rejects a repeated add of the same track and leaves the list unchanged", async () => {
    const playlistId = await seedPlaylist("same-track");
    const track = dbTest.makeTrack(namespace, 1);
    await addTrackToPlaylist(userId, playlistId, track, prisma);
    await expect(
      addTrackToPlaylist(userId, playlistId, track, prisma),
    ).rejects.toBeInstanceOf(ConflictError);
    // Idempotent in state: A B C stays A B C.
    const other = dbTest.makeTrack(namespace, 2);
    const third = dbTest.makeTrack(namespace, 3);
    await addTrackToPlaylist(userId, playlistId, other, prisma);
    await addTrackToPlaylist(userId, playlistId, third, prisma);
    await expect(
      addTrackToPlaylist(userId, playlistId, track, prisma),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await membershipTitles(playlistId)).toEqual([
      `${track.provider}:${track.id}`,
      `${other.provider}:${other.id}`,
      `${third.provider}:${third.id}`,
    ]);
  });

  it("rejects the SAME track added concurrently", async () => {
    const playlistId = await seedPlaylist("concurrent-same");
    const track = dbTest.makeTrack(namespace, 4);
    // Both requests pass the membership check before either commits, which is
    // exactly the window the unique constraint has to close. The loser is
    // reported as a conflict, never as a second row and never as a raw unique
    // violation.
    const results = await Promise.allSettled([
      addTrackToPlaylist(userId, playlistId, track, prisma),
      addTrackToPlaylist(userId, playlistId, track, prisma),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((r) => r.status === "rejected");
    expect(rejection).toBeDefined();
    expect(String((rejection as PromiseRejectedResult).reason)).toContain(
      "already in the playlist",
    );
    expect(await membershipTitles(playlistId)).toHaveLength(1);
  });

  it("rejects a CROSS-PROVIDER rendering of a member", async () => {
    const playlistId = await seedPlaylist("cross-provider");
    const spotify = dbTest.makeProviderTrack(namespace, "spotify", 1, 1);
    const deezer = dbTest.makeProviderTrack(namespace, "deezer", 1, 2);
    await addTrackToPlaylist(userId, playlistId, spotify, prisma);
    // Same recording, different provider: two Track rows, two internal ids.
    // The DB constraint cannot see these are one song; the canonical check can.
    await expect(
      addTrackToPlaylist(userId, playlistId, deezer, prisma),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await membershipTitles(playlistId)).toEqual([`spotify:${spotify.id}`]);
  });

  it("still admits a genuinely different song that merely looks similar", async () => {
    const playlistId = await seedPlaylist("distinct");
    const original = dbTest.makeProviderTrack(namespace, "spotify", 1, 3);
    // A partial artist overlap and a close title is a `possible` verdict,
    // which must never auto-merge.
    const other = {
      ...dbTest.makeProviderTrack(namespace, "deezer", 1, 4),
      title: "Shared Songs",
      artistName: "Shared",
    };
    await addTrackToPlaylist(userId, playlistId, original, prisma);
    await expect(
      addTrackToPlaylist(userId, playlistId, other, prisma),
    ).resolves.toBeDefined();
    expect(await membershipTitles(playlistId)).toHaveLength(2);
  });

  it("renders a legacy cross-provider duplicate membership once", async () => {
    const playlistId = await seedPlaylist("legacy-duplicate");
    const spotify = dbTest.makeProviderTrack(namespace, "spotify", 20, 1);
    const deezer = dbTest.makeProviderTrack(namespace, "deezer", 20, 2);
    await addTrackToPlaylist(userId, playlistId, spotify, prisma);
    // Write the second membership DIRECTLY, bypassing `addTrackToPlaylist`'s
    // canonical check. This is the only way a playlist can hold a repeat, and
    // it stands in for a playlist that predates the check rather than for a
    // product path that still permits one.
    await upsertTrack(prisma, deezer);
    const deezerInternal = await findTrackInternalId(prisma, {
      provider: "deezer",
      providerTrackId: deezer.id,
    });
    expect(deezerInternal).not.toBeNull();
    await prisma.playlistTrack.create({
      data: { playlistId, trackId: deezerInternal as string, position: 1 },
    });
    // Both rows really are in the database...
    await expect(
      prisma.playlistTrack.count({ where: { playlistId } }),
    ).resolves.toBe(2);
    // ...and every read collapses them, so the listener sees one song and the
    // library card's count agrees with the detail list.
    expect(await membershipTitles(playlistId)).toEqual([`spotify:${spotify.id}`]);
    const detail = await getPlaylistDetail(userId, playlistId, prisma);
    expect(detail?.playlist.items).toHaveLength(1);
    expect(detail?.tracks).toHaveLength(1);
    const overview = await getLibraryOverview(userId, {}, prisma);
    expect(overview.playlists.find((entry) => entry.id === playlistId)?.items).toHaveLength(1);
  });

  it("still reorders a playlist whose hidden duplicate the client never saw", async () => {
    const playlistId = await seedPlaylist("legacy-reorder");
    const a = dbTest.makeProviderTrack(namespace, "youtube", 21, 1);
    const b = dbTest.makeProviderTrack(namespace, "youtube", 22, 1);
    // A Deezer rendering of B's recording: a DIFFERENT Track row, so the unique
    // constraint permits it, which is exactly the shape of the legacy
    // duplicate this simulates. A second membership of B itself is impossible
    // by design and would not stand in for anything.
    const bCrossProvider = dbTest.makeProviderTrack(namespace, "deezer", 22, 1);
    await addTrackToPlaylist(userId, playlistId, a, prisma);
    await addTrackToPlaylist(userId, playlistId, b, prisma);
    await upsertTrack(prisma, bCrossProvider);
    const hidden = await findTrackInternalId(prisma, {
      provider: "deezer",
      providerTrackId: bCrossProvider.id,
    });
    const aInternal = await findTrackInternalId(prisma, {
      provider: "youtube",
      providerTrackId: a.id,
    });
    expect(hidden).not.toBeNull();
    expect(aInternal).not.toBeNull();
    await prisma.playlistTrack.create({
      data: { playlistId, trackId: hidden as string, position: 2 },
    });
    // The client sends exactly the two refs it was shown, reversed. Validating
    // against the raw row count would reject this as a length mismatch.
    const reordered = await reorderPlaylist(
      userId,
      playlistId,
      [
        { provider: "youtube", providerTrackId: b.id },
        { provider: "youtube", providerTrackId: a.id },
      ],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([b.id, a.id]);
    // The hidden row is left in place, beyond the ordered range, and no two
    // rows ever shared a position.
    const rows = await prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: "asc" },
      select: { trackId: true, position: true },
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.position)).size).toBe(rows.length);
    expect(rows.filter((row) => row.trackId === aInternal)[0]?.position).toBe(1);
  });

  it("keeps ordering and the unique constraints intact", async () => {
    const playlistId = await seedPlaylist("ordering");
    const first = dbTest.makeProviderTrack(namespace, "youtube", 2, 1);
    const second = dbTest.makeProviderTrack(namespace, "youtube", 3, 2);
    await addTrackToPlaylist(userId, playlistId, first, prisma);
    await addTrackToPlaylist(userId, playlistId, second, prisma);
    const rows = await prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: "asc" },
    });
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    // The declared constraint is the reason a concurrent add can never
    // produce two rows, so assert the database really enforces it.
    await expect(
      prisma.playlistTrack.create({
        data: { playlistId, trackId: rows[0]?.trackId as string, position: 5 },
      }),
    ).rejects.toThrow();
  });
});

describe("recently played holds one row per canonical track", () => {
  it("A B A leaves A newest and B second", async () => {
    const a = dbTest.makeTrack(namespace, 11);
    const b = dbTest.makeTrack(namespace, 12);
    await recordPlayed(userId, a, prisma, new Date("2026-01-01T00:00:00.000Z"));
    await recordPlayed(userId, b, prisma, new Date("2026-01-02T00:00:00.000Z"));
    await recordPlayed(userId, a, prisma, new Date("2026-01-03T00:00:00.000Z"));
    const recent = await listRecent(userId, 10, prisma);
    expect(recent.slice(0, 2).map((entry) => entry.trackId)).toEqual([a.id, b.id]);
    // Exactly two rows, not three: the replay UPDATED the existing row rather
    // than appending, which is what moves A back to the newest position.
    await expect(recentRowCount(a.provider as string, a.id)).resolves.toBe(1);
    await expect(recentRowCount(b.provider as string, b.id)).resolves.toBe(1);
    expect(recent[0]?.playedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("A A A A leaves one item", async () => {
    const track = dbTest.makeTrack(namespace, 13);
    for (let index = 0; index < 4; index += 1) {
      await recordPlayed(
        userId,
        track,
        prisma,
        new Date(`2026-02-0${index + 1}T00:00:00.000Z`),
      );
    }
    const recent = await listRecent(userId, 50, prisma);
    expect(recent.filter((entry) => entry.trackId === track.id)).toHaveLength(1);
    await expect(recentRowCount(track.provider as string, track.id)).resolves.toBe(1);
    expect(
      recent.find((entry) => entry.trackId === track.id)?.playedAt,
    ).toBe("2026-02-04T00:00:00.000Z");
  });

  it("treats cross-provider renderings of one recording as one item", async () => {
    const spotify = dbTest.makeProviderTrack(namespace, "spotify", 5, 1);
    const deezer = dbTest.makeProviderTrack(namespace, "deezer", 5, 2);
    const youtube = dbTest.makeProviderTrack(namespace, "youtube", 5, 3);
    const renderings = [spotify, deezer, youtube];
    for (const [index, track] of renderings.entries()) {
      await recordPlayed(
        userId,
        track,
        prisma,
        new Date(`2026-03-0${index + 1}T00:00:00.000Z`),
      );
    }
    // Three provider rows, ONE canonical track. The surviving row is the FIRST
    // one seen, and it carries the NEWEST playedAt - so the recency order
    // reflects when the listener last heard the song, not which provider
    // happened to supply the last play.
    const recent = await listRecent(userId, 50, prisma);
    const group = recent.filter((entry) =>
      renderings.map((track) => track.id).includes(entry.trackId),
    );
    expect(group).toHaveLength(1);
    expect(group[0]?.trackId).toBe(spotify.id);
    expect(group[0]?.playedAt).toBe("2026-03-03T00:00:00.000Z");
    for (const track of renderings.slice(1)) {
      await expect(recentRowCount(track.provider, track.id)).resolves.toBe(0);
    }
  });

  it("makes the library recency panel agree with listRecent", async () => {
    const overview = await getLibraryOverview(userId, { recentLimit: 50 }, prisma);
    const recentIds = overview.recent.map((entry) => entry.track.id);
    expect(new Set(recentIds).size).toBe(recentIds.length);
  });

  it("keeps every DISTINCT track, capping at 50", async () => {
    const fresh = await dbTest.createUser("dedupe-cap");
    try {
      for (let index = 0; index < 55; index += 1) {
        await recordPlayed(
          fresh,
          dbTest.makeProviderTrack(namespace, "youtube", 100 + index, index),
          prisma,
          at(index),
        );
      }
      await expect(
        prisma.recentlyPlayed.count({ where: { userId: fresh } }),
      ).resolves.toBeLessThanOrEqual(50);
      const recent = await listRecent(fresh, 50, prisma);
      expect(new Set(recent.map((entry) => entry.trackId)).size).toBe(50);
    } finally {
      await prisma.user.deleteMany({ where: { id: fresh } });
    }
    // ROUND-TRIP-BOUND, and the timeout is local to this test on purpose.
    //
    // Proving a cap of 50 means writing 55 rows, one `recordPlayed` at a time -
    // there is no way to assert the cap without exceeding it. Each call is
    // ~6-8 round trips (catalog upsert, bounded read, upsert, count, and the
    // trim once past the limit), so this is ~400 round trips. Against the
    // remote Postgres this project is configured against, at the measured
    // ~296 ms per round trip, that is ~2 minutes: this test measured 136.6 s.
    //
    // It is not hung and there is nothing to fix in the query - the writes are
    // sequential by nature, since each one trims the rows the previous wrote.
    // The budget is therefore set here, where the reason is visible, rather
    // than by raising the suite's for every other test too.
  }, 200_000);
});

describe("the migration's duplicate cleanup is exact and deterministic", () => {
  /**
   * The migration runs once against production-shaped data, so its SQL is
   * tested here against a temp table rather than only being trusted. What is
   * being asserted is the two properties that make it safe: it merges only
   * IDENTICAL (userId, trackId) pairs, and of each pair it keeps a
   * deterministic survivor.
   */
  it("keeps the newest row per (userId, trackId) and never compares metadata", async () => {
    const table = `RecentlyPlayedCleanupTest_${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `CREATE TEMP TABLE "${table}" (
         "id" TEXT PRIMARY KEY,
         "userId" TEXT NOT NULL,
         "trackId" TEXT NOT NULL,
         "title" TEXT NOT NULL,
         "playedAt" TIMESTAMPTZ NOT NULL
       )`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${table}" ("id","userId","trackId","title","playedAt") VALUES
         ('id-1','u1','t1','Same Title','2026-01-01T00:00:00Z'),
         ('id-2','u1','t1','Same Title','2026-01-03T00:00:00Z'),
         ('id-3','u1','t1','Same Title','2026-01-02T00:00:00Z'),
         ('id-4','u1','t2','Same Title','2026-01-01T00:00:00Z'),
         ('id-5','u2','t1','Same Title','2026-01-01T00:00:00Z'),
         ('id-6','u2','t1','Same Title','2026-01-01T00:00:00Z')`,
      );

      // The exact statement from the migration, unchanged.
      await prisma.$executeRawUnsafe(
        `DELETE FROM "${table}"
         WHERE "id" NOT IN (
           SELECT DISTINCT ON ("userId", "trackId") "id"
           FROM "${table}"
           ORDER BY "userId", "trackId", "playedAt" DESC, "id" DESC
         )`,
      );

      const survivors = (await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "${table}" ORDER BY "id"`,
      )) as Array<{ id: string }>;
      // u1/t1: three rows, newest (id-2) wins. u1/t2: kept. u2/t1: both rows
      // share a playedAt, so the `id DESC` tie-break decides - id-6 - which is
      // the point of having one: the same input always yields the same output.
      expect(survivors.map((row) => row.id)).toEqual(["id-2", "id-4", "id-6"]);

      // u1/t1 and u1/t2 are the same user with the same TITLE but different
      // trackId, and both survive. That is the proof this cleanup can never
      // merge two different songs: it compares primary identity only.
      expect(survivors).toHaveLength(3);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    }
  });

  it("re-running the cleanup on already-clean data is a no-op", async () => {
    const table = `RecentlyPlayedIdempotent_${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `CREATE TEMP TABLE "${table}" (
         "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL,
         "trackId" TEXT NOT NULL, "title" TEXT NOT NULL, "playedAt" TIMESTAMPTZ NOT NULL
       )`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${table}" VALUES
         ('a','u1','t1','X','2026-01-01T00:00:00Z'),
         ('b','u1','t2','X','2026-01-02T00:00:00Z')`,
      );
      const statement = `DELETE FROM "${table}" WHERE "id" NOT IN (
        SELECT DISTINCT ON ("userId","trackId") "id" FROM "${table}"
        ORDER BY "userId","trackId","playedAt" DESC,"id" DESC)`;
      await prisma.$executeRawUnsafe(statement);
      await prisma.$executeRawUnsafe(statement);
      const survivors = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "${table}"`,
      )) as Array<{ n: number }>;
      expect(survivors[0]?.n).toBe(2);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    }
  });
});
