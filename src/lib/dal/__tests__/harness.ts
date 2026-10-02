import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/config/env";
import { buildDatabaseAdapterConfig } from "@/lib/db-tls";
import { PrismaClient } from "@/generated/prisma/client";
import type { Artist, Track } from "@/lib/domain";

function providerNamespace(): string {
  return `db-test-${randomUUID()}`;
}

async function createUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${label}-${randomUUID()}@example.com` },
  });
  return user.id;
}

function makeArtist(providerNamespace: string, index: number): Artist {
  return {
    id: `artist-${index}`,
    provider: providerNamespace as Artist["provider"],
    name: `Artist ${index}`,
    image: `https://img/artist-${index}.jpg`,
    genres: ["rock"],
  };
}

function makeTrack(providerNamespace: string, index: number): Track {
  return {
    id: `track-${providerNamespace}-${index}`,
    provider: providerNamespace as Track["provider"],
    title: `Track ${index}`,
    artistId: `artist-${index}`,
    artistName: `Artist ${index}`,
    albumId: `album-${index}`,
    albumName: `Album ${index}`,
    artworkUrl: `https://img/track-${index}.jpg`,
    streamUrl: `https://stream/track-${index}.mp3`,
    previewUrl: `https://preview/track-${index}.mp3`,
    duration: 180 + index,
    genres: ["jazz", "blues"],
    releaseDate: "2026-01-01",
    providerUrl: `https://jamendo.com/track/${index}`,
    explicit: false,
    metadata: { popularity: index },
  };
}

/**
 * A track from a REAL source provider, for cross-provider dedupe tests.
 *
 * `makeTrack` deliberately uses a random namespace as its `provider`, which is
 * not one of the three production source types - so `toTrackIdentity` refuses
 * it and the canonical matcher can never see it. A test that needs the matcher
 * tier (the Spotify and Deezer renderings of ONE recording) therefore cannot
 * use `makeTrack`: it needs a real provider AND a namespaced id, so
 * `cleanup` can still find and remove the row.
 *
 * `group` is the logical recording: tracks sharing a group number carry the
 * same title, artist and duration, so the matcher sees one song. `index`
 * makes the provider-scoped id unique, because two rows with the same
 * `(provider, providerTrackId)` would be the same row, not two renderings.
 */
function makeProviderTrack(
  providerNamespace: string,
  provider: "youtube" | "spotify" | "deezer",
  group: number,
  index: number,
): Track {
  // The id carries the GROUP as well as the index, so two recordings never
  // share a provider id even when a test file reuses an index number. A
  // collision would silently substitute a different recording and turn a
  // dedupe assertion into a test of nothing.
  const id = `ptrack-${providerNamespace}-${provider}-g${group}-${index}`;
  return {
    id,
    provider,
    providerTrackId: id,
    title: `Shared Song ${group}`,
    artistId: `partist-${providerNamespace}-${group}`,
    artistName: `Shared Artist ${group}`,
    albumId: `palbum-${providerNamespace}-${group}`,
    albumName: `Shared Album ${group}`,
    duration: 180 + group,
    providerUrl: `https://${provider}.example/track/g${group}/${index}`,
  };
}

async function cleanup(namespace: string): Promise<void> {
  await prisma.track.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        // Cross-provider fixtures carry a real provider, so they can only be
        // found through the namespaced provider id.
        { providerTrackId: { startsWith: `ptrack-${namespace}-` } },
      ],
    },
  });
  await prisma.album.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        { providerAlbumId: { startsWith: `palbum-${namespace}-` } },
      ],
    },
  });
  await prisma.follow.deleteMany({
    where: { artist: { provider: { startsWith: namespace } } },
  });
  await prisma.artist.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        { providerArtistId: { startsWith: `partist-${namespace}-` } },
      ],
    },
  });
}

/**
 * Bulk-creates a playlist with memberships already at `positions`, in four
 * round trips, and returns its id.
 *
 * WHY THIS EXISTS, since "call `addTrackToPlaylist` in a loop" is the obvious
 * alternative. That costs about nine sequential round trips per track: an
 * ownership read, a catalog upsert, and a five-statement transaction. Measured
 * against this project's configured Postgres - a remote host - one round trip
 * is ~296 ms, so the loop costs ~2.7 s per track and a fifteen-track fixture
 * spent forty seconds in setup before a single assertion ran. That is not a slow
 * test, it is a test that cannot finish: it is why
 * `playlist-positions.db.test.ts` originally failed on the suite's timeout
 * rather than on anything to do with the behaviour it was written to check.
 *
 * Four `createMany` calls put the same rows in place for roughly a second.
 *
 * WHAT IT IS NOT FOR. This writes storage directly, so it proves nothing about
 * the membership WRITE path - it cannot, since it bypasses it. Use it to arrange
 * a starting state, and exercise the write path through the DAL where that is
 * the subject. `playlist-density.db.test.ts` makes exactly that split: appends
 * through `addTrackToPlaylist` where the append path is the claim, bulk seeding
 * where it is only the starting point.
 *
 * The four calls are a referential dependency - artists before tracks before
 * memberships - so they are deliberately sequential.
 * `cleanup(namespace)` removes every row created here, by provider.
 */
async function seedPlaylistAtPositions(
  userId: string,
  tracks: readonly Track[],
  positions: readonly number[],
  options: { title?: string } = {},
): Promise<string> {
  await prisma.artist.createMany({
    data: tracks.map((track) => ({
      id: track.artistId,
      provider: track.provider,
      providerArtistId: track.artistId,
      name: track.artistName,
    })),
  });
  await prisma.track.createMany({
    data: tracks.map((track) => ({
      id: track.id,
      provider: track.provider,
      providerTrackId: track.providerTrackId ?? track.id,
      title: track.title,
      artistId: track.artistId,
      duration: track.duration ?? null,
    })),
  });
  const playlist = await prisma.playlist.create({
    data: { userId, title: options.title ?? "Seeded" },
  });
  await prisma.playlistTrack.createMany({
    data: tracks.map((track, index) => ({
      playlistId: playlist.id,
      trackId: track.id,
      position: positions[index] ?? index,
    })),
  });
  return playlist.id;
}

/**
 * Seeds `tracks` as this user's recent plays at `playedAts`, in three round
 * trips, and returns the created rows.
 *
 * Same reasoning as `seedPlaylistAtPositions`, for the same reason: arranging 55
 * plays through `recordPlayed` is 55 sequential calls of six to eight round
 * trips each, so a trim assertion that needs a user sitting exactly on the limit
 * cannot be set up in a test at all - it fails on the suite timeout long before
 * it reaches an assertion. These rows are written directly, which proves nothing
 * about the write path; the measured or asserted call is always a real
 * `recordPlayed`.
 *
 * Only artists and tracks are seeded. `albumId` is nullable, and leaving it null
 * keeps this to two catalog calls plus the insert without changing what the trim
 * reads.
 */
async function seedRecentPlays(
  userId: string,
  tracks: readonly Track[],
  playedAts: readonly Date[],
): Promise<Array<{ id: string; trackId: string }>> {
  await prisma.artist.createMany({
    data: tracks.map((track) => ({
      id: track.artistId,
      provider: track.provider,
      providerArtistId: track.artistId,
      name: track.artistName,
    })),
  });
  await prisma.track.createMany({
    data: tracks.map((track) => ({
      id: track.id,
      provider: track.provider,
      providerTrackId: track.providerTrackId ?? track.id,
      title: track.title,
      artistId: track.artistId,
    })),
  });
  return prisma.recentlyPlayed.createManyAndReturn({
    data: tracks.map((track, index) => ({
      userId,
      trackId: track.id,
      playedAt: playedAts[index] ?? new Date(),
    })),
    select: { id: true, trackId: true },
  });
}

/**
 * A second Prisma client wired to Prisma's `query` event, so a test can assert
 * HOW MANY round trips a DAL call makes.
 *
 * This exists because counting statements is the only honest way to pin the
 * ABSENCE of a redundant query. Behaviour alone cannot do it: "the same 50 rows
 * survived" is equally true of the efficient implementation and of one that got
 * there after an extra trip to the database. It is deliberately a separate
 * client rather than a flag on the shared `prisma`, which is a production
 * singleton and would make every test in the suite pay for query logging.
 *
 * TLS is resolved through the same `getEnv` plus `buildDatabaseAdapterConfig`
 * pair `src/lib/db.ts` uses, so this client reaches the same database the same
 * way and cannot quietly connect to somewhere else. `recordPlayed` already
 * accepts a `db` argument, so pointing it here needs no production change and
 * exposes no internal purely so a test can inspect it.
 */
function queryCounter(): {
  db: PrismaClient;
  /** Statements issued since the previous call, which also resets. */
  take(): string[];
  dispose(): Promise<void>;
} {
  let seen: string[] = [];
  const env = getEnv();
  const counter = new PrismaClient({
    adapter: new PrismaPg(
      buildDatabaseAdapterConfig({
        url: env.DATABASE_URL,
        caCertPath: env.AURORA_DATABASE_CA_CERT_PATH,
        caCert: env.AURORA_DATABASE_CA_CERT,
        nodeEnv: env.NODE_ENV,
      }),
    ),
    log: [{ emit: "event", level: "query" }],
  });
  counter.$on("query", (event: { query: string }) => {
    seen.push(event.query);
  });
  return {
    db: counter,
    take: () => {
      const out = [...seen];
      seen = [];
      return out;
    },
    dispose: () => counter.$disconnect(),
  };
}

export const dbTest = {
  providerNamespace,
  createUser,
  makeArtist,
  makeTrack,
  makeProviderTrack,
  cleanup,
  seedPlaylistAtPositions,
  seedRecentPlays,
  queryCounter,
  prisma,
};