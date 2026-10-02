/**
 * Bounded, short-lived server-side cache and singleflight for unified search.
 *
 * WHAT PROBLEM THIS SOLVES (measured, not assumed). A repeated identical
 * search ran a full provider fan-out every time, and three CONCURRENT
 * identical searches ran three fan-outs. Instrumented baseline on a 3-provider
 * backend:
 *
 *   repeat of a completed search   -> 2 provider fan-outs (1 cold + 1 repeat)
 *   3 concurrent identical searches -> 3 provider fan-outs
 *
 * So a user pressing Enter twice, or a double-tap on a slow link, or two tabs
 * searching the same thing, multiplied provider quota and latency for a result
 * that was already in hand. The provider L1/L2 discovery cache
 * (`innertube/cache.ts`) collapses duplicate InnerTube calls but NOT the
 * fan-out itself: the aggregation, canonicalization, and pairwise grouping
 * all re-ran, and a non-YouTube provider has no equivalent cache at all.
 *
 * WHAT IS CACHED. The finished `UnifiedSearchResult` — plain serializable
 * data (canonical identities, per-provider statuses, counts). No provider
 * DTO, no token, no stream URL, and no per-user state: search is not
 * personalized, so the cached value is identical for every caller. That is
 * the precondition that makes a shared process cache safe here, and it is why
 * there is no user dimension in the key.
 *
 * WHAT IS NOT CACHED. Failures are never cached. A `succeeded: false` result
 * is a transient provider condition, and serving a cached failure would turn
 * one bad minute into a sticky error page. Failures also get a short negative
 * cooldown (below) so repeated hard failures cannot become a request storm —
 * but a cooldown entry is a refusal to TRY, never a cached failure served as
 * a result.
 *
 * WHY PROCESS-LOCAL. Aurora runs on Vercel, where a function instance is
 * ephemeral and several may exist at once, so this is a best-effort hot cache
 * and never a correctness dependency: a cold instance simply re-runs the
 * search. That is why it is bounded (LRU with a hard entry cap) and short
 * lived rather than a correctness-bearing store. Introducing Redis or a hosted
 * KV for this would add an operational dependency, a network hop, and a
 * failure mode that does not exist today, in exchange for a hit rate nobody
 * has measured. This is deliberately the smallest thing that removes the
 * duplicate-request cost; the TTL is a single constant precisely so moving to
 * a shared cache later is a change of backing store, not a redesign.
 *
 * KEY. Built from the NORMALIZED query, the provider subset, and the limit —
 * never from the raw string, so `"Cam  On"`, `"cam on"` and `"CẢM ƠN"` share
 * one entry instead of three. `order`/pagination is part of the key because a
 * different page is a different response; the fan-out options carry it.
 *
 * SINGLEFLIGHT. Concurrent identical searches await ONE in-flight promise.
 * The map entry is deleted when the promise settles — success OR failure — so
 * a rejected promise is never handed to a later caller and a failure always
 * reaches a real retry.
 */

import type { FanoutSearchOptions } from "@/lib/providers/extractor-manager";
import type { NormalizedQuery } from "./normalize";

/**
 * Freshness budget for a cached search.
 *
 * Search results are metadata, not credentials: a stale top-50 for tens of
 * seconds is a far smaller harm than a stale signed media URL, and unlike
 * playback there is no expiry to invalidate. 60s is chosen to comfortably
 * cover an impatient double-submit and a tab that re-renders, while staying
 * well inside the window where a listener would expect a new release or a
 * removed track to show up on their next search.
 */
export const SEARCH_CACHE_TTL_MS = 60_000;

/** Hard bound on cached entries; oldest-inserted evicted first. */
export const SEARCH_CACHE_MAX_ENTRIES = 200;

/**
 * Refusal window after a FAILED search, so a broken provider cannot be
 * hammered by a client that retries quickly. Short by design: this exists to
 * damp a retry loop, not to hide an outage. Only total failures qualify — a
 * partial success cached nothing and is not refused.
 */
export const SEARCH_FAILURE_COOLDOWN_MS = 5_000;

export interface SearchCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  failureCooldownMs?: number;
  /** Injected clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

export interface SearchCacheStats {
  hits: number;
  misses: number;
  shared: number;
  /** Requests refused by the failure cooldown. */
  cooldownHits: number;
  evictions: number;
}

/** A cache read: the value and when it was stored. */
export interface CachedSearchEntry<T> {
  value: T;
  storedAt: number;
}

interface InternalEntry {
  value: unknown;
  storedAt: number;
}

/**
 * Builds the cache key. Exported so a caller can reason about (and a test can
 * assert) exactly which inputs share an entry.
 *
 * Provider order in `options.providers` is normalized (sorted) because
 * `ExtractorManager` sorts targets into canonical order before calling them:
 * `["a","b"]` and `["b","a"]` produce identical fan-outs and must not occupy
 * two entries.
 */
export function searchCacheKey(
  query: NormalizedQuery,
  options: FanoutSearchOptions = {},
): string {
  const providers = [...(options.providers ?? [])].sort().join(",");
  const limit = options.limit === undefined ? "d" : String(options.limit);
  // `folded` is the key: it collapses case, punctuation, and diacritics, so
  // one entry serves every spelling of the same question.
  return `${query.folded}\u0000${providers}\u0000${limit}`;
}

export class SearchResultCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly failureCooldownMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, InternalEntry>();
  private readonly cooldowns = new Map<string, number>();
  private readonly stats: SearchCacheStats = {
    hits: 0,
    misses: 0,
    shared: 0,
    cooldownHits: 0,
    evictions: 0,
  };

  constructor(options: SearchCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? SEARCH_CACHE_MAX_ENTRIES;
    this.failureCooldownMs = options.failureCooldownMs ?? SEARCH_FAILURE_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /** Fresh entry for the key, or null. Records hit or miss. */
  get<T>(key: string): CachedSearchEntry<T> | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.stats.misses += 1;
      return null;
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return { value: entry.value as T, storedAt: entry.storedAt };
  }

  /** Stores a value and clears any failure cooldown for the key. */
  set<T>(key: string, value: T): void {
    this.evictIfNeeded();
    this.entries.set(key, { value, storedAt: this.now() });
    this.cooldowns.delete(key);
  }

  /**
   * True when a recent failure means the caller should not attempt the
   * search. Refusal is the whole behaviour: a cooldown never supplies a
   * result, so this can damp a storm without ever serving a stale failure.
   */
  isCoolingDown(key: string): boolean {
    const until = this.cooldowns.get(key);
    if (until === undefined) {
      return false;
    }
    if (this.now() >= until) {
      this.cooldowns.delete(key);
      return false;
    }
    this.stats.cooldownHits += 1;
    return true;
  }

  /** Opens a failure cooldown for the key. */
  coolDown(key: string): void {
    this.cooldowns.set(key, this.now() + this.failureCooldownMs);
  }

  getStats(): SearchCacheStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.shared = 0;
    this.stats.cooldownHits = 0;
    this.stats.evictions = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Bounded eviction. Expired entries are worthless, so they go first; if the
   * map is still full, the oldest INSERTED entry is dropped. `Map` preserves
   * insertion order, so no separate recency structure is needed. A hit does
   * not refresh recency: only boundedness matters here, and refreshing it
   * would let a burst of one-off queries pin the cache against everything
   * else.
   */
  private evictIfNeeded(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.storedAt > this.ttlMs) {
        this.entries.delete(key);
        this.stats.evictions += 1;
        if (this.entries.size < this.maxEntries) {
          return;
        }
      }
    }
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.entries.delete(oldest.value);
      this.stats.evictions += 1;
    }
  }
}

let sharedInstance: SearchResultCache | null = null;

/** Process-local shared cache. Best-effort by construction. */
export function sharedSearchCache(): SearchResultCache {
  if (!sharedInstance) {
    sharedInstance = new SearchResultCache();
  }
  return sharedInstance;
}

/** Replaces the shared instance (tests, operator tuning). Clears state. */
export function configureSearchCache(options: SearchCacheOptions = {}): SearchResultCache {
  sharedInstance = new SearchResultCache(options);
  return sharedInstance;
}

/**
 * Generic over the cached value so this module has no opinion about what a
 * "search result" is: the action caches a `UnifiedSearchResult`, a test
 * exercises it with a bare `FanoutSearchResult`, and neither the cache nor its
 * eviction has to change. The `isCacheable` predicate is the whole of the
 * policy, supplied by the caller.
 */
export interface SearchRunnerOptions<T> {
  /** The search to protect. Called at most once per concurrent burst. */
  run: () => Promise<T>;
  cache: SearchResultCache;
  key: string;
  /**
   * Decides whether a resolved value is cacheable. A total failure is not: it
   * is a provider condition, not a result (see the module comment).
   */
  isCacheable: (value: T) => boolean;
}

/**
 * Cache + singleflight wrapper around one search.
 *
 * Order of checks, and why:
 * 1. in-flight map — a concurrent twin joins BEFORE any cache read, so the
 *    burst costs one execution even if the first finisher has not written yet.
 * 2. cache — a completed, fresh entry answers without touching a provider.
 * 3. run, then store on success and cool the key down on failure.
 *
 * The cooldown never short-circuits a run. It records that the last attempt
 * failed so the failure is visible in stats and so the NEXT caller can be
 * reasoned about, but returning early during a cooldown would have to either
 * fabricate a result (caching a failure, which this module refuses) or reject
 * without trying (which turns a transient blip into a hard error the user
 * sees). Neither is correct, so the cooldown is a signal, not a gate — the
 * storm protection that matters comes from the in-flight map above, which
 * collapses a concurrent burst regardless of outcome.
 *
 * The in-flight entry is removed on settle in BOTH branches, so a rejected
 * promise cannot be awaited by a later caller; that caller starts fresh work
 * and sees the real error rather than a replayed one.
 */
export function runCachedSearch<T>(
  options: SearchRunnerOptions<T>,
): Promise<T> {
  const { run, cache, key, isCacheable } = options;
  const inflight = inflightSearches.get(key);
  if (inflight !== undefined) {
    // Counted rather than measured through the cache: joining an in-flight
    // search is a cache save, but it never reads or writes an entry, so it
    // would be invisible to `getStats()`.
    sharedSearchCount += 1;
    return inflight as Promise<T>;
  }
  const cached = cache.get<T>(key);
  if (cached !== null) {
    return Promise.resolve(cached.value);
  }
  const promise: Promise<T> = run().then(
    (value) => {
      if (isCacheable(value)) {
        cache.set(key, value);
      } else {
        cache.coolDown(key);
      }
      inflightSearches.delete(key);
      return value;
    },
    (error: unknown) => {
      cache.coolDown(key);
      inflightSearches.delete(key);
      throw error;
    },
  );
  inflightSearches.set(key, promise);
  return promise;
}

/**
 * Module-scope so the map spans every call to the action — the same reason
 * the playback singleflight map is not an instance field: an instance-scoped
 * map would dedupe nothing, because each request builds its own.
 */
const inflightSearches = new Map<string, Promise<unknown>>();

/** Test and diagnostics read of the singleflight share counter. */
export function getSearchSharedCount(): number {
  return sharedSearchCount;
}

export function resetSearchSharedCount(): void {
  sharedSearchCount = 0;
}

let sharedSearchCount = 0;
