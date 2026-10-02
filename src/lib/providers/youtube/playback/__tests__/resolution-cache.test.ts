import { describe, expect, it } from "vitest";
import type { AudioSource } from "@/lib/domain";
import {
  DEFAULT_NEGATIVE_TTL_MS,
  DEFAULT_RESOLUTION_TTL_MS,
  DEFAULT_STALE_GRACE_MS,
  PlaybackResolutionCache,
  resolutionCacheKey,
  sharedResolutionCache,
} from "@/lib/providers/youtube/playback/resolution-cache";

function source(url = "https://cdn.example/a.m4a", expiresInMs = 3_600_000): AudioSource {
  return {
    url,
    mimeType: "audio/mp4",
    bitrate: 128_000,
    durationMs: 213_000,
    expiresAt: new Date(now + expiresInMs),
  };
}

let now = 1_000_000;
const clock = () => now;

function freshCache(options: ConstructorParameters<typeof PlaybackResolutionCache>[0] = {}) {
  now = 1_000_000;
  return new PlaybackResolutionCache({ now: clock, ...options });
}

describe("PlaybackResolutionCache", () => {
  it("misses cold and hits fresh", () => {
    const cache = freshCache();
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
    cache.set("dQw4w9WgXcQ", source());
    expect(cache.getFresh("dQw4w9WgXcQ")).toEqual(source());
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("keys by exact video id, never by title", () => {
    const cache = freshCache();
    cache.set("aaaabbbbcc1", source("https://cdn.example/1.m4a"));
    expect(cache.getFresh("aaaabbbbcc2")).toBeNull();
    expect(resolutionCacheKey("aaaabbbbcc1")).toContain("aaaabbbbcc1");
    expect(resolutionCacheKey("aaaabbbbcc1")).not.toContain("Song");
  });

  it("returns clones so callers cannot poison the entry", () => {
    const cache = freshCache();
    cache.set("dQw4w9WgXcQ", source());
    const first = cache.getFresh("dQw4w9WgXcQ");
    first!.url = "https://evil.example/x.m4a";
    expect(cache.getFresh("dQw4w9WgXcQ")?.url).toBe("https://cdn.example/a.m4a");
  });

  it("expires entries past the TTL", () => {
    const cache = freshCache({ ttlMs: 60_000 });
    cache.set("dQw4w9WgXcQ", source());
    now += 59_999;
    expect(cache.getFresh("dQw4w9WgXcQ")).not.toBeNull();
    now += 2;
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
    expect(cache.getStats().expired).toBe(1);
  });

  it("treats a URL dying inside the skew window as already dead", () => {
    const cache = freshCache({ expirySkewMs: 30_000 });
    // URL outlives the TTL check but dies 20s later: unusable.
    cache.set("dQw4w9WgXcQ", source("https://cdn.example/a.m4a", 20_000));
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
  });

  it("treats an already-expired URL as a miss even when fresh", () => {
    const cache = freshCache();
    cache.set("dQw4w9WgXcQ", source("https://cdn.example/a.m4a", -1_000));
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
  });

  it("serves stale inside the grace window and drops it past the edge", () => {
    const cache = freshCache({ ttlMs: 60_000, staleGraceMs: 30_000 });
    const expected = source();
    cache.set("dQw4w9WgXcQ", expected);
    now += 60_001;
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
    expect(cache.getStale("dQw4w9WgXcQ")).toEqual(expected);
    expect(cache.getStats().staleHits).toBe(1);
    now += 30_000;
    expect(cache.getStale("dQw4w9WgXcQ")).toBeNull();
  });

  it("never serves a dead URL stale", () => {
    const cache = freshCache({ ttlMs: 60_000, staleGraceMs: 30_000 });
    cache.set("dQw4w9WgXcQ", source("https://cdn.example/a.m4a", 70_000));
    now += 65_000;
    // Inside grace, but the URL dies inside the skew window.
    expect(cache.getStale("dQw4w9WgXcQ")).toBeNull();
  });

  it("invalidates explicitly and counts it", () => {
    const cache = freshCache();
    cache.set("dQw4w9WgXcQ", source());
    expect(cache.invalidate("dQw4w9WgXcQ")).toBe(true);
    expect(cache.getFresh("dQw4w9WgXcQ")).toBeNull();
    expect(cache.invalidate("dQw4w9WgXcQ")).toBe(false);
    expect(cache.getStats().invalidated).toBe(1);
  });

  it("advances the epoch on invalidate so an in-flight writer can detect it", () => {
    // The contract the resolver relies on. Deleting the entry is NOT enough:
    // a resolution already in flight finishes later and would re-insert the
    // very URL the caller just reported dead.
    const cache = freshCache();
    const before = cache.epochOf("dQw4w9WgXcQ");
    expect(cache.epochOf("dQw4w9WgXcQ")).toBe(before);
    cache.invalidate("dQw4w9WgXcQ");
    expect(cache.epochOf("dQw4w9WgXcQ")).toBeGreaterThan(before);
  });

  it("keeps epochs per video, so one invalidation cannot gate another", () => {
    const cache = freshCache();
    const a = cache.epochOf("aaaaaaaaaaa");
    const b = cache.epochOf("bbbbbbbbbbb");
    cache.invalidate("aaaaaaaaaaa");
    expect(cache.epochOf("aaaaaaaaaaa")).toBeGreaterThan(a);
    expect(cache.epochOf("bbbbbbbbbbb")).toBe(b);
  });

  it("cools down hard failures briefly and refuses retryable ones", () => {
    const cache = freshCache();
    cache.setNegative("dead1234567", {
      stage: "resolve",
      message: "Video is private",
      retryable: false,
    });
    expect(cache.getNegative("dead1234567")).toEqual({
      stage: "resolve",
      message: "Video is private",
      retryable: false,
    });
    expect(cache.getStats().negativeHits).toBe(1);
    now += DEFAULT_NEGATIVE_TTL_MS + 1;
    expect(cache.getNegative("dead1234567")).toBeNull();

    // A retryable failure must never be cached: the next attempt may succeed.
    cache.setNegative("flaky123456", {
      stage: "resolve",
      message: "timeout",
      retryable: false,
    });
    expect(cache.getNegative("flaky123456")).not.toBeNull();
  });

  it("evicts expired entries before live ones, then oldest-inserted", () => {
    const cache = freshCache({ ttlMs: 1_000, maxEntries: 3 });
    cache.set("old-live-01", source("https://cdn.example/old.m4a", 3_600_000));
    now += 2_000; // first entry is now expired
    cache.set("live-two-02", source("https://cdn.example/2.m4a"));
    cache.set("live-three3", source("https://cdn.example/3.m4a"));
    // Full: inserting a fourth must drop the expired entry, not a live one.
    cache.set("live-four-04", source("https://cdn.example/4.m4a"));
    expect(cache.getFresh("old-live-01")).toBeNull();
    expect(cache.getFresh("live-two-02")).not.toBeNull();
    expect(cache.getFresh("live-three3")).not.toBeNull();
    expect(cache.getFresh("live-four-04")).not.toBeNull();
    // Full of live entries: oldest-inserted goes next.
    now += 500;
    cache.set("live-five-05", source("https://cdn.example/5.m4a"));
    expect(cache.getFresh("live-two-02")).toBeNull();
    expect(cache.getFresh("live-five-05")).not.toBeNull();
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(2);
  });

  it("uses the documented default budgets", () => {
    expect(DEFAULT_RESOLUTION_TTL_MS).toBe(180_000);
    expect(DEFAULT_STALE_GRACE_MS).toBe(60_000);
    expect(DEFAULT_NEGATIVE_TTL_MS).toBe(10_000);
  });

  it("shares one process-local instance", () => {
    now = 1_000_000;
    const first = sharedResolutionCache();
    const second = sharedResolutionCache();
    expect(second).toBe(first);
  });
});
