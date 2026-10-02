import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "../src/lib/config/env";
import { buildDatabaseAdapterConfig } from "../src/lib/db-tls";
import { PrismaClient } from "../src/generated/prisma/client";
import { recordPlayed } from "../src/lib/dal/recently-played";
import type { Track } from "@/lib/domain";

/**
 * `recordPlayed` trim benchmark.
 *
 * Run with: `bun --env-file=.env scripts/bench-record-played.mts`
 *
 * WHAT IT MEASURES, and why it needs its own client. `recordPlayed` accepts a
 * `db` argument precisely so it can be pointed at an instrumented client, so
 * this script counts real SQL statements through Prisma's `query` event rather
 * than asserting on anything the production code exposes for the purpose. One
 * query event is one round trip, which is the unit that actually costs money
 * against the remote Postgres this project is configured against.
 *
 * WHY SEEDING BYPASSES `recordPlayed`. Arranging 55 rows through the write path
 * is 55 sequential calls of ~6-8 round trips each - about two and a half
 * minutes per repetition, for every scenario, before a single measurement is
 * taken. The rows are written directly instead, which is the same split
 * `playlist-density.db.test.ts` makes: use the write path where the write path
 * is the claim, and arrange a starting state directly where it is not. The
 * measured call is always the real `recordPlayed`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It asserts nothing. Absolute timings here
 * are a property of one network path to one remote host and are not a contract;
 * the round-trip COUNT is the durable result, and the behavioural equivalence
 * between the two algorithms is asserted separately in the DB suite.
 */

/** Matches `RECENT_LIMIT` in `src/lib/dal/recently-played.ts`. */
const RECENT_LIMIT = 50;
const REPETITIONS = 7;

const env = getEnv();
const db = new PrismaClient({
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

/** Statements issued while a measurement is in progress. */
let captured: string[] = [];
db.$on("query", (event: { query: string }) => {
  captured.push(event.query);
});

const namespace = `bench-rp-${Date.now()}`;

const artistIdFor = (index: number): string => `${namespace}-artist-${index}`;
const albumIdFor = (index: number): string => `${namespace}-album-${index}`;
const trackIdFor = (index: number): string => `${namespace}-track-${index}`;

function makeTrack(index: number): Track {
  return {
    id: trackIdFor(index),
    provider: "youtube",
    providerTrackId: trackIdFor(index),
    title: `Bench Song ${index}`,
    artistId: artistIdFor(index),
    artistName: `Bench Artist ${index}`,
    albumId: albumIdFor(index),
    albumName: `Bench Album ${index}`,
    artworkUrl: `https://img/bench-${index}.jpg`,
    streamUrl: "https://stream/bench.mp3",
    previewUrl: "https://preview/bench.mp3",
    duration: 180,
    providerUrl: `https://youtube.example/watch?v=bench-${index}`,
    explicit: false,
  } as Track;
}

/** Writes the catalog rows `recentlyPlayed` needs as foreign keys. */
async function seedCatalog(indices: readonly number[]): Promise<void> {
  await db.artist.createMany({
    data: indices.map((index) => ({
      id: artistIdFor(index),
      provider: "youtube",
      providerArtistId: artistIdFor(index),
      name: `Bench Artist ${index}`,
    })),
  });
  await db.album.createMany({
    data: indices.map((index) => ({
      id: albumIdFor(index),
      provider: "youtube",
      providerAlbumId: albumIdFor(index),
      name: `Bench Album ${index}`,
      artistId: artistIdFor(index),
    })),
  });
  await db.track.createMany({
    data: indices.map((index) => ({
      id: trackIdFor(index),
      provider: "youtube",
      providerTrackId: trackIdFor(index),
      title: `Bench Song ${index}`,
      artistId: artistIdFor(index),
      albumId: albumIdFor(index),
    })),
  });
}

/** Base timestamp; each row is one minute older than the last, newest first. */
function playedAtFor(index: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - index * 60_000);
}

interface Scenario {
  label: string;
  /** How many `recentlyPlayed` rows to seed before the measured call. */
  seed: number;
  /** Index of the track played. Existing = replay, beyond the seed = new row. */
  playIndex: number;
  expectsTrim: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { label: "empty (first play)", seed: 0, playIndex: 0, expectsTrim: false },
  { label: "below limit", seed: RECENT_LIMIT - 40, playIndex: 0, expectsTrim: false },
  {
    label: "exactly at limit (replay)",
    seed: RECENT_LIMIT,
    playIndex: 0,
    expectsTrim: false,
  },
  {
    label: "one over limit (new track)",
    seed: RECENT_LIMIT,
    playIndex: RECENT_LIMIT + 450,
    expectsTrim: true,
  },
  {
    label: "well over limit (replay)",
    seed: RECENT_LIMIT + 5,
    playIndex: 0,
    expectsTrim: true,
  },
];

interface Sample {
  totalQueries: number;
  recentQueries: number;
  elapsedMs: number;
  rowsBefore: number;
  rowsAfter: number;
  deleted: number;
  added: number;
  retained: string;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // An even count averages the two central values; an odd count has one, and
  // reading past it would make the whole figure NaN.
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Row ids for the user, newest first. Read OUTSIDE any measured window. */
async function rowIds(userId: string): Promise<string[]> {
  const rows = await db.recentlyPlayed.findMany({
    where: { userId },
    orderBy: [{ playedAt: "desc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * A fingerprint of WHICH tracks survived and in what order.
 *
 * Deliberately keyed on `trackId` and not `id`. Row ids are regenerated cuids on
 * every rep because each rep reseeds, so comparing them across repetitions
 * compares noise; the track ids are stable, which is what makes two runs of two
 * different algorithms comparable for behavioural equivalence rather than merely
 * both returning 50 rows.
 */
async function retainedFingerprint(userId: string): Promise<string> {
  const rows = await db.recentlyPlayed.findMany({
    where: { userId },
    orderBy: [{ playedAt: "desc" }, { id: "asc" }],
    select: { trackId: true },
  });
  return rows.map((row) => row.trackId).join(",");
}

const out: string[] = [];
const summary: Array<Record<string, string | number | boolean>> = [];
const fingerprints: Array<{ label: string; value: string }> = [];
const user = await db.user.create({
  data: { email: `bench-rp-${Date.now()}@example.com` },
});

const seedIndices = Array.from({ length: 60 }, (_, i) => i);
await seedCatalog(seedIndices);
out.push(`seeded catalog rows for ${seedIndices.length} tracks`);
out.push("");

try {
  for (const scenario of SCENARIOS) {
    const samples: Sample[] = [];

    for (let rep = 0; rep < REPETITIONS; rep += 1) {
      // Reset to the exact starting state for THIS repetition, so the measured
      // call always sees the same number of rows. Seeding is deliberately
      // outside the measured window.
      await db.recentlyPlayed.deleteMany({ where: { userId: user.id } });
      if (scenario.seed > 0) {
        await db.recentlyPlayed.createMany({
          data: Array.from({ length: scenario.seed }, (_, i) => ({
            userId: user.id,
            trackId: trackIdFor(i),
            playedAt: playedAtFor(i),
          })),
        });
      }
      const beforeIds = await rowIds(user.id);
      const rowsBefore = beforeIds.length;

      captured = [];
      const started = performance.now();
      await recordPlayed(user.id, makeTrack(scenario.playIndex), db, playedAtFor(-1));
      const elapsedMs = performance.now() - started;
      const queries = [...captured];
      captured = [];

      const afterIds = await rowIds(user.id);
      const afterSet = new Set(afterIds);
      const beforeSet = new Set(beforeIds);
      samples.push({
        totalQueries: queries.length,
        recentQueries: queries.filter((q) => q.includes('"RecentlyPlayed"')).length,
        elapsedMs,
        rowsBefore,
        rowsAfter: afterIds.length,
        deleted: beforeIds.filter((id) => !afterSet.has(id)).length,
        added: afterIds.filter((id) => !beforeSet.has(id)).length,
        retained: await retainedFingerprint(user.id),
      });
    }

    const first = samples[0] as Sample;
    const last = samples[samples.length - 1] as Sample;
    // Every repetition must agree, or the case is not measuring one thing.
    const queriesStable = samples.every((s) => s.totalQueries === first.totalQueries);
    const deletedStable = samples.every((s) => s.deleted === first.deleted);
    const retainedStable = samples.every((s) => s.retained === first.retained);
    const row: Record<string, string | number | boolean> = {
      case: scenario.label,
      "rows before": first.rowsBefore,
      "queries total": first.totalQueries,
      "queries RecentlyPlayed": first.recentQueries,
      "median ms": median(samples.map((s) => s.elapsedMs)).toFixed(1),
      "min ms": Math.min(...samples.map((s) => s.elapsedMs)).toFixed(1),
      "max ms": Math.max(...samples.map((s) => s.elapsedMs)).toFixed(1),
      "rows after": first.rowsAfter,
      "rows deleted": first.deleted,
      "rows added": first.added,
      "trim happened": first.deleted > 0,
      "expected trim": scenario.expectsTrim,
      "query count stable": queriesStable,
      "deleted count stable": deletedStable,
      "retained set stable": retainedStable,
      "retained set = last rep": first.retained === last.retained,
    };
    summary.push(row);
    fingerprints.push({ label: scenario.label, value: first.retained });
    const agrees = (first.deleted > 0) === scenario.expectsTrim;
    out.push(`--- ${scenario.label}`);
    for (const [key, value] of Object.entries(row)) out.push(`    ${key}: ${value}`);
    out.push(`    trim agrees with expectation: ${agrees}`);
    out.push("");
  }
} finally {
  await db.recentlyPlayed.deleteMany({ where: { userId: user.id } });
  await db.user.deleteMany({ where: { id: user.id } });
  await db.track.deleteMany({ where: { id: { startsWith: namespace } } });
  await db.album.deleteMany({ where: { id: { startsWith: namespace } } });
  await db.artist.deleteMany({ where: { id: { startsWith: namespace } } });
  await db.$disconnect();
}

out.push("| case | rows before | queries | RecentlyPlayed queries | median ms | rows deleted |");
out.push("| --- | --- | --- | --- | --- | --- |");
for (const row of summary) {
  out.push(
    `| ${row["case"]} | ${row["rows before"]} | ${row["queries total"]} | ${row["queries RecentlyPlayed"]} | ${row["median ms"]} | ${row["rows deleted"]} |`,
  );
}

// The retained-track fingerprints, written separately so two runs of two
// different algorithms can be diffed for behavioural equivalence. A count of 50
// is not a claim that the same 50 survived.
out.push("");
out.push("--- retained track fingerprints (newest first) ---");
for (const entry of fingerprints) out.push(`${entry.label}: ${entry.value}`);

const { writeFileSync } = await import("node:fs");
writeFileSync(
  process.env.BENCH_OUT ??
    "C:/Users/Hungg/AppData/Local/Temp/opencode/bench-record-played.txt",
  out.join("\n"),
  "utf8",
);
writeFileSync(
  (process.env.BENCH_OUT ?? "C:/Users/Hungg/AppData/Local/Temp/opencode/bench-record-played.txt").replace(
    /\.txt$/,
    ".fingerprints.txt",
  ),
  fingerprints.map((e) => `${e.label}\n${e.value}`).join("\n\n"),
  "utf8",
);
console.log(out.join("\n"));