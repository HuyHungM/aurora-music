import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTENT_MAX_REMEMBERED_KEYS,
  INTENT_MIN_INTERVAL_MS,
  INTENT_REWARM_COOLDOWN_MS,
  claimIntentPrefetch,
  resetIntentPrefetchForTests,
} from "@/lib/playback/prefetch-intent";

describe("prefetch intent gate", () => {
  beforeEach(() => {
    resetIntentPrefetchForTests();
  });

  afterEach(() => {
    resetIntentPrefetchForTests();
  });

  it("accepts the first intent for a track", () => {
    expect(claimIntentPrefetch("youtube:abc", 1_000_000)).toBe(true);
  });

  it("refuses a repeat hover inside the cooldown window", () => {
    expect(claimIntentPrefetch("youtube:abc", 1_000_000)).toBe(true);
    expect(claimIntentPrefetch("youtube:abc", 1_000_000 + 1_000)).toBe(false);
  });

  it("re-warms past the cooldown, mirroring the server TTL", () => {
    expect(claimIntentPrefetch("youtube:abc", 1_000_000)).toBe(true);
    expect(
      claimIntentPrefetch("youtube:abc", 1_000_000 + INTENT_REWARM_COOLDOWN_MS),
    ).toBe(true);
  });

  it("throttles sweeps: intents faster than the interval are dropped", () => {
    expect(claimIntentPrefetch("youtube:one", 1_000_000)).toBe(true);
    // A pointer crossing the next row 50ms later is a sweep, not intent.
    expect(claimIntentPrefetch("youtube:two", 1_000_000 + 50)).toBe(false);
    expect(
      claimIntentPrefetch("youtube:two", 1_000_000 + INTENT_MIN_INTERVAL_MS),
    ).toBe(true);
  });

  it("bounds remembered keys", () => {
    for (let i = 0; i < INTENT_MAX_REMEMBERED_KEYS + 10; i += 1) {
      claimIntentPrefetch(`youtube:${i}`, 1_000_000 + i * INTENT_MIN_INTERVAL_MS);
    }
    // The oldest keys were evicted, so they are claimable again past the
    // interval — the set cannot grow without bound across a long session.
    expect(
      claimIntentPrefetch("youtube:0", 1_000_000 + (INTENT_MAX_REMEMBERED_KEYS + 11) * INTENT_MIN_INTERVAL_MS),
    ).toBe(true);
  });

  it("keys by provider and id, never by nothing", () => {
    expect(claimIntentPrefetch("youtube:abc", 1_000_000)).toBe(true);
    expect(claimIntentPrefetch("youtube:abd", 1_000_000 + INTENT_MIN_INTERVAL_MS)).toBe(true);
  });
});
