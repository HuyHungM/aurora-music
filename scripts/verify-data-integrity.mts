/**
 * Data-integrity verification (Phase 52, RULE 41-42).
 *
 * This runs against whatever `DATABASE_URL` points at, which is why it is a
 * separate, read-only, no-argument script rather than something bolted onto
 * `verify-db`. Its whole purpose is to be pointed at a RESTORED COPY: the
 * question a backup restores nothing if it cannot answer is "is the restored
 * database actually the database we backed up", and that cannot be checked from
 * inside the live deployment.
 *
 * It is read-only. There is no INSERT, UPDATE, DELETE or DDL in this file, by
 * construction - the only writes are the `prisma migrate deploy` the caller runs
 * first if it wants the schema present. Running it against production is
 * therefore safe; the irreversible thing is not the read, it is the restore.
 *
 * What it checks, and why each one matters:
 * - Orphans. A row whose parent is missing is invisible to every application
 *   query that joins, so the product silently loses it. Restores and manual
 *   surgery are the usual cause.
 * - Constraints present. Foreign keys, unique indexes and NOT NULL are what
 *   make concurrent writes safe. A dump restored without them looks perfect
 *   right up until two requests race, and then it is corrupt. This asserts the
 *   constraints are actually in `pg_constraint`, not merely that the app
 *   assumes they are.
 * - Uniqueness actually holds in the data, not just in the schema. A unique
 *   index can exist and still have duplicates if it was added after bad data
 *   and the migration skipped validation.
 * - Playlist ordering. Positions are unique per playlist and must be
 *   contiguous from 0. A gap means a track became invisible in the UI: the
 *   list is rendered by position, so a missing position is a missing row on
 *   screen, and there is no error to notice.
 * - Ownership. Every user-scoped row must point at a real user. This is the
 *   cross-user access boundary (RULE 4/5) expressed as data: a row whose owner
 *   vanished is a row nobody can reach and nobody can delete.
 * - Migration history. A failed or unapplied migration is the usual reason a
 *   restored schema is subtly different from the one the dump came from.
 *
 * Every check reports a count. Any non-zero failure count exits non-zero.
 *
 * Usage:
 *   bun run db:integrity                 # the configured DATABASE_URL
 *   DATABASE_URL=... bun run db:integrity # e.g. a throwaway restored copy
 */

import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");
const { buildDatabaseAdapterConfig, DATABASE_CA_CERT_PATH_VAR } = await import(
  "../src/lib/db-tls"
);

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to verify data integrity");
}

const nodeEnv = process.env.NODE_ENV;
const db = new PrismaClient({
  adapter: new PrismaPg(
    buildDatabaseAdapterConfig({
      url,
      caCertPath: process.env[DATABASE_CA_CERT_PATH_VAR],
      nodeEnv:
        nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
    }),
  ),
});

/**
 * Orphan and ownership checks.
 *
 * Table and column names are interpolated, not bound: PostgreSQL cannot
 * parameterize identifiers. That is safe only because every name here is a
 * literal in this file - none of it is derived from a request, an environment
 * variable or user input. Do not parameterize this list from anywhere.
 */
const PARENT_LINKS = [
  { child: "Account", column: "userId", parent: "User" },
  { child: "Session", column: "userId", parent: "User" },
  { child: "Like", column: "userId", parent: "User" },
  { child: "Follow", column: "userId", parent: "User" },
  { child: "RecentlyPlayed", column: "userId", parent: "User" },
  { child: "SearchHistory", column: "userId", parent: "User" },
  { child: "Playlist", column: "userId", parent: "User" },
  { child: "PlaylistTrack", column: "playlistId", parent: "Playlist" },
  { child: "PlaylistTrack", column: "trackId", parent: "Track" },
  { child: "PlaybackState", column: "userId", parent: "User" },
  { child: "Track", column: "artistId", parent: "Artist" },
  { child: "Album", column: "artistId", parent: "Artist" },
  { child: "Like", column: "trackId", parent: "Track" },
  { child: "Follow", column: "artistId", parent: "Artist" },
] as const;

/**
 * Unique indexes the application's idempotency depends on.
 *
 * Matched by the index name Prisma deterministically derives from the table and
 * columns, then VERIFIED against the catalog for uniqueness and for its actual
 * key columns. Matching on the name alone would be a weak check - a
 * hand-renamed or hand-created index could satisfy it while covering the wrong
 * columns.
 *
 * Note on the catalog: these are unique *indexes*, not `pg_constraint` rows.
 * Prisma's migrations emit `CREATE UNIQUE INDEX`, which in PostgreSQL does not
 * register a constraint. Querying `pg_constraint` finds only the primary keys
 * and reports every one of these as missing.
 */
const REQUIRED_UNIQUE_INDEXES = [
  { table: "User", columns: ["email"] },
  { table: "Artist", columns: ["provider", "providerArtistId"] },
  { table: "Album", columns: ["provider", "providerAlbumId"] },
  { table: "Track", columns: ["provider", "providerTrackId"] },
  { table: "Like", columns: ["userId", "trackId"] },
  { table: "Follow", columns: ["userId", "artistId"] },
  { table: "Playlist", columns: ["shareToken"] },
  { table: "Session", columns: ["sessionToken"] },
  { table: "PlaylistTrack", columns: ["playlistId", "trackId"] },
  { table: "PlaylistTrack", columns: ["playlistId", "position"] },
  { table: "PlaybackState", columns: ["userId"] },
] as const;

/**
 * Uniqueness also verified in the data, not only in the schema.
 *
 * A unique index can legitimately exist and still have duplicates: the index may
 * have been added after bad data with the migration's validation skipped. The
 * application would then read one row and silently write another.
 */
const DUPLICATE_GROUPS = [
  {
    label: "Like(userId,trackId)",
    sql: `SELECT "userId", "trackId" FROM "Like" GROUP BY 1,2 HAVING COUNT(*) > 1`,
  },
  {
    label: "Follow(userId,artistId)",
    sql: `SELECT "userId", "artistId" FROM "Follow" GROUP BY 1,2 HAVING COUNT(*) > 1`,
  },
  {
    label: "PlaylistTrack(playlistId,position)",
    sql: `SELECT "playlistId", "position" FROM "PlaylistTrack" GROUP BY 1,2 HAVING COUNT(*) > 1`,
  },
  {
    label: "PlaylistTrack(playlistId,trackId)",
    sql: `SELECT "playlistId", "trackId" FROM "PlaylistTrack" GROUP BY 1,2 HAVING COUNT(*) > 1`,
  },
  {
    // A unique index treats NULLs as distinct, so a nullable column needs its
    // own duplicate check or N users with no email all pass.
    label: "User(email)",
    sql: `SELECT "email" FROM "User" WHERE "email" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`,
  },
  {
    label: "Playlist(shareToken)",
    sql: `SELECT "shareToken" FROM "Playlist" WHERE "shareToken" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`,
  },
] as const;

/** Columns that must never be null for the product to work at all. */
const REQUIRED_NOT_NULL = [
  { table: "User", column: "id" },
  { table: "Track", column: "title" },
  { table: "Track", column: "provider" },
  { table: "Track", column: "providerTrackId" },
  { table: "Artist", column: "name" },
  { table: "Playlist", column: "userId" },
  { table: "PlaylistTrack", column: "position" },
  { table: "PlaylistTrack", column: "trackId" },
  { table: "PlaybackState", column: "userId" },
] as const;

let failures = 0;

/**
 * PostgreSQL `COUNT(*)` comes back as bigint. Converted through a helper
 * rather than a `?? 0n` fallback because BigInt literals are not available at
 * this package's compile target, and a missing row should read as zero rather
 * than as NaN.
 */
function toCount(value: bigint | undefined): number {
  return value === undefined ? 0 : Number(value);
}

function report(label: string, value: unknown): void {
  console.log(`${label}: ${String(value)}`);
}

function fail(label: string, detail: string): void {
  failures += 1;
  console.error(`FAIL ${label}: ${detail}`);
}

async function countOrphans(link: (typeof PARENT_LINKS)[number]): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM "${link.child}" c
      WHERE c."${link.column}" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "${link.parent}" p WHERE p."id" = c."${link.column}")`,
  );
  return toCount(rows[0]?.count);
}

async function missingUniqueIndex(entry: {
  table: string;
  columns: readonly string[];
}): Promise<string | null> {
  // Prisma names a unique index `<Table>_<col...>_key`.
  const expectedName = `${entry.table}_${entry.columns.join("_")}_key`;
  const rows = await db.$queryRawUnsafe<Array<{ is_unique: boolean; cols: string[] }>>(
    `SELECT i.indisunique AS is_unique,
            (SELECT array_agg(a.attname::text ORDER BY x.ord)
               FROM unnest(i.indkey::int[]) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
              WHERE x.ord <= i.indnkeyatts) AS cols
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE t.relname = '${entry.table}' AND ic.relname = '${expectedName}'`,
  );
  if (rows.length === 0) {
    return `index ${expectedName} does not exist`;
  }
  const row = rows[0];
  if (!row.is_unique) {
    return `index ${expectedName} exists but is not unique`;
  }
  const actual = row.cols ?? [];
  const missing = entry.columns.filter((column) => !actual.includes(column));
  if (missing.length > 0) {
    return `index ${expectedName} covers ${actual.join(",")}, missing ${missing.join(",")}`;
  }
  return null;
}

async function duplicateGroups(sql: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM (${sql}) grouped`,
  );
  return toCount(rows[0]?.count);
}

async function isNullable(entry: { table: string; column: string }): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ attnotnull: boolean }>>(
    `SELECT a.attnotnull
       FROM pg_attribute a
       JOIN pg_class t ON t.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = '${entry.table}'
        AND a.attname = '${entry.column}'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
  );
  return rows.length === 0 || rows[0]!.attnotnull === false;
}

async function main(): Promise<void> {
  await db.$connect();
  report("database", "connected");

  // 1. Orphaned rows.
  for (const link of PARENT_LINKS) {
    const orphans = await countOrphans(link);
    const label = `orphaned ${link.child}.${link.column}`;
    if (orphans > 0) {
      fail(label, `${orphans} row(s) reference a missing ${link.parent}`);
    } else {
      report(label, 0);
    }
  }

  // 2. Required unique indexes exist and really are unique. This is the check a
  //    restore without its indexes fails, and it is invisible to the app until a
  //    race writes a duplicate.
  for (const entry of REQUIRED_UNIQUE_INDEXES) {
    const label = `unique ${entry.table}(${entry.columns.join(",")})`;
    const problem = await missingUniqueIndex(entry);
    if (problem) {
      fail(label, problem);
    } else {
      report(label, "present and unique");
    }
  }

  // 3. Uniqueness also holds in the data, not only in the schema.
  for (const entry of DUPLICATE_GROUPS) {
    const duplicates = await duplicateGroups(entry.sql);
    if (duplicates > 0) {
      fail(`duplicate ${entry.label}`, `${duplicates} duplicated group(s)`);
    } else {
      report(`duplicate ${entry.label}`, 0);
    }
  }

  // 4. Required NOT NULL columns really are NOT NULL.
  for (const entry of REQUIRED_NOT_NULL) {
    const label = `not-null ${entry.table}.${entry.column}`;
    if (await isNullable(entry)) {
      fail(label, "column is nullable or absent");
    } else {
      report(label, "not null");
    }
  }

  // 5. Playlist ordering is contiguous from 0 with no duplicate positions.
  //    A gap hides a track from the UI with no error, so this is checked in the
  //    data as well as the schema.
  const gapped = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM (
         SELECT "playlistId",
                MIN("position") AS lo,
                MAX("position") AS hi,
                COUNT(*) AS n
           FROM "PlaylistTrack"
          GROUP BY "playlistId"
         HAVING MAX("position") <> COUNT(*) - 1 OR MIN("position") <> 0
       ) broken`,
  );
  const gappedCount = toCount(gapped[0]?.count);
  if (gappedCount > 0) {
    fail("playlist ordering", `${gappedCount} playlist(s) have a position gap or duplicate`);
  } else {
    report("playlist ordering", "contiguous from 0");
  }

  // 6. Every user-scoped row resolves to a real user. Re-derived independently
  //    of the orphan check because it is the security-relevant one: a
  //    user-scoped row with no owner is a row no authorization check can ever
  //    attribute, so it is either invisible or, worse, reachable.
  const unowned = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT (
       (SELECT COUNT(*) FROM "Playlist" p
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = p."userId"))
     + (SELECT COUNT(*) FROM "PlaybackState" s
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = s."userId"))
     + (SELECT COUNT(*) FROM "Like" l
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = l."userId"))
     + (SELECT COUNT(*) FROM "Follow" f
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = f."userId"))
     + (SELECT COUNT(*) FROM "RecentlyPlayed" r
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = r."userId"))
     + (SELECT COUNT(*) FROM "SearchHistory" h
         WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = h."userId"))
     )::bigint AS count`,
  );
  const unownedCount = toCount(unowned[0]?.count);
  if (unownedCount > 0) {
    fail("user-scoped ownership", `${unownedCount} row(s) have no resolvable owner`);
  } else {
    report("user-scoped ownership", "every row resolves to a user");
  }

  // 7. Migration history is complete and has no failures. A dump restored from
  //    a database mid-migration is the classic version-skew disaster.
  const migrations = await db.$queryRawUnsafe<
    Array<{ total: bigint; failed: bigint; pending: bigint; unfinished: bigint }>
  >(
    `SELECT
       (SELECT COUNT(*) FROM "_prisma_migrations")::bigint AS total,
       (SELECT COUNT(*) FROM "_prisma_migrations"
         WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
           AND "logs" IS NOT NULL AND "logs" <> '')::bigint AS failed,
       (SELECT COUNT(*) FROM "_prisma_migrations"
         WHERE "finished_at" IS NULL)::bigint AS pending,
       (SELECT COUNT(*) FROM "_prisma_migrations"
         WHERE "finished_at" IS NULL AND "started_at" IS NOT NULL
           AND "rolled_back_at" IS NULL)::bigint AS unfinished`,
  );
  const migrationState = migrations[0];
  report("migrations applied", toCount(migrationState?.total));
  if (toCount(migrationState?.failed) > 0) {
    fail("migrations", "one or more migrations recorded an error");
  }
  if (toCount(migrationState?.unfinished) > 0) {
    fail("migrations", "one or more migrations started but never finished");
  }

  await db.$disconnect();

  if (failures > 0) {
    console.error(`db:integrity FAILED with ${failures} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("db:integrity OK");
}

main().catch((error) => {
  console.error("db:integrity FAILED:", error);
  process.exitCode = 1;
});
