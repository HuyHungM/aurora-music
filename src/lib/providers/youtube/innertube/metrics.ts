/**
 * YouTube request telemetry (Phase 55).
 *
 * WHY THIS IS NOT THE EXISTING LOGGER. `diagnostics/logger.ts` emits
 * structured JSON lines. Counting is a different problem: a rate needs a
 * numerator and a denominator held in process memory, and a counter that has
 * to serialise to emit is too expensive to call on every provider request.
 * So the two are kept apart: `logger` for what happened, this for how many
 * times and how often it worked.
 *
 * WHAT IS DELIBERATELY NOT HERE. No API key, no key prefix, no session
 * identifier, no raw provider payload, no query text. Counts and latencies
 * only. A metrics table is the thing most likely to be dumped into a bug
 * report, so it is the thing that must be safe to dump.
 *
 * §39's distinction is the reason these are separate counters and not one
 * `failures` number: "InnerTube is rate limiting us", "the Data API quota is
 * gone for the day", and "the network is down" call for three different
 * responses, and a single bucket makes all three look like the same incident.
 *
 * ONE OWNER PER COUNTER. This is the rule that keeps the derived ratios
 * meaningful, and it was learned the hard way: `search.innertube` was being
 * incremented by the InnerTube transport's timed wrapper, again by the cache's
 * miss path, and again by the router's "the primary answered" callback. Three
 * owners for one counter means the counter read 7 for 6 searches and
 * `innertubeShareOfSearch` could not be interpreted at all. The owners are:
 *
 *   `innertube/transport.ts`  upstream traffic and cache outcomes
 *                             (`*.upstream`, `*.cache_hit`, `*.dedupe_hit`,
 *                             `innertube_*`)
 *   `tiered-transport.ts`     ROUTING: which source answered, and fallbacks
 *                             (`search.innertube`, `search.data_api`, ...)
 *   `client.ts` / circuit     official-API health
 *                             (`data_api_failed`, `quota_exceeded`, ...)
 *
 * A metric two layers can both increment is a metric that counts code paths
 * rather than events.
 */

export type YouTubeMetricName =
  // --- InnerTube transport: traffic and cache ---
  /** An InnerTube request actually left the process. */
  | "search.upstream"
  | "video.upstream"
  | "search.cache_hit"
  | "search.dedupe_hit"
  | "video.cache_hit"
  | "innertube_rate_limited"
  | "innertube_parser_broken"
  | "innertube_failed"
  // --- Tiered transport: routing ---
  | "search.innertube"
  | "search.data_api"
  | "video.innertube"
  | "video.data_api"
  | "search.fallback"
  | "search.fallback_denied"
  | "channel.data_api"
  | "playlist.data_api"
  | "match.cache_hit"
  // --- Official API health ---
  | "quota_exceeded"
  | "data_api_failed"
  | "data_api_circuit_open"
  | "data_api_circuit_closed";

export interface YouTubeMetricSample {
  name: YouTubeMetricName;
  count: number;
  /** Sum of observed latencies, ms. Divided by `count` for the mean. */
  totalMs: number;
  lastMs?: number;
}

export interface YouTubeMetricsSnapshot {
  counters: Record<string, number>;
  latencies: Record<string, { count: number; meanMs: number; lastMs?: number }>;
  /** Derived ratios, so a consumer does not re-derive them (and get them wrong). */
  ratios: {
    cacheHitRate: number;
    dedupeRate: number;
    dataApiFallbackRate: number;
    innertubeShareOfSearch: number;
  };
  /**
   * The two numbers the phase is judged on, in the units a quota is actually
   * spent in: outbound provider requests, and official-API requests.
   *
   * These are counts of *events*, not of code paths — which is the entire
   * reason for the one-owner rule above. A ratio derived from a
   * double-counted counter is a number that looks like evidence and is not.
   */
  requests: {
    /** Every provider request that left the process, from any source. */
    total: number;
    /** Requests that left for InnerTube. Cost: none. */
    innerTube: number;
    /** Requests that left for the official Data API. Cost: 1-100 units. */
    dataApi: number;
    /** Searches resolved without any request leaving. */
    servedFromCache: number;
  };
  dataApiCircuitOpen: boolean;
  capturedAt: number;
}

const counters = new Map<YouTubeMetricName, number>();
const latencies = new Map<YouTubeMetricName, YouTubeMetricSample>();

let circuitState: { open: boolean; since: number | null; reason: string | null } = {
  open: false,
  since: null,
  reason: null,
};

export function recordYouTubeMetric(name: YouTubeMetricName, durationMs?: number): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const existing = latencies.get(name);
  if (existing) {
    existing.count += 1;
    existing.totalMs += durationMs;
    existing.lastMs = durationMs;
  } else {
    latencies.set(name, { name, count: 1, totalMs: durationMs, lastMs: durationMs });
  }
}

/** Records latency for a span without counting a logical request. */
export function timeYouTubeMetric<T>(name: YouTubeMetricName, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  return run().then(
    (value) => {
      recordYouTubeMetric(name, Date.now() - started);
      return value;
    },
    (error: unknown) => {
      recordYouTubeMetric(name, Date.now() - started);
      throw error;
    },
  );
}

export function setDataApiCircuitState(open: boolean, reason: string | null = null): void {
  circuitState = { open, since: open ? Date.now() : null, reason: open ? reason : null };
  // Two distinct events, not one inverted flag. `data_api_degraded` for the
  // close read as "something is degraded", which is the opposite of what a
  // recovery means, and an operator watching the counter could not tell
  // recovery from continued failure.
  recordYouTubeMetric(open ? "data_api_circuit_open" : "data_api_circuit_closed");
}

export function snapshotYouTubeMetrics(): YouTubeMetricsSnapshot {
  const counterObject: Record<string, number> = {};
  for (const [name, value] of counters) {
    counterObject[name] = value;
  }
  const latencyObject: Record<string, { count: number; meanMs: number; lastMs?: number }> = {};
  for (const [name, sample] of latencies) {
    latencyObject[name] = {
      count: sample.count,
      meanMs: sample.count === 0 ? 0 : Math.round(sample.totalMs / sample.count),
      ...(sample.lastMs !== undefined ? { lastMs: Math.round(sample.lastMs) } : {}),
    };
  }
  const count = (name: YouTubeMetricName): number => counters.get(name) ?? 0;
  // The denominator is every search that reached a source, i.e. upstream
  // attempts plus cache hits. A cache hit is not a free lunch — it is the
  // outcome we are measuring.
  const searchAttempts = count("search.innertube") + count("search.data_api");
  const resolvedSearches =
    searchAttempts + count("search.cache_hit") + count("search.dedupe_hit");
  const ratio = (numerator: number, denominator: number): number =>
    denominator <= 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;

  // Counted from the two owners that can actually spend something: a request
  // that left for InnerTube (`*.upstream`, recorded only when it is really
  // sent) and one that left for the official API (`*.data_api`, recorded by
  // the router when it routes there).
  const innerTubeRequests = count("search.upstream") + count("video.upstream");
  const dataApiRequests =
    count("search.data_api") +
    count("video.data_api") +
    count("channel.data_api") +
    count("playlist.data_api");

  return {
    counters: counterObject,
    latencies: latencyObject,
    ratios: {
      cacheHitRate: ratio(count("search.cache_hit"), resolvedSearches),
      dedupeRate: ratio(count("search.dedupe_hit"), resolvedSearches),
      dataApiFallbackRate: ratio(count("search.fallback"), searchAttempts),
      innertubeShareOfSearch: ratio(count("search.innertube"), searchAttempts),
    },
    requests: {
      total: innerTubeRequests + dataApiRequests,
      innerTube: innerTubeRequests,
      dataApi: dataApiRequests,
      // Includes DEDUPE hits, not just cache hits. A deduped request resolved
      // without anything leaving the process, which is exactly what this field
      // claims to count; leaving it out reported 24 locally-served concurrent
      // searches as 0 served from cache, which reads as "the cache never hit".
      servedFromCache:
        count("search.cache_hit") + count("search.dedupe_hit") + count("video.cache_hit"),
    },
    dataApiCircuitOpen: circuitState.open,
    capturedAt: Date.now(),
  };
}

export function dataApiCircuitIsOpen(): boolean {
  return circuitState.open;
}

export function dataApiCircuitReason(): string | null {
  return circuitState.reason;
}

/** Test hook. Production never resets; a server restart is the reset. */
export function resetYouTubeMetrics(): void {
  counters.clear();
  latencies.clear();
  circuitState = { open: false, since: null, reason: null };
}
