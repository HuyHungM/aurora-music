/** Temporary QA probe: pick one real provider id for manual route checks. */
import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const track = await db.track.findFirst({
  select: { id: true, provider: true, providerTrackId: true, title: true },
});
const artist = await db.artist.findFirst({
  select: { id: true, name: true, providerArtistId: true },
});
console.log(JSON.stringify({ track, artist }));
await db.$disconnect();
