import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Integration-suite configuration for tests that talk to a real Postgres.
 *
 * WHY THIS HAS ITS OWN, LARGER TIMEOUT.
 *
 * The unit suite's 30 s is a budget for code that never leaves the process.
 * These tests do: every assertion is a round trip to whatever
 * `DATABASE_URL` names, and this project's points at a remote Aiven instance.
 * Measured on that host, one round trip costs ~296 ms - a transaction with a
 * single statement costs ~886 ms, because BEGIN and COMMIT are two more.
 *
 * That number is the whole explanation for the timeout failures this file
 * exists to resolve. It also puts a hard ceiling on what any test here can do:
 * 60 s buys about 200 sequential queries. A test that needs more is not slow,
 * it is round-trip-bound by the behaviour it is verifying, and the honest
 * response is a LOCAL timeout on that test with the reason recorded - not a
 * bigger number here, which would silently grant every future test the same
 * budget.
 *
 * 60 s is chosen to sit above every measured test in this suite that is not
 * explicitly annotated (the longest is ~19 s) with roughly 3x headroom, so an
 * ordinary failure still reports well inside the budget instead of being
 * mistaken for a hang. The three round-trip-bound tests - the ones that must
 * really write 50-55 rows - carry their own, larger, documented timeout.
 *
 * `hookTimeout` matches, because `beforeAll`/`afterAll` here create users and
 * cascade-delete them, which are themselves round trips.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    setupFiles: ["./scripts/db-test-env.ts"],
    // Deliberately serial: these suites share one database, and several assert
    // on counts across a user's whole history. Parallel files would interleave
    // writes into the same rows.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // The slow-test report in `db-test-env.ts` is the point of this suite being
    // legible: without this, console output from a setup-file hook is only
    // flushed when something FAILS, which is exactly the wrong moment - a
    // healthy-but-expensive test is the case the report exists to surface.
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
    },
  },
});