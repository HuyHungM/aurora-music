/**
 * Data API quota circuit breaker (Phase 55).
 *
 * THE PROBLEM THIS FIXES. `client.ts` already mapped Google's
 * `quotaExceeded` and `dailyLimitExceeded` reasons to a non-retryable error,
 * which is right. What was missing is that non-retryable is not the same as
 * "stop calling". A `dailyLimitExceeded` with `retryable: false` still means
 * the *next* user request makes another Data API call that also fails. Not a
 * retry loop, but a call-per-request, all of which burn latency and produce
 * error paths. §37 requires quota exhaustion to be represented as its own
 * state, and this is that state.
 *
 * WHAT THE OPEN CIRCUIT DOES. It refuses Data API calls, so the tiered
 * transport falls back to cached results and lets the InnerTube path proceed.
 * It does NOT disable YouTube: only the official API is scarce, and that is
 * the entire premise of this phase.
 *
 * WHY A DURATION AND NOT "UNTIL RESTART". A permanently open circuit would
 * mean one bad afternoon costs a deployment. The window is derived from the
 * offending reason: a daily limit reopens after 23h, a per-minute rate limit
 * after 60s.
 *
 * HOW IT RECOVERS, AND WHY IT IS NOT "A SUCCESSFUL CALL". A circuit that
 * refuses every call can never observe a success — so `reportSuccess()` cannot
 * be the recovery mechanism for the case that matters. Recovery is the WINDOW
 * EXPIRY acting as a half-open probe: once the window has passed, `shouldSkip`
 * returns false, the next call goes out, and its result decides whether the
 * circuit stays closed. This is deliberate for a quota limit. Probing a
 * knowingly-exhausted daily budget every few seconds is precisely the retry
 * storm §37 exists to prevent — the answer to "has the quota reset?" is the
 * clock, not another request. `reportSuccess()` still closes the circuit early,
 * which matters for the transient classes where a probe already got through.
 *
 * InnerTube is deliberately NOT behind this breaker. It has different rate
 * behaviour and is the primary path; short-circuiting it on a Data API
 * failure would take out the one path that still works.
 *
 * STATE IS PER INSTANCE, not module-level. `client.ts` accepts an injected
 * circuit so a test can run without inheriting another test's open breaker.
 * Module-level state would have quietly defeated that affordance: every
 * instance would share one counter and one open flag, and a test that tripped
 * the breaker would silently suppress calls in every later test.
 */

import { logger } from "@/lib/diagnostics/logger";
import { recordYouTubeMetric, setDataApiCircuitState } from "./metrics";

export type QuotaClass = "daily" | "rate" | "throttle" | "none";

/** Google's own reason strings, plus the HTTP status they arrive with. */
const DAILY_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export function classifyQuotaFailure(reason: string | null, status: number): QuotaClass {
  if (reason !== null && DAILY_REASONS.has(reason)) {
    return "daily";
  }
  if (reason !== null && RATE_REASONS.has(reason)) {
    return "rate";
  }
  if (status === 429) {
    return "throttle";
  }
  return "none";
}

/** How long the circuit stays open, per quota class. */
const OPEN_MS: Record<Exclude<QuotaClass, "none">, number> = {
  // 23h: leave headroom before Google's midnight-UTC reset rather than
  // reopening into a still-exhausted window.
  daily: 23 * 60 * 60_000,
  // 60s: a per-minute limit clears within the minute.
  rate: 60_000,
  // 5s: a bare 429 with no reason gives us nothing to go on; probe quickly.
  throttle: 5_000,
};

const MAX_CONSECUTIVE_FAILURES = 3;

export interface CircuitState {
  open: boolean;
  reason: string | null;
  openedAt: number | null;
  consecutiveFailures: number;
  /** Total trips for this instance, for observability. */
  trips: number;
}

function initialState(trips = 0): CircuitState {
  return { open: false, reason: null, openedAt: null, consecutiveFailures: 0, trips };
}

export class DataApiCircuit {
  private state: CircuitState = initialState();
  private quotaClass: QuotaClass = "none";

  /** Call before every Data API request. True means "do not call it". */
  shouldSkip(): boolean {
    if (!this.state.open || this.state.openedAt === null) {
      return false;
    }
    const window = this.quotaClass === "none" ? OPEN_MS.throttle : OPEN_MS[this.quotaClass];
    if (Date.now() - this.state.openedAt >= window) {
      this.reset();
      return false;
    }
    return true;
  }

  isOpen(): boolean {
    return this.shouldSkip();
  }

  /** A classified quota failure. Opens the circuit for the matching window. */
  reportQuotaFailure(reason: string | null, status: number): void {
    const quotaClass = classifyQuotaFailure(reason, status);
    if (quotaClass === "none") {
      return;
    }
    this.quotaClass = quotaClass;
    this.state.consecutiveFailures += 1;
    recordYouTubeMetric("quota_exceeded");
    if (quotaClass === "throttle" && this.state.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      // A single 429 is noise. Opening on it would disable the fallback
      // path for five seconds every time a single request raced.
      return;
    }
    this.state.open = true;
    this.state.reason = reason ?? `http-${status}`;
    this.state.openedAt = Date.now();
    this.state.trips += 1;
    setDataApiCircuitState(true, this.state.reason);
    // Google's own reason string and the status code are safe to log: they
    // are protocol constants, not credentials. What is deliberately absent is
    // anything about the request or the key, because this is the log line an
    // operator reads when the official budget runs out.
    logger.warn(
      "YouTube Data API quota failure; official calls paused",
      { event: "youtube.data_api.quota", quota: quotaClass, status, reason: this.state.reason },
    );
  }

  /** Any successful Data API response closes the circuit early. */
  reportSuccess(): void {
    this.state.consecutiveFailures = 0;
    if (this.state.open) {
      this.reset();
    }
  }

  /** A non-quota failure (5xx, network). Not a quota signal. */
  reportOtherFailure(): void {
    this.state.consecutiveFailures += 1;
  }

  snapshot(): CircuitState {
    return { ...this.state };
  }

  reset(): void {
    const wasOpen = this.state.open;
    const reason = this.state.reason;
    // Trips survive a reset: a counter that reset with the circuit would hide
    // a recurring problem, and seeing the same failure twice is the point.
    this.state = initialState(this.state.trips);
    this.quotaClass = "none";
    setDataApiCircuitState(false, null);
    if (wasOpen) {
      logger.info("YouTube Data API quota circuit closed; official calls resumed", {
        event: "youtube.data_api.quota_recovered",
        reason: reason ?? "unknown",
      });
    }
  }
}

/**
 * The process-wide breaker. One quota budget, one breaker — a second
 * instance over the same API key would double-count trips and could close a
 * circuit another instance still believes is open.
 */
export const dataApiCircuit = new DataApiCircuit();
