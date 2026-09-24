import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  followArtist,
  isFollowing,
  listUserFollows,
  unfollowArtist,
} from "@/lib/dal/follow";
import {
  isTrackLiked,
  likeTrack,
  listUserLikes,
  unlikeTrack,
} from "@/lib/dal/like";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();
let userId: string;

const trackOne = dbTest.makeTrack(namespace, 1);
const trackTwo = dbTest.makeTrack(namespace, 2);

const trackRef = (track: ReturnType<typeof dbTest.makeTrack>) => ({
  provider: track.provider as string,
  providerTrackId: track.id,
});

const artistRef = (artist: ReturnType<typeof dbTest.makeArtist>) => ({
  provider: artist.provider as string,
  providerArtistId: artist.id,
});

beforeAll(async () => {
  userId = await dbTest.createUser("likes");
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await dbTest.cleanup(namespace);
});

describe("likeTrack / unlikeTrack", () => {
  it("likes a track and reports it as liked", async () => {
    await likeTrack(userId, trackOne, prisma);
    await expect(isTrackLiked(userId, trackRef(trackOne), prisma)).resolves.toBe(true);
  });

  it("is idempotent when the track is already liked", async () => {
    await likeTrack(userId, trackOne, prisma);
    await expect(isTrackLiked(userId, trackRef(trackOne), prisma)).resolves.toBe(true);
  });

  it("lists likes in provider-space, most recent first", async () => {
    await likeTrack(userId, trackTwo, prisma);
    const likes = await listUserLikes(userId, {}, prisma);
    expect(likes.map((like) => like.trackId)).toEqual([trackTwo.id, trackOne.id]);
    expect(likes[0].provider).toBe(namespace);
  });

  it("reports an unknown track as not liked", async () => {
    await expect(
      isTrackLiked(userId, { provider: namespace, providerTrackId: "missing" }, prisma),
    ).resolves.toBe(false);
  });

  it("unlikes a track", async () => {
    await unlikeTrack(userId, trackRef(trackOne), prisma);
    await expect(isTrackLiked(userId, trackRef(trackOne), prisma)).resolves.toBe(false);
  });

  it("unlike is a no-op for tracks not liked", async () => {
    await expect(unlikeTrack(userId, trackRef(trackOne), prisma)).resolves.toBeUndefined();
  });
});

describe("followArtist / unfollowArtist", () => {
  const artist = dbTest.makeArtist(namespace, 1);

  it("follows an artist and reports it as followed", async () => {
    await followArtist(userId, artist, prisma);
    await expect(isFollowing(userId, artistRef(artist), prisma)).resolves.toBe(true);
  });

  it("is idempotent when already following", async () => {
    await followArtist(userId, artist, prisma);
    await expect(
      prisma.follow.count({ where: { userId, artist: { provider: namespace } } }),
    ).resolves.toBe(1);
  });

  it("lists follows with provider-space identifiers", async () => {
    const follows = await listUserFollows(userId, {}, prisma);
    expect(follows.map((follow) => follow.artistId)).toEqual(["artist-1"]);
    expect(follows[0].provider).toBe(namespace);
  });

  it("unfollows an artist", async () => {
    await unfollowArtist(userId, artistRef(artist), prisma);
    await expect(isFollowing(userId, artistRef(artist), prisma)).resolves.toBe(false);
  });

  it("unfollow is a no-op when not followed", async () => {
    await expect(unfollowArtist(userId, artistRef(artist), prisma)).resolves.toBeUndefined();
  });
});