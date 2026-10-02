import type { AudioSource } from "@/lib/domain";
import { isAudioSourceExpired } from "@/lib/domain";
import type { PlaybackResolutionStage } from "@/lib/domain";

/**
 * Short-TTL memory cache for YouTube playback resolutions.
 *
 * WHAT IT HOLDS. A resolved `AudioSource` (URL + itag-grade metadata:
 * mimeType, bitrate, durationMs, expiresAt) keyed by exact video id plus a
 * resolution-profile tag. The profile exists so a future change to format
 * ranking can bump one constant instead of flushing code nobody remembers;
 * a display title is never a key, because two recordings share titles and
 * one recording is re-uploaded under new ids.
 *
 * WHAT IT DOES NOT DO. Signed googlevideo URLs are temporary credentials,
 * so this cache is deliberately impatient:
 *
 * - entries live `ttlMs` (default 3 minutes, inside the 2–5 minute budget),
 * - a URL expiring within `expirySkewMs` (default 30s) is treated as already
 *   expired — handing out a URL that dies mid-load is worse than re-resolving,
 * - failures are never cached as successes; only NON-retryable failures get
 *   a short negative cooldown (`negativeTtlMs`, default 10s) so a hard-dead
 *   video cannot be turned into a request storm by repeated clicks, and
 *   retryable failures are never cached at all (the next attempt may succeed),
 * - nothing here is persisted: process-local memory, best-effort, lost on
 *   restart. Correctness never depends on a hit.
 *
 * STALE-WHILE-REVALIDATE. `getStale` serves an entry whose TTL lapsed but
 * which is still inside `staleGraceMs` AND whose URL is still live. The
 * caller returns it immediately and refreshes in the background. An expired
 * URL is never served stale — only a live one past its freshness budget.
 *
 * EVICTION. Bounded LRU by insertion order (`maxEntries`, default 500): on
 * insert past capacity, expired entries go first, then oldest-inserted. A
 * `Map` preserves insertion order, so no separate recency structure is
 * needed; a hit does not refresh recency (frequency does not matter here,
 * only boundedness — a hot video re-resolving every 3 minutes is one
 * InnerTube call, not a storm).
 *
 * THREADING. Synchronous get/set around an async resolver, owned by
 * `youtube-resolver.ts`, which also owns the singleflight map. This module
 * holds data and policy; it performs no I/O, starts no timers, and logs
 * nothing (the resolver logs with videoId + latency; URLs never reach a log
 * from any path in this file because none is ever formatted into a string).
 */

export const RESOLUTION_PROFILE = "v1";

export const DEFAULT_RESOLUTION_TTL_MS = 180_000;
export const DEFAULT_STALE_GRACE_MS = 60_000;
export const DEFAULT_NEGATIVE_TTL_MS = 10_000;
export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_NEGATIVE_MAX_ENTRIES = 200;
/** A URL dying within this window is treated as already dead. */
export const DEFAULT_EXPIRY_SKEW_MS = 30_000;

export interface ResolutionCacheOptions {
  ttlMs?: number;
  staleGraceMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  negativeMaxEntries?: number;
  expirySkewMs?: number;
  /** Injected clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

export interface CachedFailure {
  stage: PlaybackResolutionStage;
  message: string;
  retryable: false;
}

export interface ResolutionCacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  expired: number;
  invalidated: number;
  negativeHits: number;
  evictions: number;
}

interface Entry {
  source: AudioSource;
  resolvedAt: number;
}

interface NegativeEntry {
  failure: CachedFailure;
  failedAt: number;
}

function cloneSource(source: AudioSource): AudioSource {
  return { ...source };
}

export function resolutionCacheKey(videoId: string): string {
  return `youtube:${videoId}:${RESOLUTION_PROFILE}`;
}

/**
 * Per-key invalidation epochs.
 *
 * Module-scoped and deliberately shared across cache instances: the hazard
 * being closed is an in-flight resolution, and that promise is module-scoped
 * too, so an instance-local epoch would not see an invalidation issued against
 * a different instance. Entries are removed on write, so the map is bounded by
 * the keys that were invalidated at least once — the same order as the video
 * ids that had to be reported dead.
 */
const epochs = new Map<string, number>();

function bumpEpoch(store: Map<string, number>, key: string): void {
  store.set(key, (store.get(key) ?? 0) + 1);
}

export class PlaybackResolutionCache {
  private readonly ttlMs: number;
  private readonly staleGraceMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly negativeMaxEntries: number;
  private readonly expirySkewMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly negative = new Map<string, NegativeEntry>();
  private readonly epochs: Map<string, number> = epochs;
  private readonly stats: ResolutionCacheStats = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    expired: 0,
    invalidated: 0,
    negativeHits: 0,
    evictions: 0,
  };

  constructor(options: ResolutionCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS;
    this.staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.negativeMaxEntries = options.negativeMaxEntries ?? DEFAULT_NEGATIVE_MAX_ENTRIES;
    this.expirySkewMs = options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Fresh, live entry, or null. Records hit/miss/expired. */
  getFresh(videoId: string): AudioSource | null {
    const key = resolutionCacheKey(videoId);
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (!this.isUsable(entry)) {
      this.stats.expired += 1;
      // Do NOT delete here when the entry is still stale-servable: the
      // caller falls through to getStale next, and deleting would turn a
      // servable stale hit into a full re-resolution.
      if (!this.isStaleServable(entry)) {
        this.entries.delete(key);
      }
      return null;
    }
    this.stats.hits += 1;
    return cloneSource(entry.source);
  }

  /**
   * Entry past its TTL but inside the stale grace window with a still-live
   * URL, or null. The caller serves it immediately and refreshes behind it.
   */
  getStale(videoId: string): AudioSource | null {
    const key = resolutionCacheKey(videoId);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.isUsable(entry)) {
      return cloneSource(entry.source);
    }
    if (!this.isStaleServable(entry)) {
      this.entries.delete(key);
      return null;
    }
    this.stats.staleHits += 1;
    return cloneSource(entry.source);
  }

  set(videoId: string, source: AudioSource): void {
    const key = resolutionCacheKey(videoId);
    this.evictIfNeeded();
    this.entries.set(key, { source: cloneSource(source), resolvedAt: this.now() });
    this.negative.delete(key);
  }

  /**
   * Explicit invalidation (dead URL reported back, config change).
   *
   * Bumps a per-key EPOCH as well as deleting the entry, because deletion
   * alone cannot undo an in-flight resolution: the resolver's singleflight
   * promise is module-scoped and finishes whenever it finishes, and its
   * success handler writes unconditionally. So a resolution that started
   * BEFORE this call could re-insert the very dead URL the caller just
   * reported, re-poisoning the cache the invalidation was meant to clear.
   *
   * The epoch closes that window without touching any hit/miss/stale path: a
   * writer simply has to prove the epoch it captured is still current. The
   * sibling `ProviderCache` solves the same hazard with an identity token on
   * its in-flight promise (`innertube/cache.ts:161-166`).
   */
  invalidate(videoId: string): boolean {
    const key = resolutionCacheKey(videoId);
    bumpEpoch(this.epochs, key);
    const had = this.entries.delete(key) || this.negative.delete(key);
    if (had) {
      this.stats.invalidated += 1;
    }
    return had;
  }

  /**
   * The epoch a writer must still hold to be allowed to write `videoId`.
   *
   * Exposed so the resolver can capture it BEFORE starting work and compare on
   * completion, rather than having the cache reach into the resolver's
   * lifecycle.
   */
  epochOf(videoId: string): number {
    return this.epochs.get(resolutionCacheKey(videoId)) ?? 0;
  }

  /** A cached hard failure, or null when the request should proceed. */
  getNegative(videoId: string): CachedFailure | null {
    const key = resolutionCacheKey(videoId);
    const entry = this.negative.get(key);
    if (!entry) {
      return null;
    }
    if (this.now() - entry.failedAt > this.negativeTtlMs) {
      this.negative.delete(key);
      return null;
    }
    this.stats.negativeHits += 1;
    return { ...entry.failure };
  }

  /** Records a hard failure for the cooldown window. Retryable failures are refused. */
  setNegative(videoId: string, failure: CachedFailure): void {
    if (failure.retryable !== false) {
      return;
    }
    while (this.negative.size >= this.negativeMaxEntries) {
      const oldest = this.negative.keys().next();
      if (oldest.done) {
        break;
      }
      this.negative.delete(oldest.value);
    }
    this.negative.set(resolutionCacheKey(videoId), {
      failure: { ...failure },
      failedAt: this.now(),
    });
  }

  getStats(): ResolutionCacheStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.staleHits = 0;
    this.stats.expired = 0;
    this.stats.invalidated = 0;
    this.stats.negativeHits = 0;
    this.stats.evictions = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Usable = inside TTL and the URL outlives the skew window. */
  private isUsable(entry: Entry): boolean {
    if (this.now() - entry.resolvedAt > this.ttlMs) {
      return false;
    }
    return !this.isUrlDead(entry.source);
  }

  /** Past TTL but inside grace with a live URL: servable while refreshing. */
  private isStaleServable(entry: Entry): boolean {
    if (this.now() - entry.resolvedAt > this.ttlMs + this.staleGraceMs) {
      return false;
    }
    return !this.isUrlDead(entry.source);
  }

  private isUrlDead(source: AudioSource): boolean {
    if (isAudioSourceExpired(source, this.now())) {
      return true;
    }
    const expiresAt = source.expiresAt;
    if (expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())) {
      return expiresAt.getTime() - this.now() <= this.expirySkewMs;
    }
    return false;
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    // Expired entries are worthless; drop those before anything live.
    for (const [key, entry] of this.entries) {
      if (!this.isUsable(entry)) {
        this.entries.delete(key);
        this.stats.evictions += 1;
        if (this.entries.size < this.maxEntries) {
          return;
        }
      }
    }
    // Still full: oldest-inserted first. `Map` iterates insertion order.
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.entries.delete(oldest.value);
      this.stats.evictions += 1;
    }
  }
}

let sharedInstance: PlaybackResolutionCache | null = null;

/**
 * Process-local shared cache. Best-effort by construction: a cold function
 * instance simply resolves fresh, which is always correct.
 */
export function sharedResolutionCache(): PlaybackResolutionCache {
  if (!sharedInstance) {
    sharedInstance = new PlaybackResolutionCache();
  }
  return sharedInstance;
}

/** Replaces the shared instance (tests, operator tuning). Clears state. */
export function configureResolutionCache(options: ResolutionCacheOptions = {}): PlaybackResolutionCache {
  sharedInstance = new PlaybackResolutionCache(options);
  return sharedInstance;
}
