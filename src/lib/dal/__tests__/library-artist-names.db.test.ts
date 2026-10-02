import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  getLibraryArtistNames,
  getLibraryOverview,
} from "@/lib/dal/library";
import { likeTrack } from "@/lib/dal/like";
import { recordPlayed } from "@/lib/dal/recently-played";
import {
  addTrackToPlaylist,
  createPlaylist,
} from "@/lib/dal/playlist";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();
let userId: string;

// `makeTrack` gives track N the artist `Artist N`, so the fixture's artist
// names are predictable from the index and the ordering assertions below stay
// readable.
const trackOne = dbTest.makeTrack(namespace, 1);
const trackTwo = dbTest.makeTrack(namespace, 2);
const trackThree = dbTest.makeTrack(namespace, 3);

const ARTIST_ONE = trackOne.artistName;
const ARTIST_TWO = trackTwo.artistName;
const ARTIST_THREE = trackThree.artistName;

beforeAll(async () => {
  userId = await dbTest.createUser("artist-names-owner");

  // Two likes, and three plays with distinct timestamps so "newest first" is
  // actually decidable.
  await likeTrack(userId, trackThree, prisma);
  await likeTrack(userId, trackOne, prisma);

  await recordPlayed(userId, trackOne, prisma, new Date("2026-05-01T00:00:00.000Z"));
  await recordPlayed(userId, trackTwo, prisma, new Date("2026-05-02T00:00:00.000Z"));
  await recordPlayed(userId, trackThree, prisma, new Date("2026-05-03T00:00:00.000Z"));

  // Deliberately unrelated to the signals, and present so the "reads nothing
  // about playlists" test below distinguishes a skipped query from an empty
  // result.
  const playlist = await createPlaylist(userId, { title: "Unrelated Mix" }, prisma);
  await addTrackToPlaylist(userId, playlist.id, trackOne, prisma);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await dbTest.cleanup(namespace);
});

describe("getLibraryArtistNames", () => {
  it("agrees with the rendering read on artist names", async () => {
    // The whole justification for this projection is that it is a cheaper way
    // to get the same answer - which is only true if it is the SAME answer. So
    // this compares against `getLibraryOverview` rather than against a
    // hand-written expectation that could drift from what callers used to see.
    const options = { likedLimit: 20, recentLimit: 10 };
    const [narrow, overview] = await Promise.all([
      getLibraryArtistNames(userId, options, prisma),
      getLibraryOverview(userId, { ...options, playlistLimit: 0 }, prisma),
    ]);

    // Compared as sets, because both callers immediately de-duplicate the
    // names; the projection returns one entry per ROW, the rendering read one
    // entry per SURVIVING row.
    expect(new Set(narrow.recentArtists)).toEqual(
      new Set(overview.recent.map((entry) => entry.track.artistName)),
    );
    expect(new Set(narrow.likedArtists)).toEqual(
      new Set(overview.liked.map((entry) => entry.track.artistName)),
    );

    // Spot-check that it really read the rows, so this cannot pass by
    // comparing two empty lists. `playedAt` is set explicitly per row, so the
    // history order below is decidable.
    expect(narrow.recentArtists).toEqual([ARTIST_THREE, ARTIST_TWO, ARTIST_ONE]);
    // The two likes were created in the same millisecond, so `createdAt desc`
    // has no tiebreak and their relative order is genuinely undefined. Compared
    // as a set for that reason - asserting an order here would be asserting
    // Postgres' arbitrary choice.
    expect(new Set(narrow.likedArtists)).toEqual(new Set([ARTIST_THREE, ARTIST_ONE]));
  });

  it("returns names even when the same artist appears in several rows", async () => {
    // The projection de-duplicates at the CALLER, not here, so one artist
    // legitimately arrives twice. Pinning that so a future "helpfully"
    // de-duplicating inside this function is caught rather than assumed safe.
    const repeat = await dbTest.createUser("artist-names-repeat");
    try {
      await likeTrack(repeat, trackOne, prisma);
      await likeTrack(repeat, trackOne, prisma);
      await recordPlayed(repeat, trackOne, prisma, new Date("2026-05-02T00:00:00.000Z"));
      await recordPlayed(repeat, trackOne, prisma, new Date("2026-05-01T00:00:00.000Z"));

      const names = await getLibraryArtistNames(repeat, {}, prisma);
      // `@@unique([userId, trackId])` makes the repeat play one row, and the
      // canonical check makes the repeat like one row - so the answer is the
      // same whether or not the caller de-duplicates, which is what makes the
      // no-collapse shortcut safe here.
      expect(new Set(names.recentArtists)).toEqual(new Set([ARTIST_ONE]));
      expect(new Set(names.likedArtists)).toEqual(new Set([ARTIST_ONE]));
    } finally {
      await prisma.user.deleteMany({ where: { id: repeat } });
    }
  });

  it("reads nothing about playlists", async () => {
    const withPlaylists = await getLibraryOverview(userId, {}, prisma);
    const withoutPlaylists = await getLibraryOverview(
      userId,
      { playlistLimit: 0 },
      prisma,
    );
    // The fixture owns a playlist holding a track, so this distinguishes
    // "skipped the query" from "there was nothing there anyway".
    expect(withPlaylists.playlists).toHaveLength(1);
    expect(withoutPlaylists.playlists).toHaveLength(0);

    // And the categories the caller did ask for are untouched by the skip.
    expect(withoutPlaylists.recent).toEqual(withPlaylists.recent);
    expect(withoutPlaylists.liked).toEqual(withPlaylists.liked);
  });

  it("honors an explicit limit", async () => {
    const capped = await getLibraryArtistNames(
      userId,
      { likedLimit: 1, recentLimit: 1 },
      prisma,
    );
    expect(capped.likedArtists).toHaveLength(1);
    // `recentLimit * 2` over-read, matching the rendering read's window.
    expect(capped.recentArtists.length).toBeLessThanOrEqual(2);
  });

  it("returns empty lists for a listener with no history", async () => {
    const empty = await dbTest.createUser("artist-names-empty");
    try {
      expect(await getLibraryArtistNames(empty, {}, prisma)).toEqual({
        recentArtists: [],
        likedArtists: [],
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: empty } });
    }
  });

  it("excludes other listeners' artists", async () => {
    const stranger = await dbTest.createUser("artist-names-stranger");
    try {
      await likeTrack(stranger, trackTwo, prisma);
      const seen = await getLibraryArtistNames(stranger, {}, prisma);
      expect(seen.likedArtists).toEqual([ARTIST_TWO]);
      expect(seen.recentArtists).toEqual([]);
    } finally {
      await prisma.user.deleteMany({ where: { id: stranger } });
    }
  });
});