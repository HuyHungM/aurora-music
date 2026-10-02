import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  addTrackToPlaylist,
  createPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
} from "@/lib/dal/playlist";
import { dbTest } from "./harness";

// See `playlist-positions.db.test.ts` for why this file carries its own
// timeout. This one is cheaper than that - it does no sparse seeding - but it
// still round-trips to a remote Postgres.
vi.setConfig({ testTimeout: 60_000 });

/**
 * THE DENSITY INVARIANT.
 *
 * A playlist's stored positions are always `0..n-1`: dense, gapless, and
 * ordered. Every code path that writes them is expected to leave that true, and
 * this file asserts it as an invariant rather than as a side effect of a
 * compaction test.
 *
 * WHY IT IS SEPARATE FROM `playlist-positions.db.test.ts`. That file is about
 * the collision that a sparse playlist could provoke, and it creates sparse
 * positions deliberately to provoke it. This one is about the opposite claim:
 * that nothing the application does PRODUCES sparse positions. Mixing them
 * would mean asserting density in the same fixture that had just been made
 * sparse on purpose, which proves nothing about either.
 *
 * WHY IT EXISTS AT ALL. The count-based shift that caused the collision only
 * misfired when gaps were already present, so the question "can the DAL leave a
 * gap behind?" is the upstream half of that bug. Nothing checked it. This does.
 *
 * READ-ONLY. Nothing here repairs anything: it reads stored positions and
 * reports. Repairing production rows is not a test's job and is not this
 * repository's decision to make from a test.
 */
const namespace = dbTest.providerNamespace();
let ownerId: string;

const ref = (track: ReturnType<typeof dbTest.makeTrack>) => ({
  provider: track.provider as string,
  providerTrackId: track.id,
});

/**
 * Asserts that a playlist's stored positions are exactly `0..n-1`.
 *
 * The failure message names the playlist and prints the positions it actually
 * found, because "positions should be dense" is otherwise the least actionable
 * assertion in the suite - the reader still has to go and look up which
 * playlist and which values.
 */
async function expectDense(playlistId: string, label: string): Promise<void> {
  const rows = await prisma.playlistTrack.findMany({
    where: { playlistId },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  const actual = rows.map((row) => row.position);
  const expected = Array.from({ length: rows.length }, (_, index) => index);
  expect(
    actual,
    `playlist ${playlistId} (${label}) stored positions must be dense 0..n-1. ` +
      `Found ${rows.length} row(s) at [${actual.join(", ")}]; expected ` +
      `[${expected.join(", ")}]. First offending row: ` +
      `${rows.find((row, index) => row.position !== index)?.id ?? "none"}.`,
  ).toEqual(expected);
}

beforeAll(async () => {
  ownerId = await dbTest.createUser("density-invariant");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await dbTest.cleanup(namespace);
});

describe("playlist position density invariant", () => {
  it("holds for a freshly built playlist", async () => {
    const tracks = [
      dbTest.makeTrack(namespace, 301),
      dbTest.makeTrack(namespace, 302),
      dbTest.makeTrack(namespace, 303),
    ];
    const playlist = await createPlaylist(ownerId, { title: "Density" }, prisma);
    // An empty playlist is dense by definition: `0..-1` is the empty range.
    await expectDense(playlist.id, "empty");

    for (const track of tracks) {
      await addTrackToPlaylist(ownerId, playlist.id, track, prisma);
    }
    await expectDense(playlist.id, "three appends");
  });

  it("holds after every removal", async () => {
    const tracks = Array.from({ length: 5 }, (_, index) =>
      dbTest.makeTrack(namespace, 310 + index),
    );
    // Bulk-seeded: the APPEND path is already covered by the test above, and
    // what matters here is that each REMOVAL leaves a dense range. Seeding
    // through `addTrackToPlaylist` five times would spend ~14 s proving
    // something this file already proved.
    const id = await dbTest.seedPlaylistAtPositions(
      ownerId,
      tracks,
      tracks.map((_, index) => index),
      { title: "Drain" },
    );

    // Removed from the head, the middle and the tail, because the gap a
    // removal leaves behind depends on where it was - and a compaction that
    // only handled one of those would be missed.
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[0]), prisma);
    await expectDense(id, "head removed");
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[2]), prisma);
    await expectDense(id, "middle removed");
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[4]), prisma);
    await expectDense(id, "tail removed");
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[1]), prisma);
    await expectDense(id, "one left");
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[3]), prisma);
    await expectDense(id, "emptied");
  });

  it("holds after a reorder", async () => {
    const tracks = Array.from({ length: 6 }, (_, index) =>
      dbTest.makeTrack(namespace, 330 + index),
    );
    const id = await dbTest.seedPlaylistAtPositions(
      ownerId,
      tracks,
      tracks.map((_, index) => index),
      { title: "Shuffle" },
    );

    const reversed = [5, 4, 3, 2, 1, 0].map((index) => ref(tracks[index]));
    await reorderPlaylist(ownerId, id, reversed, prisma);
    await expectDense(id, "reversed");

    // A rotation moves the head to the tail, which is the case where the old
    // count-based shift had the most room to collide.
    const rotated = [...reversed.slice(2), ...reversed.slice(0, 2)];
    const after = await reorderPlaylist(ownerId, id, rotated, prisma);
    await expectDense(id, "rotated");
    expect(after.items.map((item) => item.trackId)).toEqual(
      rotated.map((entry) => entry.providerTrackId),
    );
  });

  it("holds across repeated removal and reordering of the same playlist", async () => {
    // The mixed sequence is the one that matters: each operation's compaction
    // is correct in isolation but a rewriter that left a gap behind would make
    // the NEXT one behave differently, and only the sequence shows that.
    const tracks = Array.from({ length: 4 }, (_, index) =>
      dbTest.makeTrack(namespace, 350 + index),
    );
    const id = await dbTest.seedPlaylistAtPositions(
      ownerId,
      tracks,
      tracks.map((_, index) => index),
      { title: "Churn" },
    );

    await reorderPlaylist(ownerId, id, [ref(tracks[1]), ref(tracks[0]), ref(tracks[2]), ref(tracks[3])], prisma);
    await expectDense(id, "after reorder");
    await removeTrackFromPlaylist(ownerId, id, ref(tracks[0]), prisma);
    await expectDense(id, "after remove");
    await reorderPlaylist(ownerId, id, [ref(tracks[3]), ref(tracks[2]), ref(tracks[1])], prisma);
    await expectDense(id, "after second reorder");
    await addTrackToPlaylist(ownerId, id, tracks[0], prisma);
    await expectDense(id, "after re-append");
  });
});