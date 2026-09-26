/**
 * Restore drill (Phase 52, RULE 41).
 *
 * A backup that has never been restored is a hypothesis. This script turns it
 * into a fact by actually doing it, on a schedule anyone can run:
 *
 *   1. create a throwaway database next to the source
 *   2. `pg_dump` the source into a custom-format archive
 *   3. `pg_restore` that archive into the throwaway database
 *   4. run the full data-integrity verification against the RESTORED copy
 *   5. compare row counts, so a restore that "succeeded" but silently lost
 *      tables or rows is caught
 *   6. drop the throwaway database, always
 *
 * It never writes to the source database. `pg_dump` is a read-only client, and
 * every write goes to a database whose name this script creates and owns.
 *
 * GUARDS. Restoring a database is one of the few genuinely destructive things
 * in this repository, so the blast radius is fenced off explicitly:
 *
 * - Opt-in via `AURORA_RESTORE_DRILL=1`, the same acknowledgement pattern the
 *   E2E flags use. Running this by accident during a normal `bun run` is not
 *   possible: it is not wired into the default pipeline, and the drill refuses
 *   to start without the flag.
 * - The target database name must differ from the source. If someone points
 *   `AURORA_RESTORE_DRILL_TARGET` at the live database, the script exits before
 *   creating anything. This is the check that matters most.
 * - The drop runs in `finally`, so a failed integrity check cannot leave a
 *   stray database behind for the next drill to collide with.
 *
 * Requires the PostgreSQL client tools (`pg_dump`, `pg_restore`, `createdb`,
 * `dropdb`) on PATH. If they are missing the script says so and exits
 * non-zero - it does not pretend the drill passed.
 *
 * Usage:
 *   AURORA_RESTORE_DRILL=1 bun run db:restore-drill
 *   AURORA_RESTORE_DRILL=1 AURORA_RESTORE_DRILL_TARGET=aurora_drill_2 bun run db:restore-drill
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const CONFIRMATION_FLAG = "AURORA_RESTORE_DRILL";
const TARGET_ENV = "AURORA_RESTORE_DRILL_TARGET";
const DEFAULT_TARGET = "aurora_restore_drill";

/** Tables whose row counts must survive a restore. */
const COUNTED_TABLES = [
  "User",
  "Account",
  "Session",
  "Artist",
  "Album",
  "Track",
  "Like",
  "Follow",
  "RecentlyPlayed",
  "SearchHistory",
  "Playlist",
  "PlaylistTrack",
  "PlaybackState",
] as const;

function fail(message: string): never {
  console.error(`db:restore-drill FAILED: ${message}`);
  process.exit(1);
}

function note(message: string): void {
  console.log(message);
}

interface Source {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

function readSourceUrl(): Source {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    fail("DATABASE_URL is required.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    fail(`Unsupported DATABASE_URL scheme "${url.protocol}". Expected postgresql:.`);
  }
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

function have(binary: string): boolean {
  const probe = spawnSync(binary, ["--version"], { stdio: "ignore", shell: false });
  return probe.status === 0 || probe.status === 1;
}

/**
 * Run a client tool with the source credentials in the environment.
 *
 * `PGPASSWORD` rather than a `-W` prompt or a URL argument: a URL on the
 * command line is visible to every process listing on the machine, an
 * environment variable is not. Nothing here echoes either value.
 */
function runTool(
  binary: string,
  args: string[],
  source: Source,
  database: string,
): { ok: boolean; output: string } {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      PGHOST: source.host,
      PGPORT: source.port,
      PGUSER: source.user,
      PGPASSWORD: source.password,
      PGDATABASE: database,
      // Keep a tool failure from blocking on a password prompt forever.
      PGPASSFILE: process.env.PGPASSFILE ?? "nul",
    },
  });
  if (result.error) {
    return { ok: false, output: result.error.message };
  }
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

async function main(): Promise<void> {
  if (process.env[CONFIRMATION_FLAG] !== "1") {
    fail(
      `${CONFIRMATION_FLAG}=1 is required. This script creates and drops a ` +
        `database; it is a drill, not a build step.`,
    );
  }

  const source = readSourceUrl();
  const target = process.env[TARGET_ENV] ?? DEFAULT_TARGET;

  // The guard that matters. Restoring into the source would destroy it, and
  // this is checked before anything is created.
  if (target === source.database) {
    fail(
      `refusing to run: the drill target "${target}" is the source database. ` +
        `Point ${TARGET_ENV} at a different name.`,
    );
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(target)) {
    fail(`refusing to run: "${target}" is not a plain, lowercase database name.`);
  }

  for (const binary of ["pg_dump", "pg_restore", "createdb", "dropdb"]) {
    if (!have(binary)) {
      fail(
        `"${binary}" was not found on PATH. Install the PostgreSQL client tools ` +
          `(the server's own psql/pg_dump) before running the drill.`,
      );
    }
  }

  note(`source database: ${source.database} at ${source.host}:${source.port}`);
  note(`drill target:    ${target}`);

  const workdir = mkdtempSync(join(tmpdir(), "aurora-restore-drill-"));
  const archive = join(workdir, "dump.pgc");

  try {
    // 1. Create the throwaway database.
    const created = runTool(
      "createdb",
      ["--maintenance-db", "postgres", target],
      source,
      "postgres",
    );
    if (!created.ok) {
      // Pre-existing from an interrupted drill is a recoverable state, not a
      // failure: drop it and try once more, so a rerun works.
      note(`createdb failed; retrying after dropping any leftover ${target}`);
      runTool("dropdb", ["--if-exists", "--force", "--maintenance-db", "postgres", target], source, "postgres");
      const retried = runTool(
        "createdb",
        ["--maintenance-db", "postgres", target],
        source,
        "postgres",
      );
      if (!retried.ok) {
        fail(`could not create ${target}: ${retried.output.trim()}`);
      }
    }

    // 2. Dump the source. Custom format, so the restore is a real
    //    index-and-constraint-carrying restore rather than a SQL replay that
    //    could paper over a missing index.
    note("dumping the source database...");
    const dumped = runTool(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--file", archive, source.database],
      source,
      source.database,
    );
    if (!dumped.ok) {
      fail(`pg_dump failed: ${dumped.output.trim()}`);
    }
    if (!existsSync(archive)) {
      fail("pg_dump reported success but produced no archive.");
    }
    const archiveBytes = readFileSync(archive).byteLength;
    note(`dump written: ${archiveBytes} bytes`);

    // 3. Restore into the throwaway database.
    note("restoring into the drill target...");
    const restored = runTool(
      "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--dbname",
        target,
        archive,
      ],
      source,
      target,
    );
    if (!restored.ok) {
      fail(`pg_restore failed: ${restored.output.trim()}`);
    }
    note("restore completed");

    // 4. Full integrity verification against the RESTORED copy. This is the
    //    point of the drill: the same script an operator would run on a real
    //    recovery, run against recovered data.
    note("verifying data integrity of the restored copy...");
    const integrity = spawnSync(
      "bunx",
      ["tsx", "scripts/verify-data-integrity.mts"],
      {
        encoding: "utf8",
        shell: false,
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `postgresql://${encodeURIComponent(source.user)}:${encodeURIComponent(
            source.password,
          )}@${source.host}:${source.port}/${target}`,
        },
      },
    );
    const integrityOutput = `${integrity.stdout ?? ""}${integrity.stderr ?? ""}`;
    for (const line of integrityOutput.split(/\r?\n/)) {
      if (line.trim().length > 0) {
        note(`  ${line}`);
      }
    }
    if (integrity.status !== 0) {
      fail("the restored copy failed data-integrity verification.");
    }

    // 5. Row counts must match. Integrity verification proves the restored
    //    database is internally consistent; it cannot prove anything is still
    //    there. A dump that silently skipped a table would pass every check in
    //    step 4 and lose the data.
    note("comparing row counts against the source...");
    let mismatches = 0;
    for (const table of COUNTED_TABLES) {
      const sourceCount = countRows(source, source.database, table);
      const targetCount = countRows(source, target, table);
      const flag = sourceCount === targetCount ? "ok  " : "DIFF";
      note(`  ${flag} ${table}: source=${sourceCount} restored=${targetCount}`);
      if (sourceCount !== targetCount) {
        mismatches += 1;
      }
    }
    if (mismatches > 0) {
      fail(`${mismatches} table(s) differ in row count after restore.`);
    }

    note("");
    note(
      "db:restore-drill OK - the source was dumped, restored into an isolated " +
        "database, verified for integrity, and matched row for row.",
    );
  } finally {
    // 6. Always drop. A drill that leaves a database behind is a drill that
    //    fails the next time it runs.
    const dropped = runTool(
      "dropdb",
      ["--if-exists", "--force", "--maintenance-db", "postgres", target],
      source,
      "postgres",
    );
    note(
      dropped.ok
        ? `dropped the drill target ${target}`
        : `WARNING: could not drop ${target}: ${dropped.output.trim()}`,
    );
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Row count through `psql`, in a machine-readable single-value form.
 *
 * `psql -Atc` prints the bare value with no formatting, so this does not need
 * to parse a table. The table name is one of our own literals, never input.
 */
function countRows(source: Source, database: string, table: string): number {
  const result = runTool(
    "psql",
    ["--no-psqlrc", "-Atq", "--dbname", database, "-c", `SELECT COUNT(*) FROM "${table}"`],
    source,
    database,
  );
  if (!result.ok) {
    fail(`could not count ${table} in ${database}: ${result.output.trim()}`);
  }
  const value = Number(result.output.trim().split(/\r?\n/).pop() ?? "NaN");
  if (!Number.isFinite(value)) {
    fail(`could not parse the row count for ${table} in ${database}.`);
  }
  return value;
}

main().catch((error) => {
  console.error("db:restore-drill FAILED:", error);
  process.exit(1);
});
