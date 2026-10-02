import { describe, expect, it, vi } from "vitest";
import type { FanoutSearchResult } from "@/lib/providers/extractor-manager";
import { normalizeSearchQuery } from "@/lib/search/normalize";
import {
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  SEARCH_FAILURE_COOLDOWN_MS,
  SearchResultCache,
  configureSearchCache,
  getSearchSharedCount,
  resetSearchSharedCount,
  runCachedSearch,
  searchCacheKey,
  sharedSearchCache,
} from "@/lib/search/search-cache";

function fanout(query: string, succeeded = true): FanoutSearchResult {
  return {
    query,
    outcomes: [],
    tracks: [],
    succeeded,
  };
}

let now = 1_000_000;
const clock = () => now;

function freshCache(options = {}) {
  now = 1_000_000;
  return new SearchResultCache({ now: clock, ...options });
}

describe("searchCacheKey", () => {
  it("collapses case, punctuation, and diacritics onto one key", () => {
    const base = searchCacheKey(normalizeSearchQuery("cam on"));
    expect(searchCacheKey(normalizeSearchQuery("Cam  On"))).toBe(base);
    expect(searchCacheKey(normalizeSearchQuery("CẢM ƠN"))).toBe(base);
    expect(searchCacheKey(normalizeSearchQuery("  cam-on  "))).toBe(base);
  });

  it("keeps different questions apart", () => {
    expect(searchCacheKey(normalizeSearchQuery("cam on"))).not.toBe(
      searchCacheKey(normalizeSearchQuery("cam on now")),
    );
  });

  it("treats provider order as irrelevant", () => {
    // The manager sorts targets into canonical order, so these two fan-outs
    // are identical and must not occupy two entries.
    expect(searchCacheKey(normalizeSearchQuery("x"), { providers: ["a", "b"] })).toBe(
      searchCacheKey(normalizeSearchQuery("x"), { providers: ["b", "a"] }),
    );
  });

  it("separates different provider subsets", () => {
    expect(searchCacheKey(normalizeSearchQuery("x"), { providers: ["a"] })).not.toBe(
      searchCacheKey(normalizeSearchQuery("x"), { providers: ["a", "b"] }),
    );
  });

  it("separates different pagination", () => {
    // A different page is a different response, so it is part of the key.
    expect(searchCacheKey(normalizeSearchQuery("x"), { limit: 20 })).not.toBe(
      searchCacheKey(normalizeSearchQuery("x"), { limit: 40 }),
    );
    expect(searchCacheKey(normalizeSearchQuery("x"))).not.toBe(
      searchCacheKey(normalizeSearchQuery("x"), { limit: 20 }),
    );
  });
});

describe("SearchResultCache", () => {
  it("misses cold, then hits fresh", () => {
    const cache = freshCache();
    expect(cache.get("k")).toBeNull();
    cache.set("k", fanout("x"));
    expect(cache.get<FanoutSearchResult>("k")?.value.query).toBe("x");
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("expires past the TTL", () => {
    const cache = freshCache({ ttlMs: 1_000 });
    cache.set("k", fanout("x"));
    now += 1_001;
    expect(cache.get("k")).toBeNull();
  });

  it("uses the documented default budgets", () => {
    expect(SEARCH_CACHE_TTL_MS).toBe(60_000);
    expect(SEARCH_CACHE_MAX_ENTRIES).toBe(200);
    expect(SEARCH_FAILURE_COOLDOWN_MS).toBe(5_000);
  });

  it("evicts expired entries before live ones, then oldest-inserted", () => {
    const cache = freshCache({ ttlMs: 1_000, maxEntries: 3 });
    cache.set("old", fanout("old"));
    now += 2_000; // "old" is now expired
    cache.set("two", fanout("two"));
    cache.set("three", fanout("three"));
    cache.set("four", fanout("four"));
    // Full again: the expired entry went, not a live one.
    expect(cache.get("old")).toBeNull();
    expect(cache.get("two")).not.toBeNull();
    expect(cache.get("three")).not.toBeNull();
    expect(cache.get("four")).not.toBeNull();
    // All live now: oldest-inserted goes.
    now += 500;
    cache.set("five", fanout("five"));
    expect(cache.get("two")).toBeNull();
    expect(cache.get("five")).not.toBeNull();
  });

  it("bounds its size", () => {
    const cache = freshCache({ maxEntries: 10 });
    for (let i = 0; i < 50; i += 1) {
      cache.set(`k${i}`, fanout(`k${i}`));
    }
    expect(cache.size).toBeLessThanOrEqual(10);
  });

  it("reports a failure cooldown and then lets the request through", () => {
    const cache = freshCache({ failureCooldownMs: 5_000 });
    expect(cache.isCoolingDown("k")).toBe(false);
    cache.coolDown("k");
    expect(cache.isCoolingDown("k")).toBe(true);
    now += 5_001;
    expect(cache.isCoolingDown("k")).toBe(false);
  });

  it("clears a cooldown when a later search succeeds", () => {
    const cache = freshCache();
    cache.coolDown("k");
    cache.set("k", fanout("x"));
    expect(cache.isCoolingDown("k")).toBe(false);
  });

  it("shares one process instance", () => {
    configureSearchCache();
    expect(sharedSearchCache()).toBe(sharedSearchCache());
  });
});

describe("runCachedSearch", () => {
  function harness(options: { cacheable?: boolean } = {}) {
    const cache = freshCache();
    const run = vi.fn(async () => fanout("x", options.cacheable ?? true));
    const key = searchCacheKey(normalizeSearchQuery("x"));
    return { cache, run, key };
  }

  it("runs once, then serves the repeat from cache", async () => {
    const { cache, run, key } = harness();
    const first = await runCachedSearch({ cache, key, run, isCacheable: () => true });
    const second = await runCachedSearch({ cache, key, run, isCacheable: () => true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.query).toBe(first.query);
  });

  it("collapses three concurrent identical searches into one run", async () => {
    const cache = freshCache();
    let release!: (value: FanoutSearchResult) => void;
    const gate = new Promise<FanoutSearchResult>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const key = searchCacheKey(normalizeSearchQuery("x"));
    resetSearchSharedCount();

    const all = Promise.all([
      runCachedSearch({ cache, key, run, isCacheable: () => true }),
      runCachedSearch({ cache, key, run, isCacheable: () => true }),
      runCachedSearch({ cache, key, run, isCacheable: () => true }),
    ]);
    release(fanout("x"));
    const [a, b, c] = await all;
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(getSearchSharedCount()).toBe(2);
  });

  it("joins an in-flight search even before it has been cached", async () => {
    // The in-flight check runs before the cache read, so a concurrent twin
    // cannot slip past by arriving microseconds early.
    const cache = freshCache();
    let release!: (value: FanoutSearchResult) => void;
    const gate = new Promise<FanoutSearchResult>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const key = searchCacheKey(normalizeSearchQuery("x"));
    const first = runCachedSearch({ cache, key, run, isCacheable: () => true });
    const second = runCachedSearch({ cache, key, run, isCacheable: () => true });
    release(fanout("x"));
    expect(await first).toBe(await second);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not let different queries collide", async () => {
    const cache = freshCache();
    const run = vi.fn(async () => fanout("x"));
    await runCachedSearch({
      cache,
      key: searchCacheKey(normalizeSearchQuery("one")),
      run,
      isCacheable: () => true,
    });
    await runCachedSearch({
      cache,
      key: searchCacheKey(normalizeSearchQuery("two")),
      run,
      isCacheable: () => true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cleans up the in-flight entry after failure so a retry really retries", async () => {
    const cache = freshCache();
    const key = searchCacheKey(normalizeSearchQuery("x"));
    const boom = vi.fn(async () => {
      throw new Error("provider down");
    });
    await expect(
      runCachedSearch({ cache, key, run: boom, isCacheable: () => true }),
    ).rejects.toThrow("provider down");
    // A second attempt must reach the provider again, not replay the rejection.
    const ok = vi.fn(async () => fanout("x"));
    await expect(
      runCachedSearch({ cache, key, run: ok, isCacheable: () => true }),
    ).resolves.toMatchObject({ query: "x" });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not cache a total failure, and records the cooldown", async () => {
    const cache = freshCache({ failureCooldownMs: 5_000 });
    const key = searchCacheKey(normalizeSearchQuery("x"));
    const failing = vi.fn(async () => fanout("x", false));
    await runCachedSearch({ cache, key, run: failing, isCacheable: (v) => v.succeeded });
    // Nothing to serve: a failure is a provider condition, not a result.
    expect(cache.get(key)).toBeNull();
    expect(cache.isCoolingDown(key)).toBe(true);
  });

  it("still collapses a concurrent burst during a failure cooldown", async () => {
    // The cooldown is a signal, not a gate. If it short-circuited the run it
    // would have to either fabricate a result or reject without trying, and
    // either way a burst of retries would each start their own fan-out —
    // the storm the cooldown was meant to damp.
    const cache = freshCache({ failureCooldownMs: 60_000 });
    const key = searchCacheKey(normalizeSearchQuery("x"));
    let release!: (value: FanoutSearchResult) => void;
    const gate = new Promise<FanoutSearchResult>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const all = Promise.all([
      runCachedSearch({ cache, key, run, isCacheable: (v) => v.succeeded }),
      runCachedSearch({ cache, key, run, isCacheable: (v) => v.succeeded }),
      runCachedSearch({ cache, key, run, isCacheable: (v) => v.succeeded }),
    ]);
    release(fanout("x", false));
    await all;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure rather than replaying it", async () => {
    const cache = freshCache();
    const key = searchCacheKey(normalizeSearchQuery("x"));
    const failing = vi.fn(async () => fanout("x", false));
    await runCachedSearch({ cache, key, run: failing, isCacheable: (v) => v.succeeded });
    const healthy = vi.fn(async () => fanout("x", true));
    const result = await runCachedSearch({
      cache,
      key,
      run: healthy,
      isCacheable: (v) => v.succeeded,
    });
    expect(result.succeeded).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("caches a partial success", async () => {
    // A partial fan-out is usable results plus a warning; it IS a result.
    const cache = freshCache();
    const key = searchCacheKey(normalizeSearchQuery("x"));
    const run = vi.fn(async () => fanout("x", true));
    await runCachedSearch({ cache, key, run, isCacheable: (v) => v.succeeded });
    await runCachedSearch({ cache, key, run, isCacheable: (v) => v.succeeded });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
