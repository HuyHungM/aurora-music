/**
 * Mission-3 investigation probe: count the duplicate-shaped rows the failing
 * canonical-dedupe journeys collide with. Read-only; deleted after use.
 */
import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const users = await db.user.findMany({
  select: {
    id: true,
    email: true,
    playlists: { select: { id: true, title: true } },
    likes: { select: { id: true } },
    recentlyPlayed: { select: { id: true } },
    playbackState: { select: { id: true } },
  },
  orderBy: { email: "asc" },
});

const fixtureTitles = await db.track.groupBy({
  by: ["title"],
  _count: { _all: true },
  having: { title: { startsWith: "Aurora E2E" } },
});

const e2eLibraryTracks = await db.track.findMany({
  where: { id: { startsWith: "e2e" } },
  select: { id: true, title: true, provider: true, providerTrackId: true },
  orderBy: { title: "asc" },
});

const playlistsWithTracks = await db.playlist.findMany({
  select: { title: true, user: { select: { email: true } }, _count: { select: { tracks: true } } },
  orderBy: { title: "asc" },
});

console.log(
  JSON.stringify(
    {
      users: users.map((u) => ({
        email: u.email,
        playlists: u.playlists.length,
        playlistTitles: u.playlists.map((p) => p.title),
        likes: u.likes.length,
        recentlyPlayed: u.recentlyPlayed.length,
      })),
      fixtureTitleCounts: fixtureTitles.map((t) => `${t.title} x${t._count._all}`),
      e2eLibraryTrackCount: e2eLibraryTracks.length,
      e2eLibraryTracks: e2eLibraryTracks.map(
        (t) => `${t.id} | ${t.title} | ${t.provider}:${t.providerTrackId}`,
      ),
      playlists: playlistsWithTracks.map(
        (p) => `${p.user.email} :: ${p.title} (${p._count.tracks} tracks)`,
      ),
    },
    null,
    2,
  ),
);

await db.$disconnect();
