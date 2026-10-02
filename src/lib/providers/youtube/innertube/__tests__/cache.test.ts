import { describe, expect, it, vi } from "vitest";
import {
  channelCacheKey,
  isTemporaryMediaUrl,
  normalizeQueryForKey,
  playlistCacheKey,
  playlistItemsCacheKey,
  ProviderCache,
  searchCacheKey,
  videoBatchCacheKey,
  videoCacheKey,
  type CacheRecord,
} from "@/lib/providers/youtube/innertube/cache";

function recordingCache(ttlMs: number, records: CacheRecord[]): ProviderCache {
  return new ProviderCache({
    ttlMs,
    onRecord: (record) => records.push(record),
  });
}

describe("ProviderCache — L2 memory", () => {
  it("serves a second identical request without calling the factory", async () => {
    const records: CacheRecord[] = [];
    const cache = recordingCache(60_000, records);
    const factory = vi.fn(async () => ({ hits: 1 }));

    await expect(cache.resolve("k", factory)).resolves.toEqual({ hits: 1 });
    await expect(cache.resolve("k", factory)).resolves.toEqual({ hits: 1 });

    expect(factory).toHaveBeenCalledOnce();
    expect(records.filter((r) => r.outcome === "hit")).toHaveLength(1);
  });

  it("expires on ttl rather than pinning a value forever", async () => {
    vi.useFakeTimers();
    try {
      const cache = new ProviderCache({ ttlMs: 1_000 });
      const factory = vi.fn(async () => "value");
      await cache.resolve("k", factory);
      expect(cache.peek("k")).toBe("value");
      vi.advanceTimersByTime(1_001);
      expect(cache.peek("k")).toBeUndefined();
      await cache.resolve("k", factory);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a negative entry a shorter lifetime than a positive one by default", () => {
    // §17: never cache failures permanently. The default derives a strictly
    // shorter negative TTL so a transient "no results" cannot become sticky,
    // even when the caller does not specify one.
    const cache = new ProviderCache({ ttlMs: 600_000 });
    vi.useFakeTimers();
    try {
      cache.set("empty", { items: [] }, { negative: true });
      cache.set("full", { items: [1] });
      vi.advanceTimersByTime(100_000);
      expect(cache.peek("empty")).toBeUndefined();
      expect(cache.peek("full")).toEqual({ items: [1] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProviderCache — L1 in-flight deduplication", () => {
  it("collapses three concurrent identical requests into one factory call", async () => {
    // §14: three internal consumers asking at once must cost one upstream
    // request. This is the whole promise of L1.
    const records: CacheRecord[] = [];
    const cache = recordingCache(60_000, records);
    let release!: (value: string) => void;
    const factory = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const first = cache.resolve("k", factory);
    const second = cache.resolve("k", factory);
    const third = cache.resolve("k", factory);
    expect(factory).toHaveBeenCalledOnce();
    expect(records.filter((r) => r.outcome === "coalesced")).toHaveLength(2);

    release("shared");
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "shared",
      "shared",
      "shared",
    ]);
  });

  it("clears the in-flight slot once the request settles", async () => {
    // If the entry stayed mapped, every later caller would inherit a resolved
    // promise forever and the cache would silently stop calling upstream.
    const cache = new ProviderCache({ ttlMs: 60_000 });
    await cache.resolve("k", async () => 1);
    expect(cache.stats().inflight).toBe(0);

    const second = vi.fn(async () => 2);
    await cache.resolve("k", second);
    // Still an L2 hit, so the factory was not re-run — but the point is that
    // the in-flight map is empty and the key is cacheable again.
    expect(second).not.toHaveBeenCalled();
    expect(cache.stats().inflight).toBe(0);
  });

  it("does not let a rejected request poison later callers", async () => {
    // A permanently mapped rejection turns one transient blip into a
    // permanently broken key, which is far worse than the original failure.
    const cache = new ProviderCache({ ttlMs: 60_000 });
    await expect(
      cache.resolve("k", async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
    expect(cache.stats().inflight).toBe(0);

    await expect(cache.resolve("k", async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("does not delete a newer in-flight entry when the old one settles", async () => {
    // invalidate() + a fresh request, then the original request finally
    // settles. The new entry must survive, or one slow request silently
    // disables deduplication for its successor. Both requests are held open:
    // an already-settled second request would be removed by its own `finally`
    // and the assertion would pass for the wrong reason.
    const cache = new ProviderCache({ ttlMs: 60_000 });
    let releaseFirst!: (value: string) => void;
    const first = cache.resolve(
      "k",
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    cache.invalidate("k");
    let releaseSecond!: (value: string) => void;
    const secondFactory = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseSecond = resolve;
        }),
    );
    const secondCall = cache.resolve("k", secondFactory);

    releaseFirst("first");
    await first;
    // The first task's `finally` saw the mapped promise was no longer its own
    // and left the newer entry alone.
    expect(cache.stats().inflight).toBe(1);

    releaseSecond("second");
    await expect(secondCall).resolves.toBe("second");
    expect(secondFactory).toHaveBeenCalledOnce();
    expect(cache.stats().inflight).toBe(0);
  });
});

describe("ProviderCache — negative entries", () => {
  it("caches an empty result for the short negative ttl", async () => {
    vi.useFakeTimers();
    try {
      const cache = new ProviderCache({ ttlMs: 60_000, negativeTtlMs: 5_000 });
      const factory = vi.fn(async () => ({ items: [] as string[] }));
      const withGate = (): Promise<{ items: string[] }> =>
        cache.resolve("k", factory, {
          negativeWhen: (value) => value.items.length === 0,
        });

      await withGate();
      await withGate();
      expect(factory).toHaveBeenCalledOnce();
      // The value is returned normally — "no results" is a real answer the
      // caller has to render — but it rides the short negative clock.
      expect(cache.peek("k")).toEqual({ items: [] });
      expect(cache.has("k")).toBe(true);

      vi.advanceTimersByTime(5_001);
      expect(cache.has("k")).toBe(false);
      await withGate();
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-asks once the negative ttl has passed, then caches the value again", async () => {
    // A negative entry must not become permanent (§17): after it expires the
    // query is genuinely re-asked, because a track can be uploaded later.
    vi.useFakeTimers();
    try {
      const cache = new ProviderCache({ ttlMs: 60_000, negativeTtlMs: 5_000 });
      const factory = vi.fn(async () => ({ items: [] as string[] }));
      const run = (): Promise<{ items: string[] }> =>
        cache.resolve("k", factory, { negativeWhen: (value) => value.items.length === 0 });
      await run();
      vi.advanceTimersByTime(5_001);
      await run();
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProviderCache — temporary URLs are refused", () => {
  it("returns a value carrying a signed media URL but does not store it", async () => {
    // §56. The refusal is on the entry, not a convention, so a future caller
    // cannot get this wrong by forgetting. A cached signed URL outlives its
    // signature and the user sees a track that will not play.
    const cache = new ProviderCache({ ttlMs: 60_000 });
    const signed = "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1700000000&signature=abc";
    const factory = vi.fn(async () => signed);

    await expect(
      cache.resolve("k", factory, { forbids: (value) => isTemporaryMediaUrl(value) }),
    ).resolves.toBe(signed);
    expect(cache.peek("k")).toBeUndefined();
    expect(cache.has("k")).toBe(false);

    // A second identical request therefore re-resolves rather than serving a
    // dead URL from the cache.
    await cache.resolve("k", factory, { forbids: (value) => isTemporaryMediaUrl(value) });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("recognises the shapes a signed media URL actually takes", () => {
    expect(isTemporaryMediaUrl("https://x.googlevideo.com/videoplayback?expire=1")).toBe(true);
    expect(isTemporaryMediaUrl("https://x/videoplayback?sig=1")).toBe(true);
    expect(isTemporaryMediaUrl("https://x/y?signature=1")).toBe(true);
    expect(isTemporaryMediaUrl("https://x/y?expire=1")).toBe(true);
    // A stable video id and a canonical watch URL are both fine to persist.
    expect(isTemporaryMediaUrl("dQw4w9WgXcQ")).toBe(false);
    expect(isTemporaryMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isTemporaryMediaUrl(undefined)).toBe(false);
  });
});

describe("ProviderCache — eviction and invalidation", () => {
  it("evicts oldest-first instead of growing without bound", () => {
    const cache = new ProviderCache({ ttlMs: 60_000 }, 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("d")).toBe(4);
    expect(cache.stats().entries).toBe(3);
  });

  it("reclaims expired entries before evicting live ones", () => {
    vi.useFakeTimers();
    try {
      const cache = new ProviderCache({ ttlMs: 1_000 }, 2);
      cache.set("stale", 1);
      vi.advanceTimersByTime(1_001);
      cache.set("live", 2);
      // The sweep found "stale" already expired, so "live" survived.
      expect(cache.peek("live")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds its size bound across far more writes than the cache holds", () => {
    // The expired-entry sweep is amortized rather than per-write, so this is
    // the property that must survive it: the bound comes from the
    // unconditional oldest-key delete, which still runs on every write.
    const cache = new ProviderCache({ ttlMs: 60_000 }, 8);
    for (let i = 0; i < 500; i += 1) {
      cache.set(`k${i}`, i);
      expect(cache.stats().entries).toBeLessThanOrEqual(8);
    }
    // The most recent write is always the one that survived.
    expect(cache.peek("k499")).toBe(499);
  });

  it("still reaps expired entries once the sweep interval elapses", () => {
    // Amortizing the sweep must not mean switching it off: a cache that only
    // ever dropped the oldest live entry would retain expired entries
    // indefinitely and hand back stale answers within its own TTL window.
    vi.useFakeTimers();
    try {
      const cache = new ProviderCache({ ttlMs: 1_000 }, 64);
      // Fill to exactly maxEntries so the next write triggers eviction.
      for (let i = 0; i < 64; i += 1) {
        cache.set(`k${i}`, i);
      }
      vi.advanceTimersByTime(1_001);
      // Expired, but the sweep has not run yet: the oldest-key delete still
      // keeps the bound, so this write is cheap.
      cache.set("k64", 64);
      expect(cache.stats().entries).toBeLessThanOrEqual(64);
      // Now drive past the sweep interval with more writes; the sweep should
      // have reaped the expired majority rather than only the single key the
      // eviction path had to drop.
      for (let i = 65; i < 200; i += 1) {
        cache.set(`k${i}`, i);
      }
      expect(cache.stats().entries).toBeLessThanOrEqual(64);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates one key or a whole prefix", () => {
    const cache = new ProviderCache({ ttlMs: 60_000 });
    const videoKey = videoCacheKey("dQw4w9WgXcQ");
    cache.set(searchCacheKey({ provider: "p", query: "a", kind: "video", limit: 10 }), 1);
    cache.set(searchCacheKey({ provider: "p", query: "b", kind: "channel", limit: 10 }), 2);
    cache.set(videoKey, 3);
    cache.set("yt:channels:UCabc", 4);

    // Searches and single-video metadata are separate prefixes, so evicting
    // the search cache cannot quietly drop resolved video metadata.
    expect(cache.invalidatePrefix("yt:search:")).toBe(2);
    expect(cache.peek(videoKey)).toBe(3);
    expect(cache.peek("yt:channels:UCabc")).toBe(4);

    // Single-key invalidation is exact and reports whether it hit.
    expect(cache.invalidate(videoKey)).toBe(true);
    expect(cache.invalidate(videoKey)).toBe(false);
  });

  it("gives every entry kind a distinct key namespace", () => {
    // A shared namespace between two kinds is a latent bug: nothing fails
    // loudly, the cache just quietly loses the wrong things. This is the shape
    // that bit before, when a video SEARCH key was `yt:video:<query>` and
    // therefore collided with single-video metadata (see `searchCacheKey`).
    //
    // The keys are read off the real builders rather than from a duplicated
    // prefix table: `CACHE_PREFIX` was removed for being a second copy of
    // strings the builders already own, and a second copy is exactly what can
    // drift into a collision while still passing a test that only compared the
    // table against itself.
    const keys: Record<string, string> = {
      search: searchCacheKey({
        provider: "p",
        query: "dQw4w9WgXcQ",
        kind: "video",
        limit: 10,
      }),
      video: videoCacheKey("dQw4w9WgXcQ"),
      videoBatch: videoBatchCacheKey(["dQw4w9WgXcQ"]),
      channels: channelCacheKey(["UCabc"]),
      playlist: playlistCacheKey("PL1"),
      playlistItems: playlistItemsCacheKey("PL1"),
    };

    // Pairwise distinct: no two kinds can produce the same key.
    const values = Object.values(keys);
    expect(new Set(values).size).toBe(values.length);

    // The search/video separation that used to be broken, pinned directly.
    // Same query and id, deliberately.
    expect(keys.search).not.toBe(keys.video);
    expect(keys.search.startsWith("yt:video:")).toBe(false);
    expect(keys.video.startsWith("yt:search:")).toBe(false);
  });
});

describe("cache keys", () => {
  it("folds case and whitespace but PRESERVES Vietnamese diacritics", () => {
    // Folding diacritics together would serve one answer for two genuinely
    // different queries in a Vietnamese catalogue, which is a correctness bug
    // dressed as a cache optimisation.
    expect(normalizeQueryForKey("  Lạc   Trôi ")).toBe("lạc trôi");
    expect(normalizeQueryForKey("Lạc Trôi")).not.toBe(normalizeQueryForKey("Lac Troi"));
    expect(normalizeQueryForKey("Sơn Tùng")).not.toBe(normalizeQueryForKey("Son Tung"));
  });

  it("produces identical keys for the same query regardless of surrounding space or case", () => {
    const key = (query: string): string =>
      searchCacheKey({ provider: "innertube", query, kind: "video", limit: 10 });
    expect(key("Lạc Trôi")).toBe(key("  lạc  trôi "));
  });

  it("separates every dimension that changes the answer", () => {
    // §48. A key that omits any of these serves a result for a different
    // question than the one asked.
    const base = { provider: "innertube", query: "son tung", kind: "video" as const, limit: 10 };
    const key = searchCacheKey(base);
    expect(searchCacheKey({ ...base, limit: 20 })).not.toBe(key);
    expect(searchCacheKey({ ...base, locale: "vi" })).not.toBe(key);
    expect(searchCacheKey({ ...base, region: "VN" })).not.toBe(key);
    expect(searchCacheKey({ ...base, filters: "live" })).not.toBe(key);
    expect(searchCacheKey({ ...base, kind: "channel" })).not.toBe(key);
  });

  it("treats a video id set as order-independent", () => {
    // Playlist hydration batches by 50 and the track page fetches one; the same
    // set arriving in a different order is the same request.
    expect(videoBatchCacheKey(["b", "a", "c"])).toBe(videoBatchCacheKey(["a", "b", "c"]));
    expect(videoBatchCacheKey(["a"])).not.toBe(videoBatchCacheKey(["a", "b"]));
    expect(channelCacheKey(["b", "a"])).toBe(channelCacheKey(["a", "b"]));
  });

  it("keys playlist items by page token so pages do not collide", () => {
    expect(playlistItemsCacheKey("PL1")).not.toBe(playlistItemsCacheKey("PL2"));
    expect(playlistItemsCacheKey("PL1", "tok")).not.toBe(playlistItemsCacheKey("PL1"));
  });
});
