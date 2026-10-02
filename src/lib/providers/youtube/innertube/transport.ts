/**
 * InnerTube-backed `YouTubeApiTransport` (Phase 55).
 *
 * This is the PRIMARY data source for discovery. It satisfies the same
 * interface the Data API transport does, so `youtube-provider.ts` is
 * unchanged and the choice of source stops at this file.
 *
 * WHAT IT COVERS, and why only that (§35 classification):
 *
 * - `searchVideos`        -> `Innertube.search`    replaces `search.list type=video`
 * - `searchChannels`      -> `Innertube.search`    replaces `search.list type=channel`
 * - `searchChannelVideos` -> channel videos tab    replaces `search.list channelId`
 * - `getVideos`           -> `Innertube.getInfo`   replaces `videos.list`
 *
 * WHAT IT DELIBERATELY DOES NOT COVER:
 *
 * - `getChannels`   OFFICIAL-DATA-REQUIRED. Authoritative channel snippet;
 * - `getPlaylist`   InnerTube has no structured equivalent, and
 * - `getPlaylistItems`  `youtubei.js@18`'s WEB `Playlist` exposes no
 *                   `contents`, so the items page-walk would be strictly
 *                   worse than the Data API — and both are 1 unit already. A
 *                   change there buys no quota and risks a parser failure on
 *                   a feature that works today.
 *
 * The unimplemented methods THROW rather than returning empty. A transport
 * that silently answers "no results" for an operation it cannot do is far
 * worse than one that says so: an empty result is a cacheable, user-visible
 * "nothing found", while a throw is an unambiguous signal for the tiered
 * router to route around.
 *
 * SERVER-ONLY. This is one of the two modules allowed to import youtubei.js
 * (the other being `playback/innertube-client.ts`).
 */

import type { Innertube } from "youtubei.js";
import { logger } from "@/lib/diagnostics/logger";
import type {
  YouTubeApiTransport,
  YouTubeChannelListResponse,
  YouTubePlaylistItemsResponse,
  YouTubePlaylistResource,
  YouTubeSearchResponse,
  YouTubeVideoListResponse,
} from "../types";
import { asRecord, ensureJsEvaluator, sharedInnertubeSession } from "./session";
import type { SessionFactory } from "./session";
import { channelSearchItem, videoInfoItem, videoSearchItem } from "./shapes";
import {
  recordYouTubeMetric,
  timeYouTubeMetric,
  type YouTubeMetricName,
} from "./metrics";
import {
  isTemporaryMediaUrl,
  ProviderCache,
  searchCacheKey,
  videoBatchCacheKey,
  type CacheOutcome,
} from "./cache";

/**
 * The whole point of these two numbers is that they are NOT additive.
 *
 * The first version wrapped `session()` in a 12s timeout and then wrapped
 * `session().then(yt => yt.search(...))` in a second 12s timeout, so a primary
 * that never answered cost 24 seconds before the official API was even tried —
 * and because a rejected session cleared its memo slot, the next avenue paid
 * the same 24 seconds again. A user request that took one API call before this
 * phase took a minute. The E2E radio exhaustion journey is what caught it: the
 * queue sat on "Finding more tracks…" past its 20s window.
 *
 * So the rule is: **one deadline covers the entire operation, including waiting
 * for the session**, and a session that cannot be created is remembered as
 * failed for a short window so the second avenue is instant rather than slow.
 */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Creating a session is one HTTP round trip. If it has not succeeded by now,
 * the host is unreachable and the official API is the better answer; retrying
 * the handshake only delays the fallback the user is waiting for.
 */
const SESSION_TIMEOUT_MS = 5_000;

/**
 * How long a failed session creation is remembered as failed.
 *
 * Deliberately short, and deliberately not zero. Clearing the slot on failure
 * (so a transient blip can recover) means every subsequent operation re-pays
 * the handshake timeout, which turns one network partition into a per-request
 * latency tax. Thirty seconds is long enough to cover the rest of a user's
 * burst and short enough that a genuine recovery is picked up almost at once.
 */
const SESSION_FAILURE_TTL_MS = 30_000;

/** §29: the UI never needs more than this from a provider query. */
const MAX_DISCOVERY_LIMIT = 25;
const DEFAULT_DISCOVERY_LIMIT = 10;

export class InnerTubeUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`InnerTube could not satisfy "${operation}"`);
    this.name = "InnerTubeUnavailableError";
    this.cause = cause;
  }
}

/** True for the failures that mean "route this to the other source". */
export function isInnerTubeUnavailable(error: unknown): boolean {
  if (error instanceof InnerTubeUnavailableError) {
    return true;
  }
  if (error instanceof Error && error.name === "InnerTubeUnavailableError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /not available|couldn't|failed|timed out|ECONN|ENOTFOUND|EAI_AGAIN|429|rate.?limit|socket hang up/i.test(
    message,
  );
}

/**
 * Rate limiting is its own condition, not a synonym for failure, because the
 * response is different: a rate-limited InnerTube is a reason to slow down and
 * serve cache, while a parser failure is a reason to fall back. §39.
 */
export function isInnerTubeRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests/i.test(message);
}

function clamp(limit: number | undefined, max = MAX_DISCOVERY_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_DISCOVERY_LIMIT;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("InnerTube request timed out"));
    }, budgetMs);
    const handle = timer as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

/** `withTimeout` for the session handshake, which has its own shorter budget. */
function withSessionTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  return withTimeout(promise, budgetMs);
}

/**
 * Cache outcomes become metrics here rather than at each call site, so a new
 * cached operation cannot forget to record its own hit rate. The key already
 * encodes the operation, which is what makes the mapping derivable.
 *
 * Returns null for a miss. A miss is an upstream request, and upstream traffic
 * is counted by the timed wrapper that actually performs it — not here. This
 * function previously returned `search.innertube` on a miss, which meant the
 * same search incremented that counter twice: once as "a request went out" and
 * again as "the primary source answered" (recorded by the router). A source
 * counter owned by two layers cannot answer the question it exists to answer.
 */
function cacheOutcomeToMetric(key: string, outcome: CacheOutcome): YouTubeMetricName | null {
  // `yt:search:` and `yt:video:` are deliberately distinct prefixes, so this
  // classification is exact rather than heuristic. While search keys began
  // with `yt:video:`, every video search was counted as a metadata lookup and
  // the search hit rate read zero.
  const isVideo = key.startsWith("yt:videos:") || key.startsWith("yt:video:");
  if (outcome === "coalesced") {
    return "search.dedupe_hit";
  }
  if (outcome === "hit" || outcome === "negative-hit") {
    return isVideo ? "video.cache_hit" : "search.cache_hit";
  }
  return null;
}

/**
 * Pulls the node list out of whatever container a feed returned.
 *
 * MEASURED, NOT ASSUMED. Every location below was captured from live
 * `youtubei.js@18.0.0` responses; the first two attempts at this function were
 * wrong and cost this phase its entire saving while every test still passed.
 * That is worth stating plainly, because the mistake is the instructive part.
 *
 * - `yt.search(query, { type })` returns a `Search` whose rows are at
 *   `.results` — a flat array of `Video` / `Channel` nodes.
 * - `yt.getChannel(id).getVideos()` returns the *Channel itself* (constructor
 *   name `Channel`, not a shelf), and its rows are at
 *   `current_tab.content.contents` — `RichItem` wrappers, each hiding the real
 *   node in `.content`. An earlier version looked only at `contents` and
 *   `page_contents`, found nothing, and returned `[]`.
 *
 * WHY EACH LOCATION IS READ INSIDE ITS OWN `try`. `page_contents` is not a
 * field, it is a LAZY GETTER, and on a search response it THROWS:
 *
 *     get page_contents() {
 *       const tab_content = this.#memo.getType(Tab)?.[0].content;
 *       //                                 ^^^^^^^ optional-chained, but `.content`
 *       //                                 is not — a search has no Tab node, so
 *       //                                 this is `undefined.content`.
 *
 * `youtubei.js@18.0.0`, `dist/src/core/mixins/Feed.js`. The `?.` guards the
 * index and then dereferences anyway. So merely *asking* a search response for
 * its `page_contents` raises `TypeError: Cannot read properties of undefined
 * (reading 'content')` — which is exactly how every search failed while
 * channel videos and metadata worked. Probing locations in one shared `try`
 * would have kept re-raising the same bug; isolating each read means a broken
 * location is skipped and the next one is tried.
 *
 * Order matters too: `results` is the cheap, always-correct location for a
 * search, so it is asked before the getter that can throw.
 *
 * An unfamiliar shape returns `[]`, which the quality gate then treats as a
 * parse failure and routes to the official API — the correct, loud outcome.
 */
function nodeListOf(feed: unknown): unknown[] {
  const record = asRecord(feed);
  if (!record) {
    return [];
  }
  const currentTab = asRecord(record.current_tab);
  // Each entry is a thunk, not a value, precisely so that reading it can fail
  // without taking the others down with it.
  const locations: Array<() => unknown> = [
    () => record.contents,
    () => record.results,
    () => asRecord(record.page_contents)?.contents,
    () => asRecord(record.page_contents),
    () => asRecord(currentTab?.content)?.contents,
    () => asRecord(record.current_tab_content)?.contents,
  ];
  for (const read of locations) {
    let candidate: unknown;
    try {
      candidate = read();
    } catch {
      // A throwing accessor is a location that does not exist, not a reason to
      // abandon the lookup. See the `page_contents` note above.
      continue;
    }
    if (Array.isArray(candidate) && candidate.length > 0) {
      return unwrapRichItems(candidate);
    }
  }
  return [];
}

/** How deep to follow `RichItem` nesting before declaring the shape unfamiliar. */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Replaces `RichItem` wrappers with the node they wrap.
 *
 * A `RichItem` with nothing usable inside it is dropped rather than passed on,
 * because a wrapper with no child carries no id, no title and no channel — the
 * shape adapters would skip it anyway, and passing it on would let an empty
 * wrapper satisfy a "did we get results" check.
 */
function unwrapRichItems(nodes: unknown[], depth = 0): unknown[] {
  if (depth >= MAX_UNWRAP_DEPTH) {
    return nodes;
  }
  const out: unknown[] = [];
  for (const node of nodes) {
    const record = asRecord(node);
    if (record && record.type === "RichItem") {
      const inner = record.content;
      if (Array.isArray(inner)) {
        out.push(...unwrapRichItems(inner, depth + 1));
      } else if (asRecord(inner)) {
        out.push(inner);
      }
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * How many `getInfo` requests may be in flight at once for one batch.
 *
 * `getInfo` takes one video per request, so a 50-item playlist batch is
 * inherently 50 round trips. Sequential is safe and unusable; unbounded is
 * fast and gets rate-limited. Six keeps a full batch at roughly nine round
 * trips while staying well inside a conservative burst envelope.
 */
const METADATA_CONCURRENCY = 6;

function newCache(ttlMs: number, negativeTtlMs?: number): ProviderCache {
  return new ProviderCache({
    ttlMs,
    ...(negativeTtlMs === undefined ? {} : { negativeTtlMs }),
    onRecord: (record) => {
      const metric = cacheOutcomeToMetric(record.key, record.outcome);
      if (metric !== null) {
        recordYouTubeMetric(metric);
      }
    },
  });
}

export interface InnerTubeTransportOptions {
  sessionFactory?: SessionFactory;
  cache?: ProviderCache;
  /** Folded into cache keys so a locale-sensitive result is never served to another locale. */
  locale?: string;
  region?: string;
  /** §49 TTL overrides. Exposed for tests that must not wait real minutes. */
  searchTtlMs?: number;
  videoTtlMs?: number;
  /** Override for the video cache's negative TTL. Exposed for the same reason. */
  videoNegativeTtlMs?: number;
  /**
   * Deadline for a whole discovery operation, session handshake included.
   *
   * Injectable because it is a contract, not a preference: the fallback path's
   * user-visible latency is bounded by this number, and the regression that
   * made it two budgets instead of one is only testable if a test can shrink
   * it below the seconds.
   */
  requestTimeoutMs?: number;
  /** Deadline for the session handshake alone. Must be well under `requestTimeoutMs`. */
  sessionTimeoutMs?: number;
  /** How long a failed handshake is remembered, so a dead primary is paid for once. */
  sessionFailureTtlMs?: number;
}

export function createInnerTubeTransport(
  options: InnerTubeTransportOptions = {},
): YouTubeApiTransport {
  ensureJsEvaluator();
  const sessionFactory = options.sessionFactory ?? sharedInnertubeSession;
  const locale = options.locale;
  const region = options.region;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const sessionFailureTtlMs = options.sessionFailureTtlMs ?? SESSION_FAILURE_TTL_MS;

  // §49's TTL taxonomy. Search is volatile (minutes); a video's title, channel
  // and duration are effectively immutable (hours). Two caches, not one global
  // TTL, because those lifetimes differ by two orders of magnitude.
  const searchCache = options.cache ?? newCache(options.searchTtlMs ?? 5 * 60_000);
  // The negative TTL is set EXPLICITLY and is deliberately not derived from
  // the 6h positive TTL. `ProviderCache` otherwise defaults it to `ttl / 6`,
  // which here meant one hour — and `getVideos` records a negative entry
  // whenever a batch resolves empty. Every per-video failure in the batch is
  // swallowed and counted rather than rethrown, so one dead session or network
  // partition resolves a 50-id playlist batch to `[]`, and that transient
  // failure then became a "known empty" answer served for an hour, with the
  // Data API fallback never consulted (the tiered router only routes an empty
  // SEARCH to the official API, not an empty video batch).
  //
  // An empty batch is often genuinely empty (deleted videos), so it must still
  // be cached — just for as long as a transient upstream fault can plausibly
  // last, not for as long as video metadata is stable.
  const videoCache = newCache(
    options.videoTtlMs ?? 6 * 60 * 60_000,
    options.videoNegativeTtlMs ?? 15_000,
  );

  /**
   * Memoise the injected factory, so "one session per transport" holds
   * regardless of who supplied the factory.
   *
   * The default factory is already memoised process-wide, so this is a no-op in
   * production. It matters for correctness rather than convenience: a factory
   * that ran per operation would hand back a different session for search than
   * for metadata, which is the two-sessions-one-process problem this phase
   * exists to remove — just wearing a seam instead of a module.
   *
   * A rejected creation clears the slot so the next caller retries with a
   * fresh session instead of replaying a cached rejection forever.
   */
  let sessionPromise: Promise<Innertube> | null = null;
  /**
   * When a session creation last failed, for `SESSION_FAILURE_TTL_MS`.
   *
   * Without this the fallback path is quadratic in a user's own traffic: the
   * memo slot is cleared on failure so a blip can recover, and clearing it
   * means the *next* operation pays the handshake timeout again. One search
   * avenue plus one artist avenue — what a radio station asks for — turned one
   * unreachable host into a minute of waiting. Remembering the failure for half
   * a minute makes the second call instant while still recovering on its own.
   */
  let sessionFailedAt = 0;
  function session(): Promise<Innertube> {
    if (Date.now() - sessionFailedAt < sessionFailureTtlMs) {
      return Promise.reject(
        new InnerTubeUnavailableError("session", "recent session creation failed"),
      );
    }
    if (!sessionPromise) {
      sessionPromise = withSessionTimeout(sessionFactory(), sessionTimeoutMs).catch(
        (error: unknown) => {
          sessionPromise = null;
          sessionFailedAt = Date.now();
          throw error;
        },
      );
    }
    return sessionPromise;
  }

  /**
   * Runs one InnerTube search, mapped to Data API shape.
   *
   * The session is awaited INSIDE the deadline. Hoisting it out — which is what
   * this used to do, via `withTimeout(session().then(...))` — makes the two
   * timeouts additive and lets a dead primary spend double its budget before
   * the official API is tried.
   */
  async function runSearch(
    query: string,
    limit: number,
    kind: "video" | "channel",
  ): Promise<YouTubeSearchResponse> {
    return withTimeout(performSearch(query, limit, kind), requestTimeoutMs);
  }

  async function performSearch(
    query: string,
    limit: number,
    kind: "video" | "channel",
  ): Promise<YouTubeSearchResponse> {
    const yt = await session();
    // A TYPED search, and this is load-bearing rather than tidy.
    //
    // Measured: an unfiltered `yt.search()` returns 22 rows for a music query
    // — 19 `Video`, but also an `OfficialCardView` and two `GridShelfView`
    // nodes. `youtubei.js@18.0.0` has no parser for `OfficialCardView`; its
    // JIT recovery then throws
    // `TypeError: Cannot read properties of undefined (reading 'content')`
    // and the whole search is lost. With `{ type: "video" }` the same query
    // returns 20 rows (19 `Video`, 1 `Channel`) with no shelf nodes and no
    // crash, in roughly half the time.
    //
    // So the filter is not a precision nicety — it is the difference between
    // the primary path working and not. It also means each search parses only
    // the node family it is going to keep.
    const results = await yt.search(query, { type: kind });
    const nodes = nodeListOf(results);
    const items: unknown[] = [];
    for (const node of nodes) {
      const mapped = kind === "video" ? videoSearchItem(node) : channelSearchItem(node);
      if (mapped) {
        items.push(mapped);
      }
      if (items.length >= limit) {
        break;
      }
    }
    const estimated =
      typeof results?.estimated_results === "number" ? results.estimated_results : undefined;
    return {
      items,
      pageInfo: { totalResults: estimated ?? items.length, resultsPerPage: items.length },
    };
  }

  /** Shared failure classification for every discovery operation (§39). */
  function classify(error: unknown, operation: string): never {
    const rateLimited = isInnerTubeRateLimited(error);
    // PARSER BREAKAGE IS ITS OWN CONDITION, and it is the one that actually
    // happened during this phase. A `TypeError` thrown from inside
    // `youtubei.js` means the library's own parser could not handle a node
    // YouTube sent — the request succeeded, the network was fine, and no amount
    // of retrying will change the answer. Folding it into the generic
    // "discovery failed" bucket would hide the one failure an operator can act
    // on (upgrade or adapt the parser) behind a bucket that mostly means
    // "the network wobbled". The upstream error text is still not logged; the
    // class is the signal.
    const parserBroken =
      error instanceof TypeError ||
      (error instanceof Error && error.name === "TypeError") ||
      /reading '(content|metadata|contents)'|is not a function|of undefined/i.test(
        error instanceof Error ? error.message : String(error),
      );
    if (rateLimited) {
      recordYouTubeMetric("innertube_rate_limited");
      logger.warn(
        "InnerTube rate limited; discovery will fall back to the official API",
        { event: "youtube.innertube.rate_limited", operation },
      );
    } else if (parserBroken) {
      recordYouTubeMetric("innertube_parser_broken");
      logger.warn(
        "InnerTube parser could not read the response; discovery will fall back to the official API",
        { event: "youtube.innertube.parser_broken", operation },
      );
    } else {
      recordYouTubeMetric("innertube_failed");
      logger.warn("InnerTube discovery failed; falling back to the official API", {
        event: "youtube.innertube.failed",
        operation,
      });
    }
    // The upstream message is NOT logged. InnerTube error text can echo the
    // request, and a request carries the provider payload; the operation name
    // and the failure class are what an operator actually needs.
    throw error instanceof InnerTubeUnavailableError
      ? error
      : new InnerTubeUnavailableError(operation, error);
  }

  function cachedSearch(
    query: string,
    limit: number,
    kind: "video" | "channel",
  ): Promise<YouTubeSearchResponse> {
    return searchCache.resolve(
      searchCacheKey({
        provider: "innertube",
        query,
        kind,
        limit,
        ...(locale ? { locale } : {}),
        ...(region ? { region } : {}),
      }),
      async () => {
        try {
          return await timeYouTubeMetric("search.upstream", () => runSearch(query, limit, kind));
        } catch (error) {
          return classify(error, kind === "video" ? "searchVideos" : "searchChannels");
        }
      },
      // A search that genuinely has no results still cost an upstream call.
      // Caching the emptiness for the short negative TTL is what stops a
      // no-result query being re-spent on every keystroke and every reload.
      { negativeWhen: (value) => !Array.isArray(value.items) || value.items.length === 0 },
    );
  }

  function cachedChannelVideos(
    channelId: string,
    limit: number,
  ): Promise<YouTubeSearchResponse> {
    return searchCache.resolve(
      searchCacheKey({
        provider: "innertube",
        query: channelId,
        kind: "channel-videos",
        limit,
        ...(locale ? { locale } : {}),
        ...(region ? { region } : {}),
      }),
      async () => {
        try {
          return await timeYouTubeMetric("search.upstream", async () => {
            // ONE deadline for session + channel + videos tab. Stacking a
            // timeout per await made the worst case here about 29 seconds,
            // which is the artist-page avenue of a radio station and the
            // reason a station could sit "Finding more tracks…" indefinitely.
            return await withTimeout(
              (async (): Promise<YouTubeSearchResponse> => {
                const yt = await session();
                const channel = await yt.getChannel(channelId);
                // `getVideos()` is the channel's VIDEOS tab. Deliberately not
                // `getHome()` (a curated mix) and not
                // `getShorts()`/`getReleases()`: only the videos tab is an
                // artist's playable back catalogue.
                const shelf = channel.has_videos ? await channel.getVideos() : channel;
                const nodes = nodeListOf(shelf);
                const items: unknown[] = [];
                for (const node of nodes) {
                  const mapped = videoSearchItem(node);
                  if (mapped) {
                    items.push(mapped);
                  }
                  if (items.length >= limit) {
                    break;
                  }
                }
                return {
                  items,
                  pageInfo: { totalResults: items.length, resultsPerPage: items.length },
                } satisfies YouTubeSearchResponse;
              })(),
              requestTimeoutMs,
            );
          });
        } catch (error) {
          return classify(error, "searchChannelVideos");
        }
      },
      { negativeWhen: (value) => !Array.isArray(value.items) || value.items.length === 0 },
    );
  }

  async function getVideos(videoIds: string[]): Promise<YouTubeVideoListResponse> {
    const ids = videoIds.filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      return { items: [], pageInfo: { totalResults: 0 } };
    }
    // Order-independent key: the same id set in a different order is the same
    // request, and callers batch in whatever order they collected.
    const items = await videoCache.resolve(
      videoBatchCacheKey(ids),
      async () => {
        // BOUNDED CONCURRENCY, not sequential and not unbounded.
        //
        // `getInfo` is one video per request, so a 50-item playlist batch is 50
        // round trips. Sequential is safe but unusable — 50 sequential
        // requests at InnerTube's typical latency is a multi-second wait on the
        // playlist page. Unbounded `Promise.all` is the fastest path to a 429.
        //
        // The window is small on purpose. YouTube rate-limits a burst far
        // earlier than it rate-limits a sustained trickle, and the cost of
        // being wrong is asymmetric: too wide means occasional 429s and a
        // fallback to the official API, too narrow means a slow page. Six keeps
        // a 50-item batch at roughly nine round trips while staying well inside
        // a conservative burst envelope.
        //
        // The L1 layer has already collapsed genuine duplicate demand across
        // callers, so everything in this loop is work that was actually asked
        // for — there is no free concurrency left to exploit.
        const mapped = new Map<number, unknown>();
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < ids.length) {
            const index = cursor;
            cursor += 1;
            const id = ids[index];
            try {
              const info = await timeYouTubeMetric("video.upstream", () =>
                // One deadline covering session + getInfo, for the same reason
                // as the search paths. With a dead session, a 50-item batch
                // would otherwise pay the handshake timeout fifty times over.
                withTimeout(
                  (async () => {
                    const yt = await session();
                    return yt.getInfo(id);
                  })(),
                  requestTimeoutMs,
                ),
              );
              const item = videoInfoItem(info, id);
              if (item) {
                mapped.set(index, item);
              }
            } catch (error) {
              // One unavailable video must not sink a batch of 50. The
              // provider reports a missing entry as `TrackNotFoundError` on
              // exact lookup, which is the correct outcome for a deleted or
              // private video — a batch of 50 losing all 50 because one is
              // deleted would break playlist hydration for the whole playlist.
              if (isInnerTubeRateLimited(error)) {
                recordYouTubeMetric("innertube_rate_limited");
              } else {
                recordYouTubeMetric("innertube_failed");
              }
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(METADATA_CONCURRENCY, ids.length) }, () => worker()),
        );
        // Re-serialised in the caller's order, so concurrency cannot change
        // which track is which. A `videos.list` response is positional and the
        // provider pairs items back to the ids it asked for.
        const ordered: unknown[] = [];
        for (let index = 0; index < ids.length; index += 1) {
          const item = mapped.get(index);
          if (item !== undefined) {
            ordered.push(item);
          }
        }
        return ordered;
      },
      {
        // §56, enforced rather than documented: a video id is a STABLE
        // identity and safe to cache for hours, while anything carrying a
        // signed/temporary media URL is refused by the cache. `getInfo` is
        // metadata-only here, so this never trips — it exists so a future
        // change that widens this method cannot quietly start persisting
        // googlevideo URLs.
        //
        // The check is on the URL-shaped fields, not on `id`: a
        // `videoInfoItem`'s `id` IS the eleven-character video id, so a
        // predicate on `id` could never fire and the guard was inert while
        // reading as enforced. `streamingData` is where a googlevideo URL
        // actually appears on a player response.
        forbids: (value) =>
          value.some((entry) => {
            const record = asRecord(entry);
            return (
              isTemporaryMediaUrl(record?.url) ||
              isTemporaryMediaUrl(asRecord(record?.streamingData)?.hlsManifestUrl) ||
              value.some((nested) => isTemporaryMediaUrl(asRecord(nested)?.url))
            );
          }),
        negativeWhen: (value) => value.length === 0,
      },
    );
    return { items, pageInfo: { totalResults: items.length } };
  }

  function unsupported(operation: string): Promise<never> {
    return Promise.reject(new InnerTubeUnavailableError(operation, "not implemented on this path"));
  }

  return {
    searchVideos: (query, searchOptions = {}) =>
      cachedSearch(query, clamp(searchOptions.limit), "video"),
    searchChannels: (query, searchOptions = {}) =>
      cachedSearch(query, clamp(searchOptions.limit), "channel"),
    searchChannelVideos: (channelId, searchOptions = {}) =>
      cachedChannelVideos(channelId, clamp(searchOptions.limit)),
    getVideos,
    getChannels: (): Promise<YouTubeChannelListResponse> => unsupported("getChannels"),
    getPlaylist: (): Promise<YouTubePlaylistResource | null> => unsupported("getPlaylist"),
    getPlaylistItems: (): Promise<YouTubePlaylistItemsResponse> =>
      unsupported("getPlaylistItems"),
  };
}
