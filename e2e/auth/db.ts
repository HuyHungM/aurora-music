/**
 * Test-database access for the authenticated E2E harness (Phase 30).
 *
 * Uses the SAME database the E2E server uses (DATABASE_URL) so seeded
 * rows are real to the application. Only synthetic `aurora.test`
 * identities and the `e2e-` fixture catalog are ever created; cleanup
 * deletes exactly those rows and nothing else.
 *
 * Relative imports only: Playwright's transform does not resolve the
 * `@/` alias, so the generated Prisma client is imported by path.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { E2E_LOCALE, FIXTURE_ARTIST, FIXTURE_CROSS_PROVIDER_TRACKS, FIXTURE_TRACKS, TEST_USERS } from "./constants";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function createTestClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Authenticated E2E setup requires DATABASE_URL (same database the E2E server uses).",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

let client: PrismaClient | null = null;

export function getTestClient(): PrismaClient {
  if (!client) {
    client = createTestClient();
  }
  return client;
}

export async function closeTestClient(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export interface AuthTestData {
  userAId: string;
  userBId: string;
}

/**
 * Idempotent seed: upserts the two synthetic users and the fixture
 * catalog. Safe to run before every E2E invocation.
 */
export async function ensureAuthTestData(): Promise<AuthTestData> {
  const prisma = getTestClient();

  const users = await Promise.all(
    TEST_USERS.map((user) =>
      prisma.user.upsert({
        where: { email: user.email },
        // Re-asserted on every run so a stale locale can never leak in
        // from an earlier seed: the authenticated specs assert English
        // accessible names (see E2E_LOCALE).
        update: { name: user.name, locale: E2E_LOCALE },
        create: { email: user.email, name: user.name, locale: E2E_LOCALE },
        select: { id: true, email: true },
      }),
    ),
  );

  const artist = await prisma.artist.upsert({
    where: {
      provider_providerArtistId: {
        provider: FIXTURE_ARTIST.provider,
        providerArtistId: FIXTURE_ARTIST.providerArtistId,
      },
    },
    update: { name: FIXTURE_ARTIST.name },
    create: {
      provider: FIXTURE_ARTIST.provider,
      providerArtistId: FIXTURE_ARTIST.providerArtistId,
      name: FIXTURE_ARTIST.name,
    },
    select: { id: true },
  });

  await Promise.all(
    [...FIXTURE_TRACKS, ...FIXTURE_CROSS_PROVIDER_TRACKS].map((track) =>
      prisma.track.upsert({
        where: {
          provider_providerTrackId: {
            provider: track.provider,
            providerTrackId: track.providerTrackId,
          },
        },
        update: { title: track.title, artistId: artist.id },
        create: {
          provider: track.provider,
          providerTrackId: track.providerTrackId,
          title: track.title,
          artistId: artist.id,
        },
        select: { id: true },
      }),
    ),
  );

  const userA = users.find((u) => u.email === TEST_USERS[0].email);
  const userB = users.find((u) => u.email === TEST_USERS[1].email);
  if (!userA || !userB) {
    throw new Error("Authenticated E2E setup failed to seed test users.");
  }
  return { userAId: userA.id, userBId: userB.id };
}

/**
 * Removes exactly the synthetic rows. User deletion cascades to likes,
 * follows, history, playlists, and playback state; artist deletion
 * cascades to fixture tracks and their memberships/likes.
 */
export async function cleanupAuthTestData(): Promise<void> {
  const prisma = getTestClient();
  await prisma.user.deleteMany({
    where: { email: { in: TEST_USERS.map((u) => u.email) } },
  });
  await prisma.artist.deleteMany({
    where: {
      provider: FIXTURE_ARTIST.provider,
      providerArtistId: FIXTURE_ARTIST.providerArtistId,
    },
  });
}

export interface AuthTestArtifactCounts {
  users: number;
  playlists: number;
  playlistTracks: number;
  likes: number;
  fixtureTracks: number;
  total: number;
}

/** Counts leftover synthetic rows for post-run integrity verification. */
export async function countAuthTestArtifacts(): Promise<AuthTestArtifactCounts> {
  const prisma = getTestClient();
  const emails = TEST_USERS.map((u) => u.email);
  const [users, playlists, playlistTracks, likes, fixtureTracks] =
    await Promise.all([
      prisma.user.count({ where: { email: { in: emails } } }),
      prisma.playlist.count({ where: { user: { email: { in: emails } } } }),
      prisma.playlistTrack.count({
        where: { playlist: { user: { email: { in: emails } } } },
      }),
      prisma.like.count({ where: { user: { email: { in: emails } } } }),
      prisma.track.count({
        where: {
          provider: FIXTURE_ARTIST.provider,
          providerTrackId: { startsWith: "e2e-" },
        },
      }),
    ]);
  return {
    users,
    playlists,
    playlistTracks,
    likes,
    fixtureTracks,
    total: users + playlists + playlistTracks + likes + fixtureTracks,
  };
}

/** Ordered playlist track titles for order assertions (read-only). */
export async function getPlaylistTrackTitles(
  playlistId: string,
): Promise<string[]> {
  const prisma = getTestClient();
  const rows = await prisma.playlistTrack.findMany({
    where: { playlistId },
    include: { track: true },
    orderBy: { position: "asc" },
  });
  return rows.map((row) => row.track.title);
}

/** Raw persisted queue snapshot JSON for the user (null when no row). */
export async function getQueueSnapshotRaw(
  email: string,
): Promise<unknown> {
  const prisma = getTestClient();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    return null;
  }
  const row = await prisma.playbackState.findUnique({
    where: { userId: user.id },
  });
  return row?.queueSnapshot ?? null;
}

/** Whether the user (by email) currently follows the fixture artist. */
export async function isArtistFollowedByEmail(
  email: string,
): Promise<boolean> {
  const prisma = getTestClient();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    return false;
  }
  const artist = await prisma.artist.findUnique({
    where: {
      provider_providerArtistId: {
        provider: FIXTURE_ARTIST.provider,
        providerArtistId: FIXTURE_ARTIST.providerArtistId,
      },
    },
    select: { id: true },
  });
  if (!artist) {
    return false;
  }
  const count = await prisma.follow.count({
    where: { userId: user.id, artistId: artist.id },
  });
  return count > 0;
}

/** Whether the user (by email) currently likes the track. */
export async function isTrackLikedByEmail(
  email: string,
  providerTrackId: string,
): Promise<boolean> {
  const prisma = getTestClient();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    return false;
  }
  const track = await prisma.track.findUnique({
    where: {
      provider_providerTrackId: {
        provider: FIXTURE_TRACKS[0].provider,
        providerTrackId,
      },
    },
    select: { id: true },
  });
  if (!track) {
    return false;
  }
  const count = await prisma.like.count({
    where: { userId: user.id, trackId: track.id },
  });
  return count > 0;
}
