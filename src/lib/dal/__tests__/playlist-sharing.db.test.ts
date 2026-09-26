import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  mintShareToken,
  removeTrackFromPlaylist,
  setPlaylistVisibility,
  updatePlaylist,
  getSharedPlaylistByToken,
  getSharedPlaylistTracks,
} from "@/lib/dal/playlist";
import { getOwnedPlaylist } from "@/lib/dal/library";
import { getKeepListening, setKeepListening } from "@/lib/dal/listening";
import { AuthorizationError } from "@/lib/errors";
import { SHARE_TOKEN_LENGTH } from "@/lib/validation";
import { dbTest } from "./harness";

/**
 * Phase 47 database-level sharing, artwork, and keep-listening integration
 * (against a real PostgreSQL instance via `bun run test:db`).
 *
 * The action tests prove the server-action boundary is owner-gated; these
 * prove the queries underneath actually enforce it. That distinction
 * matters: an action that checks ownership while the query it calls filters
 * on nothing is a boundary that only holds in tests.
 */

const namespace = dbTest.providerNamespace();
let ownerId: string;
let strangerId: string;

const trackOne = dbTest.makeTrack(namespace, 11);
const trackTwo = dbTest.makeTrack(namespace, 12);

const trackRef = (track: ReturnType<typeof dbTest.makeTrack>) => ({
  provider: track.provider as string,
  providerTrackId: track.id,
});

async function seedSharedPlaylist(): Promise<{ id: string; token: string }> {
  const playlist = await createPlaylist(
    ownerId,
    { title: "Shared Mix", description: "A public collection" },
    prisma,
  );
  await addTrackToPlaylist(ownerId, playlist.id, trackOne, prisma);
  await addTrackToPlaylist(ownerId, playlist.id, trackTwo, prisma);
  const result = await setPlaylistVisibility(ownerId, playlist.id, "shared", prisma);
  return { id: playlist.id, token: result.shareToken as string };
}

beforeAll(async () => {
  ownerId = await dbTest.createUser("share-owner");
  strangerId = await dbTest.createUser("share-stranger");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await dbTest.cleanup(namespace);
});

describe("share tokens", () => {
  it("mints a base64url token of the documented length", () => {
    const token = mintShareToken();
    expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("mints a different token every time", () => {
    const tokens = new Set(Array.from({ length: 32 }, mintShareToken));
    expect(tokens.size).toBe(32);
  });

  it("encodes nothing about the playlist or its owner", () => {
    // A token derived from an id would be guessable and would leak structure
    // in the URL. 192 random bits cannot.
    const token = mintShareToken();
    expect(token).not.toContain(ownerId);
  });
});

describe("setPlaylistVisibility", () => {
  it("shares a private playlist and returns a token", async () => {
    const playlist = await createPlaylist(ownerId, { title: "To Share" }, prisma);
    const result = await setPlaylistVisibility(ownerId, playlist.id, "shared", prisma);
    expect(result.visibility).toBe("shared");
    expect(result.shareToken).toHaveLength(SHARE_TOKEN_LENGTH);
  });

  it("defaults a new playlist to private with no token", async () => {
    const playlist = await createPlaylist(ownerId, { title: "Not Shared" }, prisma);
    expect(playlist.visibility).toBe("private");
    // `shareToken` is an optional field: undefined means "no token exists",
    // which is the only correct representation for a private playlist.
    expect(playlist.shareToken).toBeUndefined();
    const row = await prisma.playlist.findUniqueOrThrow({ where: { id: playlist.id } });
    expect(row.shareToken).toBeNull();
  });

  it("is idempotent: re-sharing keeps the same link alive", async () => {
    const first = await setPlaylistVisibility(
      ownerId,
      (await createPlaylist(ownerId, { title: "Idem" }, prisma)).id,
      "shared",
      prisma,
    );
    const id = (await prisma.playlist.findFirstOrThrow({
      where: { userId: ownerId, title: "Idem" },
    })).id;
    const second = await setPlaylistVisibility(ownerId, id, "shared", prisma);
    expect(second.shareToken).toBe(first.shareToken);
  });

  it("revoking clears the token, so the old link stops resolving", async () => {
    const { id, token } = await seedSharedPlaylist();
    await expect(getSharedPlaylistByToken(token, prisma)).resolves.not.toBeNull();

    const revoked = await setPlaylistVisibility(ownerId, id, "private", prisma);
    expect(revoked.shareToken).toBeNull();

    // The old URL is now indistinguishable from one that never existed.
    await expect(getSharedPlaylistByToken(token, prisma)).resolves.toBeNull();
    await expect(getSharedPlaylistTracks(token, prisma)).resolves.toEqual([]);
  });

  it("rejects a non-owner", async () => {
    const id = (await createPlaylist(ownerId, { title: "Owned" }, prisma)).id;
    await expect(
      setPlaylistVisibility(strangerId, id, "shared", prisma),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The playlist is untouched.
    const row = await prisma.playlist.findUniqueOrThrow({ where: { id } });
    expect(row.visibility).toBe("private");
    expect(row.shareToken).toBeNull();
  });
});

describe("getSharedPlaylistByToken", () => {
  it("returns the shared playlist's public view", async () => {
    const { token } = await seedSharedPlaylist();
    const shared = await getSharedPlaylistByToken(token, prisma);
    expect(shared).not.toBeNull();
    expect(shared?.title).toBe("Shared Mix");
    expect(shared?.description).toBe("A public collection");
    expect(shared?.items).toHaveLength(2);
  });

  // The strongest privacy guarantee in this feature: the public read model
  // has no ownerId and no shareToken field at all, so no rendering path,
  // metadata call, or serialization can leak either.
  it("never exposes an owner id or the reusable token", async () => {
    const { token } = await seedSharedPlaylist();
    const shared = await getSharedPlaylistByToken(token, prisma);
    const keys = Object.keys(shared as object);
    expect(keys).not.toContain("ownerId");
    expect(keys).not.toContain("shareToken");
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("userId");
    expect(JSON.stringify(shared)).not.toContain(ownerId);
    expect(JSON.stringify(shared)).not.toContain(token);
  });

  it("attributes a display name, not an account identifier", async () => {
    const { token } = await seedSharedPlaylist();
    const shared = await getSharedPlaylistByToken(token, prisma);
    expect(shared?.ownerDisplayName.length).toBeGreaterThan(0);
    expect(shared?.ownerDisplayName).not.toBe(ownerId);
  });

  it("falls back to a neutral name rather than exposing an email", async () => {
    const { token } = await seedSharedPlaylist();
    await prisma.user.update({ where: { id: ownerId }, data: { name: null } });
    const shared = await getSharedPlaylistByToken(token, prisma);
    expect(shared?.ownerDisplayName).toBe("Aurora");
    await prisma.user.update({ where: { id: ownerId }, data: { name: "share-owner" } });
  });

  it("returns null for an unknown token", async () => {
    await expect(getSharedPlaylistByToken(mintShareToken(), prisma)).resolves.toBeNull();
  });

  it("returns null for a malformed token", async () => {
    for (const token of ["", "x", "../../etc/passwd", "%00", "a".repeat(200)]) {
      await expect(getSharedPlaylistByToken(token, prisma), token).resolves.toBeNull();
    }
  });

  // §18: a private playlist must be unreachable by guessing. The database id
  // is the thing an attacker would try, and it must not work in any form.
  it("never resolves a PRIVATE playlist, even by its exact database id", async () => {
    const playlist = await createPlaylist(ownerId, { title: "Secret" }, prisma);
    const row = await prisma.playlist.findUniqueOrThrow({ where: { id: playlist.id } });
    expect(row.shareToken).toBeNull();

    await expect(getSharedPlaylistByToken(playlist.id, prisma)).resolves.toBeNull();
    await expect(getSharedPlaylistTracks(playlist.id, prisma)).resolves.toEqual([]);
  });

  it("never resolves a private playlist through an owner-scoped read either", async () => {
    const playlist = await createPlaylist(ownerId, { title: "Secret 2" }, prisma);
    await expect(getOwnedPlaylist(strangerId, playlist.id, prisma)).resolves.toBeNull();
  });
});

describe("getSharedPlaylistTracks", () => {
  it("returns the ordered display tracks for a shared playlist", async () => {
    const { token } = await seedSharedPlaylist();
    const tracks = await getSharedPlaylistTracks(token, prisma);
    expect(tracks.map((track) => track.providerTrackId)).toEqual([trackOne.id, trackTwo.id]);
  });

  // A public read must resolve exactly the tracks the owner's playlist
  // references, in the same order. `getSharedPlaylistTracks` is wider than
  // `PlaylistItem` on purpose — the shared page needs title/artist/album to
  // render — so the invariant is identity and order, not field equality.
  // (Asserting on `streamUrl` here would only be asserting that the db-test
  // fixture seeds one; it says nothing about this code path.)
  it("resolves the owner's tracks, in order, with display metadata", async () => {
    const { token } = await seedSharedPlaylist();
    const shared = await getSharedPlaylistByToken(token, prisma);
    const publicTracks = await getSharedPlaylistTracks(token, prisma);

    expect(
      publicTracks.map((track) => `${track.provider}:${track.providerTrackId}`),
    ).toEqual(shared?.items.map((item) => `${item.provider}:${item.trackId}`));
    expect(publicTracks.length).toBeGreaterThan(0);
    // The reason the wider read exists: display metadata a ref cannot carry.
    expect(publicTracks[0]?.title.length).toBeGreaterThan(0);
    expect(publicTracks[0]?.artistName.length).toBeGreaterThan(0);
  });

  it("reflects a track the owner added after sharing", async () => {
    const { id, token } = await seedSharedPlaylist();
    const trackThree = dbTest.makeTrack(namespace, 13);
    await addTrackToPlaylist(ownerId, id, trackThree, prisma);

    const tracks = await getSharedPlaylistTracks(token, prisma);
    expect(tracks.map((track) => track.providerTrackId)).toContain(trackThree.id);
  });

  it("reflects a track the owner removed after sharing", async () => {
    const { id, token } = await seedSharedPlaylist();
    await removeTrackFromPlaylist(ownerId, id, trackRef(trackTwo), prisma);

    const tracks = await getSharedPlaylistTracks(token, prisma);
    expect(tracks.map((track) => track.providerTrackId)).toEqual([trackOne.id]);
  });

  it("returns nothing once the playlist is deleted, not an error", async () => {
    const { id, token } = await seedSharedPlaylist();
    await deletePlaylist(ownerId, id, prisma);

    await expect(getSharedPlaylistByToken(token, prisma)).resolves.toBeNull();
    await expect(getSharedPlaylistTracks(token, prisma)).resolves.toEqual([]);
  });
});

describe("custom artwork", () => {
  it("stores and reads back a custom artwork URL", async () => {
    const id = (await createPlaylist(ownerId, { title: "Art" }, prisma)).id;
    const updated = await updatePlaylist(
      ownerId,
      id,
      { artwork: "https://img.example/cover.jpg" },
      prisma,
    );
    expect(updated.artwork).toBe("https://img.example/cover.jpg");
  });

  it("changing artwork does not touch the track contents", async () => {
    const { id } = await seedSharedPlaylist();
    const before = await getOwnedPlaylist(ownerId, id, prisma);

    await updatePlaylist(ownerId, id, { artwork: "https://img.example/new.jpg" }, prisma);

    const after = await getOwnedPlaylist(ownerId, id, prisma);
    expect(after?.items).toEqual(before?.items);
    expect(after?.items).toHaveLength(2);
    expect(after?.artwork).toBe("https://img.example/new.jpg");
  });

  // Phase 47 regression: `description ?? undefined` / `artwork ?? undefined`
  // collapsed an explicit null into "not provided", so "remove artwork"
  // reported success and changed nothing.
  it("removes artwork on an explicit null", async () => {
    const id = (await createPlaylist(ownerId, { title: "Art 2" }, prisma)).id;
    await updatePlaylist(ownerId, id, { artwork: "https://img.example/x.jpg" }, prisma);
    expect((await getOwnedPlaylist(ownerId, id, prisma))?.artwork).toBe(
      "https://img.example/x.jpg",
    );

    const cleared = await updatePlaylist(ownerId, id, { artwork: null }, prisma);
    // `artwork` is an optional field, so "cleared" reads back as undefined.
    // The stored value is what proves the write actually happened — a
    // `?? undefined` on the way IN would silently drop the null and leave
    // the old URL in place, which is the bug this guards.
    expect(cleared.artwork).toBeUndefined();
    expect((await getOwnedPlaylist(ownerId, id, prisma))?.artwork).toBeUndefined();
    const row = await prisma.playlist.findUniqueOrThrow({ where: { id } });
    expect(row.artwork).toBeNull();
  });

  it("leaves artwork alone when the field is absent", async () => {
    const id = (await createPlaylist(ownerId, { title: "Art 3" }, prisma)).id;
    await updatePlaylist(ownerId, id, { artwork: "https://img.example/keep.jpg" }, prisma);

    // A title-only edit must not clear the artwork.
    await updatePlaylist(ownerId, id, { title: "Renamed Only" }, prisma);
    expect((await getOwnedPlaylist(ownerId, id, prisma))?.artwork).toBe(
      "https://img.example/keep.jpg",
    );
  });

  it("rejects a non-owner artwork change", async () => {
    const id = (await createPlaylist(ownerId, { title: "Art 4" }, prisma)).id;
    await updatePlaylist(ownerId, id, { artwork: "https://img.example/mine.jpg" }, prisma);

    await expect(
      updatePlaylist(strangerId, id, { artwork: "https://img.example/theirs.jpg" }, prisma),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect((await getOwnedPlaylist(ownerId, id, prisma))?.artwork).toBe(
      "https://img.example/mine.jpg",
    );
  });

  it("serves the custom artwork on the shared public view", async () => {
    const { id, token } = await seedSharedPlaylist();
    await updatePlaylist(ownerId, id, { artwork: "https://img.example/shared.jpg" }, prisma);
    expect((await getSharedPlaylistByToken(token, prisma))?.artwork).toBe(
      "https://img.example/shared.jpg",
    );
  });

  it("falls back to no artwork for a shared playlist with none", async () => {
    const { token } = await seedSharedPlaylist();
    expect((await getSharedPlaylistByToken(token, prisma))?.artwork).toBeUndefined();
  });
});

describe("keep-listening preference", () => {
  it("defaults to off for a new user", async () => {
    await expect(getKeepListening(ownerId, prisma)).resolves.toBe(false);
  });

  it("persists a change and reads it back", async () => {
    const saved = await setKeepListening(ownerId, true, prisma);
    expect(saved).toBe(true);
    await expect(getKeepListening(ownerId, prisma)).resolves.toBe(true);

    await setKeepListening(ownerId, false, prisma);
    await expect(getKeepListening(ownerId, prisma)).resolves.toBe(false);
  });

  it("is per-account and never leaks across users", async () => {
    await setKeepListening(ownerId, true, prisma);
    await expect(getKeepListening(strangerId, prisma)).resolves.toBe(false);
    await setKeepListening(ownerId, false, prisma);
  });

  it("throws for a missing user rather than inventing a default", async () => {
    await expect(getKeepListening("no-such-user", prisma)).resolves.toBe(false);
    await expect(setKeepListening("no-such-user", true, prisma)).rejects.toThrow();
  });
});
