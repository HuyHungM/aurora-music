/**
 * Server-side rate-limit guard (Phase 52, RULE 12).
 *
 * The policy itself lives in `@/lib/http/rate-limit` and is pure. This module
 * is the thin, request-aware adapter: it decides *who* the caller is, and turns
 * a denial into a logged, correlatable failure.
 *
 * Identity, in order of preference:
 *  1. The authenticated Aurora user id. Stable, honest, and already behind a
 *     password or an OAuth grant.
 *  2. A SHA-256 digest of the client address plus user agent. Never the raw
 *     address: the digest is enough to separate one anonymous caller from
 *     another, and keeping the original out of long-lived process memory and
 *     out of logs is the whole point of hashing it.
 *
 * On the client address, stated plainly because it matters: `x-forwarded-for`
 * and `x-real-ip` are proxy headers. Behind a proxy that overwrites them (any
 * normal deployment) they are trustworthy. If the app were exposed directly to
 * the internet, they would be attacker-controlled, and an attacker could mint
 * a fresh budget per request by varying the header. That is a known and
 * accepted property of an in-process limiter, documented rather than hidden, and
 * it is why the authenticated identity is preferred whenever it exists.
 *
 * Nothing here logs an address, a user agent, a cookie or a token. The denial
 * log carries the bucket, the scope and the correlation id.
 */

import { createHash } from "node:crypto";
import { headers } from "next/headers";

import { logger } from "@/lib/diagnostics/logger";
import { getSessionUserId } from "@/lib/dal/session";
import { newRequestId } from "@/lib/api/request-id";
import { getEnv } from "@/lib/config/env";
import {
  RATE_LIMIT_BUCKETS,
  enforceRateLimit,
  type FixedWindowLimiter,
  type RateLimitBucket,
  type RateLimitBucketName,
  type RateLimitDecision,
  rateLimiter,
} from "@/lib/http/rate-limit";

function firstForwardedAddress(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const first = value.split(",")[0]?.trim();
  if (!first) {
    return null;
  }
  // Bound the length before it reaches the digest: a multi-kilobyte header is
  // not an address, and hashing it would be pointless work on our behalf.
  return first.length <= 64 ? first : null;
}

async function readRequestHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    // Called outside a request scope (a test, a script). Anonymous identity is
    // then the only thing available, which is the safe default.
    return null;
  }
}

/**
 * The rate-limit key for the current request.
 *
 * Exported for tests; the digest is deterministic per (address, agent) pair.
 */
export async function resolveRateLimitIdentity(
  userId: string | null,
  requestHeaders: Headers | null,
): Promise<string> {
  if (userId) {
    return `user:${userId}`;
  }
  const address =
    firstForwardedAddress(requestHeaders?.get("x-forwarded-for") ?? null) ??
    firstForwardedAddress(requestHeaders?.get("x-real-ip") ?? null) ??
    "unknown";
  const agent = (requestHeaders?.get("user-agent") ?? "unknown").slice(0, 256);
  const digest = createHash("sha256").update(`${address}\u0000${agent}`).digest("hex");
  // 16 hex chars = 64 bits of the digest. Ample to keep unrelated anonymous
  // callers in separate windows, and a collision only ever merges two budgets.
  return `anon:${digest.slice(0, 16)}`;
}

export interface GuardOptions {
  /** Override the limiter (tests). */
  readonly limiter?: FixedWindowLimiter;
  /** Skip the session lookup when the caller is known to be authenticated. */
  readonly userId?: string | null;
}

/**
 * A decision that allows, and charges nothing.
 *
 * Reported rather than silently allowed so a caller reading `remaining` still
 * sees the real configured ceiling instead of a number that means nothing.
 */
function unboundedDecision(bucket: RateLimitBucket): RateLimitDecision {
  return {
    allowed: true,
    remaining: bucket.limit,
    limit: bucket.limit,
    resetAtMs: 0,
    retryAfterMs: 0,
  };
}

/**
 * Whether the limiter must stand down because this process is the E2E harness.
 *
 * WHY THIS EXISTS, plainly: the harness replays many independent user journeys
 * as a small fixed set of synthetic users - `e2e/auth/db.ts` seeds exactly two -
 * and runs them concurrently. Five radio journeys therefore arrive as one
 * `user:<id>` key and collectively exceed a ceiling that no real person could
 * reach. The failures that produced looked exactly like product bugs: an empty
 * queue, a station that never started, a seed that was not first. They were
 * the limiter doing its job on a synthetic user.
 *
 * WHY IT IS GATED ON `AURORA_E2E_AUTH` AND NOT ON SOMETHING NEW: that flag
 * already unlocks a fixture-only catalogue and a fixture radio backend, and
 * `parseEnv` already refuses to let it reach a real deployment without the
 * second, deliberately-named acknowledgement `AURORA_E2E_ALLOW_TEST_FLAGS=1`.
 * Reusing that flag keeps a single definition of "this process is not a
 * production posture", so the rate limiter cannot end up disabled in an
 * environment where the fixture surfaces are still switched off.
 *
 * WHAT IS LOST, stated rather than assumed: the end-to-end path through a
 * saturated window is not exercised by Playwright. The algorithm itself -
 * the window boundary, the non-extending denial, the bounded map - is covered
 * by unit tests in `src/lib/api/__tests__/phase52-contract.test.ts`, which run
 * against an injected limiter and are unaffected by this. What a browser test
 * could add here is coverage of a *timed* denial, and manufacturing that needs
 * a controllable clock in the harness, not a permanently disabled limiter.
 */
function limiterDisabledForE2E(): boolean {
  try {
    return getEnv().AURORA_E2E_AUTH === "1";
  } catch {
    // No usable environment means no E2E posture. Fail toward enforcing.
    return false;
  }
}

/**
 * Charge one request to a bucket, or throw `RateLimitError`.
 *
 * The session lookup is best-effort: if Auth.js cannot answer we fall back to
 * the anonymous identity rather than failing the request. Failing open here is
 * correct because the alternative is a limiter that becomes an availability
 * dependency on the auth subsystem.
 */
export async function guardRateLimit(
  name: RateLimitBucketName,
  options: GuardOptions = {},
): Promise<RateLimitDecision> {
  const bucket: RateLimitBucket = RATE_LIMIT_BUCKETS[name];

  if (limiterDisabledForE2E()) {
    return unboundedDecision(bucket);
  }

  const requestHeaders = await readRequestHeaders();
  const userId = await resolveCallerId(options.userId);
  const identity = await resolveRateLimitIdentity(userId, requestHeaders);

  try {
    return enforceRateLimit(bucket, identity, options.limiter ?? rateLimiter);
  } catch (error) {
    logger.warn("Rate limit exceeded", {
      event: "rate_limited",
      bucket: bucket.name,
      authenticated: userId !== null,
      requestId: newRequestId(),
    });
    throw error;
  }
}

/**
 * Best-effort session lookup.
 *
 * A `try` around the call, not `getSessionUserId().catch(...)`: the latter only
 * handles a *rejected* promise, while a synchronous throw - a missing export, a
 * stubbed module, a provider that throws on construction - escapes before
 * `.catch` is ever reached. Either way the correct answer is the same: no
 * authenticated identity is available, so fall back to the anonymous one.
 *
 * Failing open here is deliberate. The alternative is turning a rate limiter
 * into an availability dependency on the auth subsystem, which is a strictly
 * worse failure than the abuse it prevents.
 */
async function resolveCallerId(provided: string | null | undefined): Promise<string | null> {
  if (provided !== undefined) {
    return provided;
  }
  try {
    return await getSessionUserId();
  } catch {
    return null;
  }
}

/**
 * Charge a bucket without throwing.
 *
 * For operations that must stay available under load and where the right
 * degradation is "serve a reduced result" rather than "refuse". Nothing uses
 * this yet; it exists so a future caller has a non-throwing option that is
 * already tested, instead of reimplementing the guard.
 */
export async function tryGuardRateLimit(
  name: RateLimitBucketName,
  options: GuardOptions = {},
): Promise<RateLimitDecision | null> {
  try {
    return await guardRateLimit(name, options);
  } catch {
    return null;
  }
}
