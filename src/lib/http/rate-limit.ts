/**
 * In-process fixed-window rate limiting (Phase 52, RULE 12).
 *
 * Why this exists: the four most expensive things Aurora does - unified
 * multi-provider search, audio-source resolution, radio generation and
 * recommendation generation - are all reachable without signing in, and each
 * one fans out into outbound provider requests. Before this, a single
 * anonymous loop could spend the deployment's whole provider quota in
 * seconds. That is a real availability and cost problem, not a theoretical one.
 *
 * Why it is a separate, dependency-free module: it has to be unit-testable
 * without a request, a session, a database or a DOM, and it has to be readable
 * end to end. A third-party limiter would be more code than this and would
 * arrive with its own configuration surface to get wrong.
 *
 * Algorithm: fixed window per key. Chosen over a token bucket because the
 * thing being protected is a burst budget, and a fixed window makes "retry
 * after N seconds" exactly truthful - which is what the client is told.
 *
 * HONEST LIMITATION (documented in docs/scope-boundaries.md, not hidden here):
 * the window lives in this process's heap. With N application instances, a
 * caller can spend N times the budget by spreading requests across them. This
 * is a meaningful single-instance guard and a partial multi-instance one. A
 * shared store (Redis, or a rate-limit gateway in front of the app) is the
 * production answer for a horizontally scaled deployment, and that decision
 * belongs to the deployment, not to this module.
 */

import { RateLimitError } from "@/lib/api/error-codes";

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests still available in the current window. */
  readonly remaining: number;
  /** The configured ceiling, echoed so a client can show a budget. */
  readonly limit: number;
  /** When the current window ends, epoch ms. */
  readonly resetAtMs: number;
  /** Only meaningful when `allowed` is false. */
  readonly retryAfterMs: number;
}

export interface RateLimitBucket {
  /** Stable, client-safe name. Appears in logs and in the error scope. */
  readonly name: string;
  /** Requests permitted per window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

export interface FixedWindowLimiter {
  consume(key: string, bucket: RateLimitBucket, nowMs?: number): RateLimitDecision;
  /** Drops one key. Used when an identity changes (sign-out). */
  forget(key: string): void;
  /** Drops every window. Exposed for tests and for a future admin purge. */
  reset(): void;
  /** Live key count. Bounded by `maxKeys`; asserted by tests. */
  size(): number;
}

export interface LimiterOptions {
  /**
   * Hard ceiling on distinct tracked keys. Without it, an attacker varying a
   * spoofed forwarded-for header would grow the map without bound - a memory
   * exhaustion vector that is strictly worse than the abuse it prevents.
   */
  readonly maxKeys?: number;
  /** Injectable clock. Tests pass a counter; production omits it. */
  readonly now?: () => number;
}

export const DEFAULT_MAX_KEYS = 10_000;

function defaultNow(): number {
  return Date.now();
}

export function createFixedWindowLimiter(options: LimiterOptions = {}): FixedWindowLimiter {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? defaultNow;
  // Insertion order doubles as eviction order: Map preserves it, and re-inserting
  // on every touch would make this LRU and cost an extra bookkeeping path.
  const windows = new Map<string, Window>();

  function evictIfNeeded(): void {
    if (windows.size < maxKeys) {
      return;
    }
    // First pass: drop everything already expired. This is usually sufficient,
    // because expiry is what actually frees a key under real traffic.
    const timestamp = now();
    for (const [key, window] of windows) {
      if (window.resetAtMs <= timestamp) {
        windows.delete(key);
      }
    }
    if (windows.size < maxKeys) {
      return;
    }
    // Second pass: the map is genuinely full of live windows. Drop the oldest
    // insertion. Losing one live window means that one key gets a fresh budget,
    // which is a far smaller harm than refusing to track new keys at all.
    const oldest = windows.keys().next();
    if (!oldest.done) {
      windows.delete(oldest.value);
    }
  }

  return {
    consume(key, bucket, nowMs) {
      const timestamp = nowMs ?? now();
      const existing = windows.get(key);

      if (!existing || existing.resetAtMs <= timestamp) {
        evictIfNeeded();
        const resetAtMs = timestamp + bucket.windowMs;
        windows.set(key, { count: 1, resetAtMs });
        return {
          allowed: true,
          remaining: Math.max(0, bucket.limit - 1),
          limit: bucket.limit,
          resetAtMs,
          retryAfterMs: 0,
        };
      }

      if (existing.count < bucket.limit) {
        existing.count += 1;
        return {
          allowed: true,
          remaining: bucket.limit - existing.count,
          limit: bucket.limit,
          resetAtMs: existing.resetAtMs,
          retryAfterMs: 0,
        };
      }

      // Denied. The window is NOT extended: extending it on every rejection
      // would let a caller who keeps hammering hold their own lockout open.
      return {
        allowed: false,
        remaining: 0,
        limit: bucket.limit,
        resetAtMs: existing.resetAtMs,
        retryAfterMs: Math.max(0, existing.resetAtMs - timestamp),
      };
    },
    forget(key) {
      windows.delete(key);
    },
    reset() {
      windows.clear();
    },
    size() {
      return windows.size;
    },
  };
}

/**
 * The budgets.
 *
 * These are not arbitrary: each is set from what the operation actually costs
 * and what a person plausibly does, with headroom for the fast path.
 *
 * - `search` fans out to three providers. 30/minute is far above interactive
 *   use (a person searching continuously would exhaust it) and low enough that
 *   a scripted loop cannot dominate a provider quota on its own.
 * - `playback.resolve` runs once per track load, and a listener skipping through
 *   a queue legitimately does that fast, so it gets the largest budget of the
 *   four. It is also the single most expensive call.
 * - `radio.start` and `radio.extend` each trigger generation, so they are the
 *   tightest; extend is looser than start because queue continuation fires
 *   repeatedly during normal listening.
 * - `recommendations` is a page section plus the continuation coordinator, so
 *   its budget sits between interactive search and radio.
 * - `playback.record` fires on every natural end. It is cheap, so the budget is
 *   high enough that a fast skipper is never punished for normal use.
 * - `playlist.mutate` guards a real write path, so it is deliberately tighter
 *   than any read-ish operation.
 */
export const RATE_LIMIT_BUCKETS = {
  search: { name: "search", limit: 30, windowMs: 60_000 },
  playbackResolve: { name: "playback.resolve", limit: 120, windowMs: 60_000 },
  playbackRecord: { name: "playback.record", limit: 300, windowMs: 60_000 },
  radioStart: { name: "radio.start", limit: 20, windowMs: 60_000 },
  radioExtend: { name: "radio.extend", limit: 60, windowMs: 60_000 },
  recommendations: { name: "recommendations", limit: 60, windowMs: 60_000 },
  playlistMutate: { name: "playlist.mutate", limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitBucket>;

export type RateLimitBucketName = keyof typeof RATE_LIMIT_BUCKETS;

/** The process-wide limiter. One instance, because one process is the budget. */
export const rateLimiter: FixedWindowLimiter = createFixedWindowLimiter();

/**
 * Throws `RateLimitError` when the budget is spent. The decision itself stays
 * side-effect free so callers can test policy without touching module state.
 */
export function enforceRateLimit(
  bucket: RateLimitBucket,
  identity: string,
  limiter: FixedWindowLimiter = rateLimiter,
): RateLimitDecision {
  const decision = limiter.consume(identity, bucket);
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new RateLimitError(
      bucket.name,
      decision.retryAfterMs,
      `Too many requests. Try again in ${seconds}s.`,
    );
  }
  return decision;
}
