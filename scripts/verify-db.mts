import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to verify the database");
}

let adapter;
if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
  adapter = new PrismaPg({ connectionString: url });
} else {
  throw new Error(
    `Unsupported DATABASE_URL scheme: ${url}. ` +
      `Expected "postgresql://" or "postgres://"`,
  );
}

const db = new PrismaClient({ adapter });

const MODELS = [
  "user",
  "account",
  "session",
  "verificationToken",
  "artist",
  "album",
  "track",
  "like",
  "follow",
  "recentlyPlayed",
  "searchHistory",
  "playlist",
  "playlistTrack",
  "playbackState",
] as const;

function report(label: string, value: unknown): void {
  console.log(`${label}: ${String(value)}`);
}

async function main(): Promise<void> {
  await db.$connect();
  // Never print the connection string: credentials travel in it.
  console.log("connected to postgresql database");

  for (const model of MODELS) {
    const count = await (db[model] as { count(): Promise<number> }).count();
    report(model, count);
  }

  const provider = "smoke-verify";
  const trackId = await db.track.upsert({
    where: {
      provider_providerTrackId: { provider, providerTrackId: "smoke-track" },
    },
    create: {
      provider,
      providerTrackId: "smoke-track",
      title: "Smoke Track",
      duration: 1,
      artist: {
        create: {
          provider,
          providerArtistId: "smoke-artist",
          name: "Smoke Artist",
        },
      },
    },
    update: { title: "Smoke Track" },
    include: { artist: true },
  });
  report("smoke track", `${trackId.title} by ${trackId.artist.name} (${trackId.id})`);

  await db.track.deleteMany({ where: { provider } });
  await db.artist.deleteMany({ where: { provider } });
  report("smoke cleanup", "deleted");

  await db.$disconnect();
  console.log("verify-db OK");
}

main().catch((error) => {
  console.error("verify-db FAILED:", error);
  process.exitCode = 1;
});
