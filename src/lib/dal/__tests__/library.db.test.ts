import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getLibraryOverview, getOwnedPlaylist } from "@/lib/dal/library";
import { likeTrack } from "@/lib/dal/like";
import { recordPlayed } from "@/lib/dal/recently-played";
import {
  addTrackToPlaylist,
  createPlaylist,
} from "@/lib/dal/playlist";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();
let userId: string;
let strangerId: string;

const trackOne = dbTest.makeTrack(namespace, 1);
const trackTwo = dbTest.makeTrack(namespace, 2);
const trackThree = dbTest.makeTrack(namespace, 3);

beforeAll(async () => {
  userId = await dbTest.createUser("library-owner");
  strangerId = await dbTest.createUser("library-stranger");

  await likeTrack(userId, trackOne, prisma);
  await recordPlayed(userId, trackTwo, prisma, new Date("2026-05-01T00:00:00.000Z"));
  await recordPlayed(userId, trackOne, prisma, new Date("2026-05-02T00:00:00.000Z"));

  await likeTrack(strangerId, trackThree, prisma);
  const strangerPlaylist = await createPlaylist(strangerId, { title: "Stranger Mix" }, prisma);
  await addTrackToPlaylist(strangerId, strangerPlaylist.id, trackThree, prisma);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [userId, strangerId] } } });
  await dbTest.cleanup(namespace);
});

describe("getLibraryOverview", () => {
  it("combines likes, recently played, and playlists for the user", async () => {
    const overview = await getLibraryOverview(userId, {}, prisma);
    expect(overview.liked.length).toBe(1);
    expect(overview.recent.length).toBe(2);
  });

  it("maps tracks with display metadata (artist and album names)", async () => {
    const overview = await getLibraryOverview(userId, {}, prisma);
    expect(overview.recent[0].track.artistName).toBe(trackOne.artistName);
    expect(overview.recent[0].track.albumName).toBe(trackOne.albumName);
    expect(overview.liked[0].track.title).toBe(trackOne.title);
  });

  it("orders recently played most recent first", async () => {
    const overview = await getLibraryOverview(userId, {}, prisma);
    expect(overview.recent.map((entry) => entry.track.id)).toEqual([
      trackOne.id,
      trackTwo.id,
    ]);
  });

  it("honors recentLimit", async () => {
    const overview = await getLibraryOverview(userId, { recentLimit: 1 }, prisma);
    expect(overview.recent).toHaveLength(1);
    expect(overview.recent[0].track.id).toBe(trackOne.id);
  });

  it("honors likedLimit", async () => {
    await likeTrack(userId, trackThree, prisma);
    const overview = await getLibraryOverview(userId, { likedLimit: 1 }, prisma);
    expect(overview.liked).toHaveLength(1);
    expect(overview.liked[0].track.id).toBe(trackThree.id);
  });

  it("excludes other users' data", async () => {
    const overview = await getLibraryOverview(userId, {}, prisma);
    const strangerOverview = await getLibraryOverview(strangerId, {}, prisma);
    expect(overview.playlists.some((playlist) => playlist.title === "Stranger Mix")).toBe(false);
    expect(strangerOverview.playlists.some((playlist) => playlist.title === "Stranger Mix")).toBe(true);
  });
});

describe("getOwnedPlaylist", () => {
  it("returns the owner's playlist with ordered items", async () => {
    const playlist = await createPlaylist(userId, { title: "Owner Mix", description: "mine" }, prisma);
    await addTrackToPlaylist(userId, playlist.id, trackOne, prisma);
    await addTrackToPlaylist(userId, playlist.id, trackTwo, prisma);

    const owned = await getOwnedPlaylist(userId, playlist.id, prisma);
    expect(owned).not.toBeNull();
    expect(owned?.items.map((item) => item.trackId)).toEqual([trackOne.id, trackTwo.id]);
  });

  it("returns null for a playlist owned by someone else", async () => {
    const strangerPlaylist = await createPlaylist(strangerId, { title: "Private" }, prisma);
    await expect(getOwnedPlaylist(userId, strangerPlaylist.id, prisma)).resolves.toBeNull();
  });

  it("returns null for a missing playlist", async () => {
    await expect(getOwnedPlaylist(userId, "missing-playlist", prisma)).resolves.toBeNull();
  });
});