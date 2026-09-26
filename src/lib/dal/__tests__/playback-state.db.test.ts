import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbTest } from "./harness";
import {
  clearPlaybackState,
  getPlaybackState,
  savePlaybackState,
} from "@/lib/dal/playback-state";
import { prisma } from "@/lib/db";
import { QUEUE_SNAPSHOT_VERSION } from "@/lib/player/queue-snapshot";

describe("playback-state DAL", () => {
  let namespace: string;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    namespace = dbTest.providerNamespace();
    userA = await dbTest.createUser("ps-a");
    userB = await dbTest.createUser("ps-b");
  });

  afterEach(async () => {
    await prisma.playbackState.deleteMany({
      where: { userId: { in: [userA, userB] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userA, userB] } },
    });
    await dbTest.cleanup(namespace);
  });

  it("returns null when nothing is persisted", async () => {
    expect(await getPlaybackState(userA)).toBeNull();
  });

  it("creates state on first save with revision 0", async () => {
    const saved = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 83,
      revision: 0,
    });
    expect(saved).toBe(true);

    const state = await getPlaybackState(userA);
    expect(state).toMatchObject({
      provider: namespace,
      providerTrackId: "t-1",
      position: 83,
      revision: 1,
    });
  });

  it("rejects first save with a nonzero revision", async () => {
    const saved = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 10,
      revision: 5,
    });
    expect(saved).toBe(false);
    expect(await getPlaybackState(userA)).toBeNull();
  });

  it("accepts the current revision and bumps it", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 10,
      revision: 0,
    });
    const saved = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-2",
      position: 20,
      revision: 1,
    });
    expect(saved).toBe(true);

    const state = await getPlaybackState(userA);
    expect(state).toMatchObject({
      providerTrackId: "t-2",
      position: 20,
      revision: 2,
    });
  });

  it("ignores stale revisions: newer save wins", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 10,
      revision: 0,
    });
    // Simulate revision 11 completing first (out-of-order network).
    const newerFirst = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-new",
      position: 99,
      revision: 1,
    });
    expect(newerFirst).toBe(true);

    // The older operation (still carrying revision 1) must not overwrite.
    const olderLate = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-old",
      position: 11,
      revision: 1,
    });
    expect(olderLate).toBe(false);

    const state = await getPlaybackState(userA);
    expect(state).toMatchObject({
      providerTrackId: "t-new",
      position: 99,
      revision: 2,
    });
  });

  it("isolates users: A never sees B's state", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-a",
      position: 1,
      revision: 0,
    });
    await savePlaybackState(userB, {
      provider: namespace,
      providerTrackId: "t-b",
      position: 2,
      revision: 0,
    });

    expect(await getPlaybackState(userA)).toMatchObject({
      providerTrackId: "t-a",
    });
    expect(await getPlaybackState(userB)).toMatchObject({
      providerTrackId: "t-b",
    });
  });

  it("clears only the requesting user's state", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-a",
      position: 1,
      revision: 0,
    });
    await savePlaybackState(userB, {
      provider: namespace,
      providerTrackId: "t-b",
      position: 2,
      revision: 0,
    });

    await clearPlaybackState(userA);

    expect(await getPlaybackState(userA)).toBeNull();
    expect(await getPlaybackState(userB)).toMatchObject({
      providerTrackId: "t-b",
    });
  });

  it("normalizes invalid positions to zero", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: Number.NaN,
      revision: 0,
    });
    expect(await getPlaybackState(userA)).toMatchObject({ position: 0 });

    await clearPlaybackState(userA);
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: -50,
      revision: 0,
    });
    expect(await getPlaybackState(userA)).toMatchObject({ position: 0 });
  });

  it("rejects negative revisions", async () => {
    const saved = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 10,
      revision: -1,
    });
    expect(saved).toBe(false);
    expect(await getPlaybackState(userA)).toBeNull();
  });

  it("round-trips a versioned queue snapshot with occurrence order intact", async () => {
    const queueSnapshot = {
      version: 2,
      entries: [
        {
          provider: namespace,
          providerTrackId: "t-a",
          title: "Track A",
          artistId: "a1",
          artistName: "Artist",
        },
        {
          provider: namespace,
          providerTrackId: "t-b",
          title: "Track B",
          artistId: "a1",
          artistName: "Artist",
        },
        {
          provider: namespace,
          providerTrackId: "t-a",
          title: "Track A",
          artistId: "a1",
          artistName: "Artist",
        },
      ],
      playOrder: [1, 0, 2],
      position: 0,
      mediaPosition: 45,
      shuffle: true,
      repeat: "all" as const,
      volume: 0.75,
      muted: false,
      savedAt: 1_700_000_000_000,
    };
    const saved = await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-b",
      position: 45,
      revision: 0,
      queueSnapshot,
    });
    expect(saved).toBe(true);

    const state = await getPlaybackState(userA);
    expect(state?.queueSnapshot).toEqual(queueSnapshot);
    // Repeated occurrences survive the round trip (no dedup).
    expect(
      state?.queueSnapshot?.entries.map((entry) => entry.providerTrackId),
    ).toEqual(["t-a", "t-b", "t-a"]);
  });

  it("stores no playback URLs: raw snapshot JSON is identity-only", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 5,
      revision: 0,
      queueSnapshot: {
        version: 2,
        entries: [
          {
            provider: namespace,
            providerTrackId: "t-1",
            title: "Track",
            artistId: "a1",
            artistName: "Artist",
            artworkUrl: "https://cdn.example/art.jpg",
          },
        ],
        playOrder: [0],
        position: 0,
        mediaPosition: 5,
        shuffle: false,
        repeat: "off" as const,
        volume: 1,
        muted: false,
        savedAt: 1_700_000_000_000,
      },
    });
    const row = await prisma.playbackState.findUnique({
      where: { userId: userA },
    });
    const raw = JSON.stringify(row?.queueSnapshot);
    for (const forbidden of [
      "googlevideo",
      "streamUrl",
      "previewUrl",
      "mimeType",
      "expiresAt",
      "bitrate",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("migrates a v1 snapshot row written by an older build on read", async () => {
    // Simulate a Phase 40 row: valid v1 JSON stored directly in the
    // database, bypassing this build's writer.
    await prisma.playbackState.create({
      data: {
        userId: userA,
        provider: namespace,
        providerTrackId: "t-a",
        position: 45,
        revision: 3,
        queueSnapshot: {
          version: 1,
          entries: [
            {
              provider: namespace,
              providerTrackId: "t-a",
              title: "Track A",
              artistId: "a1",
              artistName: "Artist",
            },
          ],
          playOrder: [0],
          position: 0,
          mediaPosition: 45,
          shuffle: true,
          repeat: "all",
        },
      },
    });

    const state = await getPlaybackState(userA);
    expect(state?.queueSnapshot).not.toBeNull();
    // The user's queue survives the upgrade instead of being discarded.
    expect(state?.queueSnapshot?.entries.map((e) => e.providerTrackId)).toEqual([
      "t-a",
    ]);
    expect(state?.queueSnapshot?.playOrder).toEqual([0]);
    expect(state?.queueSnapshot?.position).toBe(0);
    expect(state?.queueSnapshot?.mediaPosition).toBe(45);
    expect(state?.queueSnapshot?.shuffle).toBe(true);
    expect(state?.queueSnapshot?.repeat).toBe("all");
    // New fields take their documented defaults.
    expect(state?.queueSnapshot?.volume).toBe(1);
    expect(state?.queueSnapshot?.muted).toBe(false);
    expect(state?.queueSnapshot?.version).toBe(QUEUE_SNAPSHOT_VERSION);
  });

  it("keeps queue snapshots isolated per user", async () => {
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-1",
      position: 5,
      revision: 0,
    });
    // Simulate corruption below the DAL (bypasses write-time validation).
    await prisma.playbackState.update({
      where: { userId: userA },
      data: { queueSnapshot: { version: 999, entries: [] } },
    });
    const state = await getPlaybackState(userA);
    expect(state?.queueSnapshot).toBeNull();
    expect(state).toMatchObject({ providerTrackId: "t-1" });
  });

  it("keeps queue snapshots isolated per user", async () => {
    const snapshotFor = (id: string) => ({
      version: 2,
      entries: [
        {
          provider: namespace,
          providerTrackId: id,
          title: `Track ${id}`,
          artistId: "a1",
          artistName: "Artist",
        },
      ],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off" as const,
      volume: 1,
      muted: false,
      savedAt: 1_700_000_000_000,
    });
    await savePlaybackState(userA, {
      provider: namespace,
      providerTrackId: "t-a",
      position: 0,
      revision: 0,
      queueSnapshot: snapshotFor("t-a"),
    });
    await savePlaybackState(userB, {
      provider: namespace,
      providerTrackId: "t-b",
      position: 0,
      revision: 0,
      queueSnapshot: snapshotFor("t-b"),
    });
    expect(
      (await getPlaybackState(userA))?.queueSnapshot?.entries[0]?.providerTrackId,
    ).toBe("t-a");
    expect(
      (await getPlaybackState(userB))?.queueSnapshot?.entries[0]?.providerTrackId,
    ).toBe("t-b");
  });
});
