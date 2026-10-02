import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  createPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
} from "@/lib/dal/playlist";
import { dbTest } from "./harness";

// These assertions are integration tests: every one round-trips to the
// configured Postgres instance, which in this project's own configuration is a
// remote host. Measured on that host, one round trip costs ~296 ms, so the
// suite default of 30 s buys about 100 sequential queries. This file is written
// to stay well inside that - see `seedSparse` - and the remaining headroom is
// deliberate rather than luck.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Position-rewriting regressions.
 *
 * THE BUG THESE EXIST FOR. Both position rewriters shifted every membership of
 * a playlist out of the way with
 *
 *   updateMany({ data: { position: { increment: rows.length } } })
 *
 * and the shift was justified in a comment by an injectivity argument about the
 * FINAL mapping. That argument is about the end state. `@@unique([playlistId,
 * position])` is not `DEFERRABLE`, so Postgres checks it PER ROW as each row is
 * written - which means what matters is whether a row's destination is still
 * occupied at the moment it is written, and that depends on the order the
 * planner happens to visit rows in. Nothing in the SQL promises an order.
 *
 * A count-based shift is safe only when no two positions differ by exactly the
 * count. Dense lists satisfy that trivially, which is exactly why this looked
 * unreachable: every realistic sequence of DAL calls compacts back to a dense
 * list, so gaps only exist in a playlist whose positions were left sparse by
 * something the DAL does not control - history, an interrupted write, or a
 * fixture. Given sparse positions the shift collided, and the whole
 * transaction failed with P2002 - so a user could not remove a track from, or
 * reorder, that playlist at all.
 *
 * The tests below build exactly that sparse state and are the ones that failed
 * before the fix. Verified: with the count-based shift they fail with
 * `Unique constraint failed on the constraint:
 * PlaylistTrack_playlistId_position_key`; with the span-based shift they pass.
 *
 * Sparse positions are written with the client rather than through the DAL on
 * purpose, for two reasons. The DAL always compacts, so it cannot produce the
 * input that triggers this, and a test routed through it would pass either way
 * - which is how the bug survived a suite that exercised compaction heavily.
 * And going through `addTrackToPlaylist` N times costs N x ~9 round trips,
 * which is the entire reason the first version of this file timed out against a
 * remote database.
 */
const namespace = dbTest.providerNamespace();
let ownerId: string;

/** A unique block of track indices per call, so no two tests share a row. */
let sequence = 0;
function freshTracks(count: number) {
  sequence += 1;
  const base = 200 + sequence * 50;
  return Array.from({ length: count }, (_, index) =>
    dbTest.makeTrack(namespace, base + index),
  );
}

const ref = (track: ReturnType<typeof dbTest.makeTrack>) => ({
  provider: track.provider as string,
  providerTrackId: track.id,
});

/**
 * Creates a playlist whose memberships sit at `positions`.
 *
 * Delegated to the shared `dbTest.seedPlaylistAtPositions`, which documents
 * why this is bulk rather than a loop over `addTrackToPlaylist`: against the
 * configured remote Postgres that loop costs ~2.7 s per track and cannot finish
 * inside a test budget. This is legitimate here because the subject is what the
 * DAL does with positions it FINDS, not how the DAL writes them.
 */
async function seedSparse(
  positions: number[],
  tracks: ReturnType<typeof dbTest.makeTrack>[],
): Promise<string> {
  return dbTest.seedPlaylistAtPositions(ownerId, tracks, positions, {
    title: "Sparse",
  });
}

async function positionsOf(playlistId: string): Promise<number[]> {
  const rows = await prisma.playlistTrack.findMany({
    where: { playlistId },
    orderBy: { position: "asc" },
    select: { position: true },
  });
  return rows.map((row) => row.position);
}

beforeAll(async () => {
  ownerId = await dbTest.createUser("position-rewriter");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await dbTest.cleanup(namespace);
});

describe("position rewriting with sparse positions", () => {
  it("compacts a sparse playlist whose gaps exceed the row count", async () => {
    // The exact shape that broke. Five rows, positions 0,5,11,17,23: five
    // gaps, every one of them >= the count, so the old shift of 5 wrote the
    // row at 0 into position 5 - which the row at 5 had not vacated yet.
    const tracks = freshTracks(5);
    const id = await seedSparse([0, 5, 11, 17, 23], tracks);
    expect(await positionsOf(id)).toEqual([0, 5, 11, 17, 23]);

    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[2]),
      prisma,
    );

    // The visible order is preserved: removing the third row leaves the other
    // four in the sequence they were stored in.
    expect(after.items.map((item) => item.trackId)).toEqual([
      tracks[0].id,
      tracks[1].id,
      tracks[3].id,
      tracks[4].id,
    ]);
    expect(await positionsOf(id)).toEqual([0, 1, 2, 3]);
  });

  it("reorders a sparse playlist without colliding", async () => {
    // The same trigger condition on the other rewriter. Four rows with gaps of
    // 4 and 5: position 0 became 4, which was still occupied.
    const tracks = freshTracks(4);
    const id = await seedSparse([0, 4, 5, 9], tracks);
    expect(await positionsOf(id)).toEqual([0, 4, 5, 9]);

    const reversed = await reorderPlaylist(
      ownerId,
      id,
      [ref(tracks[3]), ref(tracks[2]), ref(tracks[1]), ref(tracks[0])],
      prisma,
    );

    expect(reversed.items.map((item) => item.trackId)).toEqual([
      tracks[3].id,
      tracks[2].id,
      tracks[1].id,
      tracks[0].id,
    ]);
    expect(await positionsOf(id)).toEqual([0, 1, 2, 3]);
  });

  it("keeps a single remaining row at position 0 when the last gap is removed", async () => {
    const tracks = freshTracks(2);
    const id = await seedSparse([0, 3], tracks);
    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[0]),
      prisma,
    );
    expect(after.items.map((item) => item.trackId)).toEqual([tracks[1].id]);
    expect(await positionsOf(id)).toEqual([0]);
  });

  it("empties a one-row playlist cleanly", async () => {
    // A single row at position 0 is already dense, so the compaction early
    // return fires and the removal costs nothing beyond the delete itself.
    const tracks = freshTracks(1);
    const id = await seedSparse([0], tracks);
    expect(await positionsOf(id)).toEqual([0]);
    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[0]),
      prisma,
    );
    expect(after.items).toHaveLength(0);
    expect(await positionsOf(id)).toEqual([]);
  });

  it("refuses to remove a track that is not in the playlist", async () => {
    const tracks = freshTracks(2);
    const id = await seedSparse([0], [tracks[0]]);
    await expect(
      removeTrackFromPlaylist(ownerId, id, ref(tracks[1]), prisma),
    ).rejects.toThrow(/not in the playlist/);
    // And the stored position is untouched by the refusal.
    expect(await positionsOf(id)).toEqual([0]);
  });
});

describe("position rewriting invariants", () => {
  it("leaves an empty playlist alone", async () => {
    const playlist = await createPlaylist(ownerId, { title: "Empty" }, prisma);
    expect(playlist.items).toHaveLength(0);
    expect(await positionsOf(playlist.id)).toEqual([]);
  });

  it("compacts a dense list normally", async () => {
    const tracks = freshTracks(3);
    const id = await seedSparse([0, 1, 2], tracks);
    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[0]),
      prisma,
    );
    expect(after.items.map((item) => item.trackId)).toEqual([
      tracks[1].id,
      tracks[2].id,
    ]);
    expect(await positionsOf(id)).toEqual([0, 1]);
  });

  it("refuses a duplicate membership rather than creating a second row", async () => {
    // The write path canonicalizes: a repeat is refused, so there can never be
    // two memberships for one track. That is what makes
    // `@@unique([playlistId, position])` the only positional constraint the
    // rewriters have to respect, so it is asserted here rather than assumed.
    const { addTrackToPlaylist } = await import("@/lib/dal/playlist");
    const tracks = freshTracks(1);
    const id = await seedSparse([0], tracks);
    await expect(
      addTrackToPlaylist(ownerId, id, tracks[0], prisma),
    ).rejects.toThrow(/already in the playlist/);
    expect(await positionsOf(id)).toEqual([0]);
  });

  it("compacts a long playlist, and the result is dense and in order", async () => {
    // 20 tracks. Sparse by construction: every gap is far larger than the row
    // count, so the old count-based shift collided on every one of them.
    const tracks = freshTracks(20);
    const positions = tracks.map((_, index) => index * 7);
    const id = await seedSparse(positions, tracks);

    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[0]),
      prisma,
    );

    expect(after.items).toHaveLength(tracks.length - 1);
    expect(await positionsOf(id)).toEqual(
      Array.from({ length: tracks.length - 1 }, (_, index) => index),
    );
    expect(after.items.map((item) => item.trackId)).toEqual(
      tracks.slice(1).map((track) => track.id),
    );
  });

  it("is idempotent: compacting an already-dense list changes nothing", async () => {
    const tracks = freshTracks(3);
    const id = await seedSparse([0, 1, 2], tracks);
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[2]), prisma);
    expect(await positionsOf(id)).toEqual([0, 1]);

    // Removing from a dense list leaves a dense list, so the second removal
    // takes the early return and the result is still exactly 0..n-1.
    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[1]),
      prisma,
    );
    expect(after.items.map((item) => item.trackId)).toEqual([tracks[0].id]);
    expect(await positionsOf(id)).toEqual([0]);
  });

  it("rolls the whole transaction back when a later step fails", async () => {
    // Atomicity: a failure anywhere in the rewriter must leave the stored
    // positions exactly as they were, not half-shifted. Forced with an unknown
    // track ref, which is rejected after the shift has already run.
    const tracks = freshTracks(3);
    const id = await seedSparse([0, 6, 13], tracks);
    const before = await positionsOf(id);

    await expect(
      reorderPlaylist(
        ownerId,
        id,
        [ref(tracks[0]), ref(tracks[1]), { provider: "deezer", providerTrackId: "nope" }],
        prisma,
      ),
    ).rejects.toThrow();

    expect(await positionsOf(id)).toEqual(before);
  });

  it("refuses a reorder that does not cover every membership", async () => {
    const tracks = freshTracks(3);
    const id = await seedSparse([0, 6, 13], tracks);
    const before = await positionsOf(id);
    await expect(reorderPlaylist(ownerId, id, [ref(tracks[0])], prisma)).rejects.toThrow();
    expect(await positionsOf(id)).toEqual(before);
  });

  it("writes a dense range for a playlist rebuilt from scratch", async () => {
    // The steady state the rest of the application assumes: five entries, three
    // removed, survivors sitting at 0..n-1 with nothing left behind.
    //
    // Bulk-seeded rather than appended through `addTrackToPlaylist`. The APPEND
    // path is asserted where it is the subject - `playlist-density.db.test.ts`
    // appends through it and checks density - so paying ~9 round trips per
    // track here proved nothing extra and, at the measured remote round-trip
    // cost, put this test at 41 s against a 60 s budget.
    const tracks = freshTracks(5);
    const id = await seedSparse([0, 1, 2, 3, 4], tracks);

    await removeTrackFromPlaylist(ownerId, id, ref(tracks[0]), prisma);
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[2]), prisma);
    const after = await removeTrackFromPlaylist(
      ownerId,
      id,
      ref(tracks[4]),
      prisma,
    );

    expect(after.items.map((item) => item.trackId)).toEqual([
      tracks[1].id,
      tracks[3].id,
    ]);
    expect(await positionsOf(id)).toEqual([0, 1]);
  });
});