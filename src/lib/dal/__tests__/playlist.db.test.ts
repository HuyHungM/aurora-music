import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listUserPlaylists,
  removeTrackFromPlaylist,
  reorderPlaylist,
  updatePlaylist,
} from "@/lib/dal/playlist";
import { AuthorizationError, ConflictError, ResourceNotFoundError } from "@/lib/errors";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();
let ownerId: string;
let strangerId: string;

const trackOne = dbTest.makeTrack(namespace, 1);
const trackTwo = dbTest.makeTrack(namespace, 2);
const trackThree = dbTest.makeTrack(namespace, 3);

const trackRef = (track: ReturnType<typeof dbTest.makeTrack>) => ({
  provider: track.provider as string,
  providerTrackId: track.id,
});

async function seedPlaylist(): Promise<string> {
  const playlist = await createPlaylist(ownerId, { title: "Seed", description: "desc" }, prisma);
  return playlist.id;
}

beforeAll(async () => {
  ownerId = await dbTest.createUser("owner");
  strangerId = await dbTest.createUser("stranger");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await dbTest.cleanup(namespace);
});

describe("createPlaylist / getPlaylist / listUserPlaylists", () => {
  it("creates an empty playlist owned by the user", async () => {
    const playlist = await createPlaylist(
      ownerId,
      { title: "My Mix", description: "Evening vibes", artwork: "https://art" },
      prisma,
    );
    expect(playlist.title).toBe("My Mix");
    expect(playlist.description).toBe("Evening vibes");
    expect(playlist.artwork).toBe("https://art");
    expect(playlist.ownerId).toBe(ownerId);
    expect(playlist.items).toHaveLength(0);
    expect(playlist.id).toBeTruthy();
  });

  it("reads back a playlist by id", async () => {
    const id = await seedPlaylist();
    const playlist = await getPlaylist(id, prisma);
    expect(playlist?.title).toBe("Seed");
  });

  it("returns null for a missing playlist", async () => {
    await expect(getPlaylist("missing", prisma)).resolves.toBeNull();
  });

  it("lists only the user's playlists", async () => {
    const own = await listUserPlaylists(ownerId, prisma);
    const other = await listUserPlaylists(strangerId, prisma);
    expect(own.map((playlist) => playlist.ownerId).every((id) => id === ownerId)).toBe(true);
    expect(other).toHaveLength(0);
  });
});

describe("addTrackToPlaylist", () => {
  it("appends tracks in position order", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    const playlist = await getPlaylist(id, prisma);
    expect(playlist?.items.map((item) => item.trackId)).toEqual([trackOne.id, trackTwo.id]);
  });

  it("rejects a duplicate track", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await expect(addTrackToPlaylist(ownerId, id, trackOne, prisma)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects a non-owner", async () => {
    const id = await seedPlaylist();
    await expect(addTrackToPlaylist(strangerId, id, trackOne, prisma)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("does not delete the underlying Track when adding to playlist", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    
    const trackExists = await prisma.track.findUnique({
      where: {
        provider_providerTrackId: {
          provider: trackOne.provider as string,
          providerTrackId: trackOne.id,
        },
      },
    });
    expect(trackExists).toBeTruthy();
    expect(trackExists?.title).toBe(trackOne.title);
  });

  it("serializes concurrent duplicate adds into one row plus a conflict", async () => {
    const id = await seedPlaylist();
    const outcomes = await Promise.allSettled([
      addTrackToPlaylist(ownerId, id, trackOne, prisma),
      addTrackToPlaylist(ownerId, id, trackOne, prisma),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof addTrackToPlaylist>>> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser reports a typed conflict — never a raw unique violation.
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    const rows = await prisma.playlistTrack.findMany({ where: { playlistId: id } });
    expect(rows).toHaveLength(1);
  });
});

describe("removeTrackFromPlaylist", () => {
  it("removes a track and compacts positions", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const after = await removeTrackFromPlaylist(ownerId, id, trackRef(trackTwo), prisma);
    expect(after.items.map((item) => item.trackId)).toEqual([trackOne.id, trackThree.id]);

    const positions = await prisma.playlistTrack.findMany({
      where: { playlistId: id },
      orderBy: { position: "asc" },
      select: { position: true },
    });
    expect(positions.map((row) => row.position)).toEqual([0, 1]);
  });

  it("rejects a track that is not in the playlist", async () => {
    const id = await seedPlaylist();
    await expect(
      removeTrackFromPlaylist(ownerId, id, trackRef(trackOne), prisma),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("does not delete the underlying Track when removing from playlist", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await removeTrackFromPlaylist(ownerId, id, trackRef(trackOne), prisma);
    
    const trackExists = await prisma.track.findUnique({
      where: {
        provider_providerTrackId: {
          provider: trackOne.provider as string,
          providerTrackId: trackOne.id,
        },
      },
    });
    expect(trackExists).toBeTruthy();
    expect(trackExists?.title).toBe(trackOne.title);
  });

  it("rejects a non-owner remove", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await expect(
      removeTrackFromPlaylist(strangerId, id, trackRef(trackOne), prisma),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("reorderPlaylist", () => {
  it("applies a full reorder", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const reordered = await reorderPlaylist(
      ownerId,
      id,
      [trackRef(trackThree), trackRef(trackOne), trackRef(trackTwo)],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([
      trackThree.id,
      trackOne.id,
      trackTwo.id,
    ]);
  });

  it("rejects order lengths that do not match the playlist", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await expect(reorderPlaylist(ownerId, id, [], prisma)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects orders referencing unknown tracks", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await expect(
      reorderPlaylist(ownerId, id, [{ provider: namespace, providerTrackId: "ghost" }], prisma),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("moves first track to later position", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const reordered = await reorderPlaylist(
      ownerId,
      id,
      [trackRef(trackTwo), trackRef(trackThree), trackRef(trackOne)],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([
      trackTwo.id,
      trackThree.id,
      trackOne.id,
    ]);
  });

  it("moves later track to first position", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const reordered = await reorderPlaylist(
      ownerId,
      id,
      [trackRef(trackThree), trackRef(trackOne), trackRef(trackTwo)],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([
      trackThree.id,
      trackOne.id,
      trackTwo.id,
    ]);
  });

  it("moves middle track to earlier position", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const reordered = await reorderPlaylist(
      ownerId,
      id,
      [trackRef(trackTwo), trackRef(trackOne), trackRef(trackThree)],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([
      trackTwo.id,
      trackOne.id,
      trackThree.id,
    ]);
  });

  it("moves middle track to later position", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const reordered = await reorderPlaylist(
      ownerId,
      id,
      [trackRef(trackOne), trackRef(trackThree), trackRef(trackTwo)],
      prisma,
    );
    expect(reordered.items.map((item) => item.trackId)).toEqual([
      trackOne.id,
      trackThree.id,
      trackTwo.id,
    ]);
  });

  it("rejects a non-owner reorder", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);

    await expect(
      reorderPlaylist(strangerId, id, [trackRef(trackTwo), trackRef(trackOne)], prisma),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("preserves playlist state after failed reorder", async () => {
    const id = await seedPlaylist();
    await addTrackToPlaylist(ownerId, id, trackOne, prisma);
    await addTrackToPlaylist(ownerId, id, trackTwo, prisma);

    try {
      await reorderPlaylist(ownerId, id, [], prisma);
    } catch {
      // expected
    }

    const playlist = await getPlaylist(id, prisma);
    expect(playlist?.items.map((item) => item.trackId)).toEqual([trackOne.id, trackTwo.id]);
  });
});

describe("updatePlaylist / deletePlaylist", () => {
  it("updates title, description, and artwork", async () => {
    const id = await seedPlaylist();
    const updated = await updatePlaylist(
      ownerId,
      id,
      { title: "Renamed", description: "", artwork: "https://new-art" },
      prisma,
    );
    expect(updated.title).toBe("Renamed");
    expect(updated.description).toBe("");
    expect(updated.artwork).toBe("https://new-art");
  });

  it("rejects a non-owner update", async () => {
    const id = await seedPlaylist();
    await expect(
      updatePlaylist(strangerId, id, { title: "Hijacked" }, prisma),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("deletes the playlist for its owner", async () => {
    const id = await seedPlaylist();
    await deletePlaylist(ownerId, id, prisma);
    await expect(getPlaylist(id, prisma)).resolves.toBeNull();
  });

  it("rejects a non-owner delete", async () => {
    const id = await seedPlaylist();
    await expect(deletePlaylist(strangerId, id, prisma)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("throws ResourceNotFoundError for a missing playlist", async () => {
    await expect(deletePlaylist(ownerId, "missing", prisma)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});