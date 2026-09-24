/**
 * Authenticated E2E preparation script (Phase 30). Runs under `tsx`
 * (real ESM), NOT inside the Playwright transform:
 *
 *   migrate (idempotent) → seed synthetic users + fixture catalog →
 *   encode Auth.js-compatible session JWTs → write storage states →
 *   verify every state against the REAL /api/auth/session endpoint.
 *
 * No OAuth credentials, no production accounts, no provider keys.
 * Exits non-zero with an actionable message when prerequisites fail.
 * Prints a single JSON summary line on stdout.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AUTH_STATE_DIR,
  SESSION_MAX_AGE_SECONDS,
  TEST_USERS,
  sessionCookieName,
  storageStatePath,
} from "./constants";
import { cleanupAuthTestData, closeTestClient, ensureAuthTestData } from "./db";
import { buildStorageState, createSessionToken, tamperToken } from "./session";

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const baseURL = argValue("--base-url", "http://127.0.0.1:3100");

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET must be set for authenticated E2E (the E2E server uses the same value; CI provides a dummy).",
    );
  }

  // Idempotent: ensures User/Account/Session tables exist for the
  // seeded rows. Additive migrations only, same command as test:db.
  // Bounded retry: the database can still be coming up when the
  // webServer reports ready (root renders without DB).
  let migrated = false;
  let migrateError: unknown = null;
  for (let attempt = 1; attempt <= 3 && !migrated; attempt += 1) {
    try {
      execSync("npx prisma migrate deploy", { stdio: "pipe" });
      migrated = true;
    } catch (error) {
      migrateError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!migrated) {
    throw new Error(
      `prisma migrate deploy failed after 3 attempts: ${migrateError instanceof Error ? migrateError.message : String(migrateError)}`,
    );
  }

  // Start clean so re-runs never inherit a previous run's playlists.
  await cleanupAuthTestData();
  const data = await ensureAuthTestData();
  const userIds: Record<string, string> = {
    [TEST_USERS[0].email]: data.userAId,
    [TEST_USERS[1].email]: data.userBId,
  };

  const cookieName = sessionCookieName(baseURL);
  mkdirSync(AUTH_STATE_DIR, { recursive: true });

  const states: Array<{ role: string; token: string; maxAge: number }> = [];
  for (const user of TEST_USERS) {
    const token = await createSessionToken({
      userId: userIds[user.email]!,
      email: user.email,
      name: user.name,
      secret,
      cookieName,
    });
    states.push({ role: user.role, token, maxAge: SESSION_MAX_AGE_SECONDS });
  }

  // Expired: Auth.js rejects on `exp` during decode (genuine path).
  states.push({
    role: "expired",
    token: await createSessionToken({
      userId: userIds[TEST_USERS[0].email]!,
      email: TEST_USERS[0].email,
      name: TEST_USERS[0].name,
      secret,
      cookieName,
      maxAgeSeconds: -60,
    }),
    maxAge: -60,
  });

  // Tampered: JWE authentication fails during decode (genuine path).
  states.push({
    role: "tampered",
    token: tamperToken(states[0].token),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  for (const state of states) {
    writeFileSync(
      storageStatePath(state.role),
      JSON.stringify(
        buildStorageState(baseURL, cookieName, state.token, state.maxAge),
      ),
    );
  }

  // Empirically prove the derived cookie name and token format: the
  // running server must accept a/b and reject expired/tampered through
  // the real Auth.js verification path.
  const verified: Record<string, boolean> = {};
  for (const user of TEST_USERS) {
    const token = states.find((s) => s.role === user.role)!.token;
    const response = await fetch(`${baseURL}/api/auth/session`, {
      headers: { cookie: `${cookieName}=${token}` },
    });
    if (!response.ok) {
      throw new Error(`Session verification failed for user ${user.role}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { user?: { id?: string; email?: string } };
    verified[user.role] = body.user?.id === userIds[user.email] && body.user?.email === user.email;
  }
  for (const role of ["expired", "tampered"]) {
    const token = states.find((s) => s.role === role)!.token;
    const response = await fetch(`${baseURL}/api/auth/session`, {
      headers: { cookie: `${cookieName}=${token}` },
    });
    // Rejected sessions yield an empty body (null), never a user.
    const body = (await response.json()) as { user?: { id?: string } } | null;
    verified[role] = body?.user?.id === undefined;
  }

  const failed = Object.entries(verified).filter(([, ok]) => !ok);
  if (failed.length > 0) {
    throw new Error(
      `Session verification failed for: ${failed.map(([role]) => role).join(", ")} (cookie ${cookieName}).`,
    );
  }

  await closeTestClient();
  console.log(
    JSON.stringify({
      userAId: data.userAId,
      userBId: data.userBId,
      cookieName,
      verified,
    }),
  );
}

try {
  await main();
} catch (error) {
  await closeTestClient().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
