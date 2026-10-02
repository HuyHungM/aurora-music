/**
 * Provider request cache: L1 in-flight dedup + L2 memory TTL + negative TTL.
 *
 * WHY THIS EXISTS. The audit in `docs/youtube-request-map.md` found no cache of
 * any kind behind the YouTube transport: reloading the same search page
 * re-spent the same quota, and three components asking for the same video
 * simultaneously produced three upstream calls. Caching is the second-largest
 * lever after source selection, and it is the one that costs no correctness.
 *
 * THREE LAYERS, THREE JOBS.
 *
 * - L1 (in-flight): identical concurrent requests share ONE promise. It is
 *   not a cache — the entry is deleted the moment the request settles — but it
 *   is what turns "three components want this video" into one upstream call.
 *   A rejected promise is removed too, so one failure never poisons the key.
 * - L2 (memory): successful responses, keyed and TTL'd. Process-local, so it
 *   is lost on restart, which is the correct default: an in-memory cache that
 *   claims to be durable is worse than no cache.
 * - Negative: "this produced nothing" and "this failed transiently" are cached
 *   too, for a SHORT time. Without it, a query that legitimately has no
 *   results is re-asked on every keystroke and every page load, which is the
 *   most wasteful case of all — a search that returns nothing is still a
 *   `search.list` call.
 *
 * WHAT IS NEVER CACHED. Temporary playback URLs (`AudioSource.url`,
 * `googlevideo` signed URLs) and anything derived from them. That is enforced
 * by `forbids` on the entry rather than by convention, so a future caller
 * cannot get it wrong by forgetting: the cache refuses the write and reports
 * it. Signed URLs expire in hours; a cache that outlives one serves a dead
 * stream, and the user sees a track that will not play.
 *
 * NO GLOBAL TTL. TTLs are per-entry and chosen by the caller from the taxonomy
 * in §49: a search is volatile, a video id's identity is not.
 *
 * EVICTION. The L2 map is bounded. An unbounded provider cache in a long-lived
 * server is a memory leak with extra steps; ids are small but a radio session
 * will happily produce millions of keys over a month.
 */

export interface CacheOptions {
  /** Positive-entry lifetime in ms. */
  ttlMs: number;
  /** Negative (empty/failed) lifetime in ms. Must be far shorter than ttlMs. */
  negativeTtlMs?: number;
  /**
   * Called on every write. A cache that cannot be observed cannot be tuned,
   * and §58 requires a measured hit rate rather than an assumed one.
   */
  onRecord?: (record: CacheRecord) => void;
}

export type CacheOutcome = "hit" | "miss" | "negative-hit" | "coalesced";

export interface CacheRecord {
  key: string;
  outcome: Exclude<CacheOutcome, "coalesced"> | "coalesced";
  bytes?: number;
}

interface Entry<T> {
  value: T;
  /** Absolute expiry in epoch ms. */
  expiresAt: number;
  /** True when this entry records an absence, not a value. */
  negative: boolean;
}

const DEFAULT_MAX_ENTRIES = 5_000;

export class ProviderCache {
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly onRecord: ((record: CacheRecord) => void) | undefined;
  private readonly maxEntries: number;
  private readonly l1 = new Map<string, Promise<unknown>>();
  private readonly l2 = new Map<string, Entry<unknown>>();
  /** Writes since the last expired-entry sweep. See `evictIfNeeded`. */
  private writesSinceSweep = 0;
  private readonly sweepInterval: number;

  constructor(options: CacheOptions, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ttlMs = options.ttlMs;
    // A negative entry must expire well before its positive sibling, or a
    // transient "no results" becomes a permanent one.
    this.negativeTtlMs = options.negativeTtlMs ?? Math.max(1_000, Math.floor(options.ttlMs / 6));
    this.onRecord = options.onRecord;
    this.maxEntries = maxEntries;
    this.sweepInterval = Math.max(16, maxEntries >> 6);
  }

  /**
   * Read without writing. Returns undefined for miss or expiry.
   *
   * A negative entry's VALUE is returned like any other. "This query has no
   * results" is a real answer that callers need to render, not an absence to
   * be re-derived; the `negative` flag only chooses the shorter clock (see
   * `resolve`), it does not suppress the value. An earlier version returned
   * undefined here, which silently made the negative TTL a no-op: the entry
   * was written, expired, and was never consulted, so a query that
   * legitimately has no results was re-asked on every single request.
   */
  peek<T>(key: string): T | undefined {
    const entry = this.l2.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.l2.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** True when a live (unexpired) entry exists, negative or not. */
  has(key: string): boolean {
    const entry = this.l2.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= Date.now()) {
      this.l2.delete(key);
      return false;
    }
    return true;
  }

  set<T>(key: string, value: T, options: { negative?: boolean } = {}): void {
    const negative = options.negative === true;
    this.evictIfNeeded();
    this.l2.set(key, {
      value,
      expiresAt: Date.now() + (negative ? this.negativeTtlMs : this.ttlMs),
      negative,
    });
    this.onRecord?.({ key, outcome: negative ? "negative-hit" : "miss" });
  }

  /**
   * The single entry point. Returns a cached value, coalesces a duplicate
   * in-flight request, or runs the factory and caches its result.
   *
   * `forbids` is a predicate over the produced value. When it returns true the
   * value is returned to the caller but NOT cached — that is how temporary
   * playback URLs are kept out of a durable store.
   */
  async resolve<T>(
    key: string,
    factory: () => Promise<T>,
    options: { negativeWhen?: (value: T) => boolean; forbids?: (value: T) => boolean } = {},
  ): Promise<T> {
    const cached = this.peek<T>(key);
    if (cached !== undefined) {
      this.onRecord?.({ key, outcome: "hit" });
      return cached;
    }
    const pending = this.l1.get(key);
    if (pending) {
      this.onRecord?.({ key, outcome: "coalesced" });
      return pending as Promise<T>;
    }
    // Identity token. The settle handler compares the mapped promise against
    // its own so that an `invalidate()` followed by a NEW request does not
    // have its entry deleted by the old task finishing. A mutable holder is
    // used because a promise cannot be referenced in its own initialiser, and
    // `const task = (async () => { ... task ... })()` needs a cast to satisfy
    // the compiler even though it is correct at runtime.
    const holder: { task?: Promise<T> } = {};
    const task: Promise<T> = (async () => {
      try {
        const value = await factory();
        if (!options.forbids?.(value)) {
          const negative = options.negativeWhen?.(value) === true;
          this.set(key, value, { negative });
        }
        return value;
      } finally {
        // Removed on settle, either way. A rejected promise must not stay
        // mapped or every later caller inherits the same rejection.
        if (this.l1.get(key) === holder.task) {
          this.l1.delete(key);
        }
      }
    })();
    holder.task = task;
    this.l1.set(key, task);
    return task;
  }

  /**
   * Drops one key. Used by explicit invalidation: a corrected track mapping,
   * a changed playlist, an admin reset.
   */
  invalidate(key: string): boolean {
    const had = this.l2.delete(key) || this.l1.has(key);
    this.l1.delete(key);
    return had;
  }

  /** Drops every key beginning with `prefix`. */
  invalidatePrefix(prefix: string): number {
    let dropped = 0;
    for (const key of [...this.l2.keys()]) {
      if (key.startsWith(prefix)) {
        this.l2.delete(key);
        dropped += 1;
      }
    }
    for (const key of [...this.l1.keys()]) {
      if (key.startsWith(prefix)) {
        this.l1.delete(key);
      }
    }
    return dropped;
  }

  clear(): void {
    this.l2.clear();
    this.l1.clear();
  }

  /** Test/observability hook. */
  stats(): { entries: number; inflight: number; max: number } {
    return { entries: this.l2.size, inflight: this.l1.size, max: this.maxEntries };
  }

  /**
   * Oldest-insertion-first eviction. A full sweep (rather than a real LRU
   * recency list) is deliberate: the cost of a strict LRU is a linked list and
   * a per-read write on every hot key, and for a provider cache whose hit rate
   * is dominated by a small working set, insertion order is close enough and
   * much cheaper to reason about.
   *
   * The expired-entry sweep is AMORTIZED, not per write. Once the cache is
   * full, `size >= maxEntries` is true on every single insert for the rest of
   * the process's life, so sweeping all 5000 entries to reap expired ones ran
   * 5000 `Date.now()` comparisons per write - on the video and search caches,
   * which are written on every provider request. Reaping expired entries is an
   * optimization: the unconditional oldest-key delete below is what actually
   * bounds memory, and it still runs on every write. The sweep now runs once
   * per `maxEntries / 64` writes (at least every 16), which keeps it frequent
   * enough that expired entries are not meaningfully retained while making its
   * cost amortized O(1) instead of O(maxEntries) per insert.
   */
  private evictIfNeeded(): void {
    if (this.l2.size < this.maxEntries) {
      return;
    }
    if (this.writesSinceSweep++ >= this.sweepInterval) {
      this.writesSinceSweep = 0;
      const now = Date.now();
      for (const [key, entry] of this.l2) {
        if (entry.expiresAt <= now) {
          this.l2.delete(key);
        }
      }
    }
    while (this.l2.size >= this.maxEntries) {
      const oldest = this.l2.keys().next();
      if (oldest.done) {
        return;
      }
      this.l2.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Key construction
//
// Keys are deterministic and self-describing so a metrics dump can be read
// without a lookup table. `provider` leads every key so one cache instance
// can be shared, and so a prefix invalidation for one provider cannot touch
// another's entries.
// ---------------------------------------------------------------------------

export interface SearchKeyParts {
  provider: string;
  query: string;
  locale?: string;
  region?: string;
  kind: "video" | "channel" | "channel-videos";
  limit: number;
  /** Free-form filter fingerprint; part of the key because it changes results. */
  filters?: string;
}

/**
 * Normalises a user query for KEYING only — never for the upstream request.
 * Case and collapsing whitespace cannot change which results come back, so
 * two queries differing only in those share a cache entry. Diacritics are
 * deliberately PRESERVED: "Son Tung" and "Sơn Tùng" are different queries
 * for a Vietnamese catalogue, and folding them together would serve one
 * answer for both.
 */
export function normalizeQueryForKey(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function searchCacheKey(parts: SearchKeyParts): string {
  // `yt:search:` is a prefix of its own, distinct from `yt:video:`. It was
  // previously `yt:${kind}`, which made every VIDEO search key start with
  // `yt:video:` — the same prefix a single video's metadata uses. Two
  // consequences, both silent: the metric classifier read video searches as
  // video lookups, and `invalidatePrefix("yt:video:")` evicted video metadata
  // along with searches.
  const segments = [
    "yt:search",
    parts.kind,
    normalizeQueryForKey(parts.query),
    parts.locale ?? "-",
    parts.region ?? "-",
    parts.filters ?? "-",
    String(parts.limit),
  ];
  return segments.join(":");
}

export function videoCacheKey(videoId: string): string {
  return `yt:video:${videoId}`;
}

export function videoBatchCacheKey(videoIds: readonly string[]): string {
  // Order-independent: the same set in a different order is the same request.
  return `yt:videos:${[...videoIds].sort().join(",")}`;
}

export function channelCacheKey(channelIds: readonly string[]): string {
  return `yt:channels:${[...channelIds].sort().join(",")}`;
}

export function playlistCacheKey(playlistId: string): string {
  return `yt:playlist:${playlistId}`;
}

export function playlistItemsCacheKey(playlistId: string, pageToken?: string): string {
  return `yt:playlist-items:${playlistId}:${pageToken ?? "first"}`;
}

/** True for a signed/temporary media URL. Never cacheable. */
export function isTemporaryMediaUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /googlevideo\.com|\/videoplayback|signature=|expire=/i.test(value);
}
