import { resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";

process.loadEnvFile(resolve(process.cwd(), ".env"));

/**
 * DB-suite diagnostics: make a slow test say WHY it was slow.
 *
 * THE PROBLEM THIS SOLVES. These tests run against a remote Postgres where one
 * round trip measures ~296 ms, so a test that performs a few hundred queries is
 * legitimately slow - and a test whose query is genuinely hung looks exactly
 * the same from the outside: both are "still running" when the timeout lands.
 * Given only a timeout, the two are indistinguishable, and the instinct is to
 * raise the number until the red goes away.
 *
 * So every test that passes a threshold is reported with its elapsed time as
 * soon as it finishes. That is the signal which separates the two:
 *
 *   - a test finishing at 12 s, consistently, is round-trip-bound and its cost
 *     is understood - the fix is fewer queries, or an annotated local timeout;
 *   - a test that suddenly takes 40 s having taken 8 s, or one that never
 *     finishes at all, is a regression or a hang - and the fix is the query,
 *     not the budget.
 *
 * A hung test still fails on its own timeout; this only makes the slow-but-
 * passing case legible instead of silent, so the two stop being confused.
 * That distinction is the whole point: a threshold alone cannot tell them
 * apart, and that ambiguity is what invites raising the number.
 *
 * WHAT IS NOT LOGGED. No connection string, no environment values, no query
 * parameters, no row contents. Only a test's own name and its elapsed
 * milliseconds, neither of which can carry a credential.
 */

/** Above this, a passing test is reported so its cost is visible. */
const REPORT_THRESHOLD_MS = 8_000;

/** At this, it is called out as genuinely close to its budget. */
const WARN_THRESHOLD_MS = 40_000;

let startedAt = Date.now();

beforeEach(() => {
  startedAt = Date.now();
});

afterEach((context) => {
  const elapsed = Date.now() - startedAt;
  if (elapsed < REPORT_THRESHOLD_MS) {
    return;
  }
  // No pass/fail filter here on purpose. Reading a test's result from inside
  // `afterEach` is not reliable - doing it threw and failed every test in the
  // suite - and it buys nothing: a failing test already prints its own
  // assertion, and a TIMED-OUT one never reaches this hook at all. Which is
  // precisely the distinction this file exists to make visible: a slow test
  // that reports here finished, and one that does not is still running.
  const seconds = (elapsed / 1000).toFixed(1);
  const label =
    elapsed >= WARN_THRESHOLD_MS
      ? `db-test SLOW (${seconds}s, near its budget)`
      : `db-test slow (${seconds}s)`;
  console.warn(`  ${label}: ${context.task.name}`);
});