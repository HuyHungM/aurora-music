import { describe, expect, it, vi } from "vitest";
import {
  classifyQuotaFailure,
  DataApiCircuit,
  dataApiCircuit,
} from "@/lib/providers/youtube/innertube/data-api-circuit";
import { resetYouTubeMetrics } from "@/lib/providers/youtube/innertube/metrics";

/**
 * §37/§38. The distinction these tests lock down is the one that costs real
 * quota: a DAILY limit is not a transient failure, and treating it as one
 * turns one exhausted day into a retry storm that spends what is left and
 * delays the reset.
 *
 * Every test builds its OWN circuit. That is the point of moving state onto the
 * instance: with module-level state, tripping the breaker in one test would
 * silently suppress calls in every later test, and the suite would pass while
 * testing nothing.
 */

describe("quota classification", () => {
  it("separates daily limits from rate limits from throttle from noise", () => {
    // Four different conditions with three different responses. Collapsing
    // them into "the API failed" is what §74 forbids.
    expect(classifyQuotaFailure("quotaExceeded", 403)).toBe("daily");
    expect(classifyQuotaFailure("dailyLimitExceeded", 403)).toBe("daily");
    expect(classifyQuotaFailure("rateLimitExceeded", 403)).toBe("rate");
    expect(classifyQuotaFailure("userRateLimitExceeded", 403)).toBe("rate");
    // A bare 429 with no reason says only "slow down".
    expect(classifyQuotaFailure(null, 429)).toBe("throttle");
    // A 500 is an upstream fault, not a quota signal.
    expect(classifyQuotaFailure("internalError", 500)).toBe("none");
    expect(classifyQuotaFailure(null, 403)).toBe("none");
  });
});

describe("DataApiCircuit", () => {
  it("the process-wide instance is the one production uses", () => {
    // Asserted so the "per instance" refactor above cannot be read as
    // permission to create breakers casually: one quota budget, one breaker.
    expect(dataApiCircuit).toBeInstanceOf(DataApiCircuit);
    dataApiCircuit.reset();
    dataApiCircuit.reportQuotaFailure("quotaExceeded", 403);
    expect(dataApiCircuit.shouldSkip()).toBe(true);
    dataApiCircuit.reset();
  });

  it("starts closed and stays closed for non-quota failures", () => {
    const circuit = new DataApiCircuit();
    expect(circuit.shouldSkip()).toBe(false);
    circuit.reportOtherFailure();
    circuit.reportOtherFailure();
    // A 5xx is not quota. Opening here would disable the fallback for an
    // outage the fallback is the answer to.
    expect(circuit.shouldSkip()).toBe(false);
  });

  it("opens immediately on a daily quota failure", () => {
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure("quotaExceeded", 403);
    expect(circuit.shouldSkip()).toBe(true);
    expect(circuit.snapshot().trips).toBe(1);
    expect(circuit.snapshot().reason).toBe("quotaExceeded");
  });

  it("opens on a rate limit immediately", () => {
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure("rateLimitExceeded", 403);
    expect(circuit.shouldSkip()).toBe(true);
  });

  it("tolerates a single bare 429 but opens on a sustained one", () => {
    // One 429 in a burst of parallel requests is noise. Opening on it would
    // disable the fallback path for five seconds every time requests raced.
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure(null, 429);
    expect(circuit.shouldSkip()).toBe(false);
    circuit.reportQuotaFailure(null, 429);
    expect(circuit.shouldSkip()).toBe(false);
    circuit.reportQuotaFailure(null, 429);
    expect(circuit.shouldSkip()).toBe(true);
  });

  it("reopens after its window rather than staying open until restart", () => {
    // A permanently open circuit would mean one bad afternoon costs a
    // deployment. The window is derived from the offending class, and a
    // successful call closes it early.
    vi.useFakeTimers();
    try {
      const circuit = new DataApiCircuit();
      circuit.reportQuotaFailure("rateLimitExceeded", 403);
      expect(circuit.shouldSkip()).toBe(true);
      vi.advanceTimersByTime(59_000);
      expect(circuit.shouldSkip()).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(circuit.shouldSkip()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a daily failure closed for nearly a day", () => {
    // 23h, not 24h: leave headroom before Google's midnight-UTC reset rather
    // than reopening into a still-exhausted window.
    vi.useFakeTimers();
    try {
      const circuit = new DataApiCircuit();
      circuit.reportQuotaFailure("dailyLimitExceeded", 403);
      vi.advanceTimersByTime(22 * 60 * 60_000);
      expect(circuit.shouldSkip()).toBe(true);
      vi.advanceTimersByTime(2 * 60 * 60_000);
      expect(circuit.shouldSkip()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes early on any successful call", () => {
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure("quotaExceeded", 403);
    expect(circuit.shouldSkip()).toBe(true);
    circuit.reportSuccess();
    expect(circuit.shouldSkip()).toBe(false);
  });

  it("clears the consecutive-failure count on success so a later 429 is noise again", () => {
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure(null, 429);
    circuit.reportQuotaFailure(null, 429);
    circuit.reportSuccess();
    circuit.reportQuotaFailure(null, 429);
    expect(circuit.shouldSkip()).toBe(false);
  });

  it("preserves the trip count across a reset so the metric is monotonic", () => {
    resetYouTubeMetrics();
    const circuit = new DataApiCircuit();
    circuit.reportQuotaFailure("quotaExceeded", 403);
    circuit.reset();
    circuit.reportQuotaFailure("quotaExceeded", 403);
    // Two trips happened. A counter that reset would hide a recurring
    // problem — the whole point of measuring it is seeing it twice.
    expect(circuit.snapshot().trips).toBe(2);
  });

  it("gives two instances independent state", () => {
    // The reason state is on the instance: `client.ts` lets a test inject its
    // own breaker so one test's quota failure cannot suppress calls in the
    // next. With shared state that affordance would be a lie.
    const tripped = new DataApiCircuit();
    const clean = new DataApiCircuit();
    tripped.reportQuotaFailure("quotaExceeded", 403);
    expect(tripped.shouldSkip()).toBe(true);
    expect(clean.shouldSkip()).toBe(false);
  });
});
