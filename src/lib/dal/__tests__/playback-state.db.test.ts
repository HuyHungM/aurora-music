import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbTest } from "./harness";
import {
  clearPlaybackState,
  getPlaybackState,
  savePlaybackState,
} from "@/lib/dal/playback-state";
import { prisma } from "@/lib/db";

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
});
