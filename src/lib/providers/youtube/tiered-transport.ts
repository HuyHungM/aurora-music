/**
 * Tiered YouTube transport: InnerTube primary, Data API fallback (Phase 55).
 *
 * THIS IS THE WHOLE PHASE IN ONE FILE. Every quota decision Aurora makes about
 * YouTube is made here, and nowhere else. The provider above it is
 * source-agnostic and cannot tell which side answered.
 *
 * THE ORDER, AND WHY IT IS NOT ALWAYS THE SAME ORDER (§34). §34 gives a
 * six-step cascade; applying it literally would send every search to Spotify
 * and Deezer first, which costs two round-trips to answer a question YouTube
 * answers in one and degrades result quality. So the cascade is applied PER
 * OPERATION, keeping only the steps that are both cheaper and at least as
 * good:
 *
 *   1. Cache (L1 coalesce, L2 TTL)  — free, always first
 *   2. Existing source identity      — §19/§20: a known video id never searches
 *   3. InnerTube                     — the primary source for discovery
 *   4. Data API                      — fallback, and the ONLY source for
 *                                      channels and playlists
 *   5. Degradation                   — typed error, never a fake empty result
 *
 * THE QUALITY GATE (§11). InnerTube is not the official API and its results
 * are a UI-shaped projection, so "it returned something" is not sufficient.
 * `decideSearchSource` is a PURE function of the result and returns one of
 * three decisions, deterministically: use it, fall back, or degrade.
 *
 * The deliberate asymmetry: **InnerTube returning nothing is never trusted as
 * "nothing exists".** A YouTube markup change turns every result row into a
 * node this code cannot parse, and from inside the transport that is
 * indistinguishable from a genuinely empty result. One of those is a bug and
 * the other is the normal case, so they cannot be told apart by looking at the
 * result — which is exactly why emptiness routes to the official API instead
 * of being cached as "no results". The cost of being wrong this way is one
 * `search.list` call on a query that genuinely has no matches. The cost of
 * being wrong the other way is a permanently broken search page.
 *
 * NO FAN-OUT (§10). The two sources are never called and merged. One is
 * called; the other only if the first is judged insufficient. Calling both
 * "to compare quality" would spend the quota this phase exists to save.
 */

import { ExtractorError } from "@/lib/domain";
import { logger } from "@/lib/diagnostics/logger";
import type {
  YouTubeApiTransport,
  YouTubeChannelListResponse,
  YouTubePlaylistItemsResponse,
  YouTubePlaylistResource,
  YouTubeSearchResponse,
  YouTubeVideoListResponse,
} from "./types";
import { isInnerTubeUnavailable } from "./innertube/transport";
import { dataApiCircuit } from "./innertube/data-api-circuit";
import { recordYouTubeMetric } from "./innertube/metrics";
import {
  channelCacheKey,
  playlistCacheKey,
  playlistItemsCacheKey,
  ProviderCache,
  videoCacheKey,
} from "./innertube/cache";

const PROVIDER_ID = "youtube";

/** How many leading items must yield an id before InnerTube is trusted. */
const CONFIDENCE_SAMPLE = 3;

export type SearchDecision =
  | { source: "innertube"; confidence: number; items: number }
  | { source: "data-api"; reason: string };

/**
 * The pure quality gate (§11). No clock, no I/O, no randomness: the same
 * response always yields the same decision, which is what makes it testable
 * and what keeps the fallback from flapping between runs.
 */
export function decideSearchSource(response: YouTubeSearchResponse): SearchDecision {
  const items = Array.isArray(response.items) ? response.items : [];
  if (items.length === 0) {
    // See the asymmetry note in the file header: empty is a parse failure
    // until proven otherwise, because the two are indistinguishable here.
    return { source: "data-api", reason: "innertube-returned-no-items" };
  }
  const sample = items.slice(0, CONFIDENCE_SAMPLE);
  const withId = sample.filter((item) => {
    const id = (item as { id?: { videoId?: unknown; channelId?: unknown } } | null)?.id;
    return typeof id?.videoId === "string" || typeof id?.channelId === "string";
  }).length;
  if (withId === 0) {
    return { source: "data-api", reason: "innertube-items-had-no-identity" };
  }
  return {
    source: "innertube",
    confidence: Math.round((withId / sample.length) * 100) / 100,
    items: items.length,
  };
}

function itemsOf(response: { items?: unknown } | null): unknown[] {
  return Array.isArray(response?.items) ? (response.items as unknown[]) : [];
}

export interface TieredTransportOptions {
  /** InnerTube-backed transport. The primary source. */
  primary: YouTubeApiTransport;
  /** Data API transport. Fallback, and the only source for channels/playlists. */
  fallback: YouTubeApiTransport;
  /** Injected for tests; defaults to the process-wide breaker. */
  isFallbackOpen?: () => boolean;
  playlistTtlMs?: number;
  channelTtlMs?: number;
  videoTtlMs?: number;
}

export function createTieredTransport(options: TieredTransportOptions): YouTubeApiTransport {
  const { primary, fallback } = options;
  const isFallbackOpen = options.isFallbackOpen ?? (() => dataApiCircuit.shouldSkip());

  // §49: playlists and channel metadata are stable far longer than a search
  // result. Both are already 1 unit, so this cache is about repeat page loads,
  // not about quota scarcity — which is why the TTLs are generous.
  const playlistCache = new ProviderCache({ ttlMs: options.playlistTtlMs ?? 30 * 60_000 });
  const channelCache = new ProviderCache({ ttlMs: options.channelTtlMs ?? 6 * 60 * 60_000 });
  const videoCache = new ProviderCache({ ttlMs: options.videoTtlMs ?? 6 * 60 * 60_000 });

  function degraded(operation: string, reason: string, cause?: unknown): ExtractorError {
    return new ExtractorError(PROVIDER_ID, operation, `YouTube ${reason}`, {
      retryable: false,
      cause,
    });
  }

  /**
   * True when the official API may be called, and records the refusal when it
   * may not. Takes no operation name: the metric carries the count, and a
   * refusal is not a per-operation event — it is one circuit state seen by
   * every operation equally.
   */
  function fallbackClosed(): boolean {
    if (!isFallbackOpen()) {
      return true;
    }
    recordYouTubeMetric("search.fallback_denied");
    return false;
  }

  /**
   * Runs the primary source, applies the quality gate, and falls back only
   * when the primary is broken or untrustworthy. Never both, and never the
   * fallback on an open circuit.
   *
   * The three outcomes, exhaustively:
   *
   *   primary answered, gate passed      -> primary        (the happy path)
   *   primary answered, gate failed,
   *     official API available            -> official API
   *   primary answered, gate failed,
   *     official API paused               -> primary        (degraded, usable)
   *   primary broken, official available  -> official API
   *   primary broken, official paused     -> typed error    (nothing left)
   */
  async function tieredSearch(
    operation: string,
    runPrimary: () => Promise<YouTubeSearchResponse>,
    runFallback: () => Promise<YouTubeSearchResponse>,
    onPrimaryUsed: () => void,
    onFallbackUsed: () => void,
  ): Promise<YouTubeSearchResponse> {
    let primaryResponse: YouTubeSearchResponse | null = null;
    try {
      primaryResponse = await runPrimary();
    } catch (error) {
      if (!isInnerTubeUnavailable(error)) {
        // A bug in the primary path, not a source failure. Surfacing it is
        // correct: falling back silently would hide the bug behind a working
        // fallback and make it unfixable.
        throw error;
      }
    }

    const canUseFallback = !isFallbackOpen();

    if (primaryResponse) {
      const decision = decideSearchSource(primaryResponse);
      if (decision.source === "innertube") {
        onPrimaryUsed();
        return primaryResponse;
      }
      // The gate rejected a result the primary DID return. That is the §39
      // parser-breakage signal, and it is recorded here because this is the
      // only layer that can tell it apart from an ordinary failure: the
      // transport saw a successful HTTP response, and the distinction between
      // "YouTube changed its markup" and "nobody uploaded anything" only
      // becomes visible once you look at whether the rows had identities in
      // them. A rising count here is the early warning that the shape adapters
      // need updating, well before anyone reports "search returns nothing".
      recordYouTubeMetric("innertube_parser_broken");
      logger.warn("InnerTube returned an unparseable result; using the official API", {
        event: "youtube.innertube.parser_broken",
        operation,
        reason: decision.reason,
      });
      // If the official API is paused, serving the untrusted primary beats an
      // error page: what it did parse is genuinely playable, it is just less
      // complete than usual.
      if (!canUseFallback) {
        recordYouTubeMetric("search.fallback_denied");
        onPrimaryUsed();
        return primaryResponse;
      }
    }

    if (!canUseFallback) {
      // The primary is broken AND the official API has no budget. This is the
      // only genuinely exhausted state, and it must not attempt the fallback
      // anyway — `client.ts` would refuse it, but a refusal discovered by
      // spending a call is exactly what the circuit exists to prevent.
      throw degraded(
        operation,
        "discovery is unavailable: the primary source did not answer and the official API is paused",
      );
    }

    const viaApi = await runFallback();
    // Recorded here rather than in each call site's callback so "how often did
    // we pay for the official API" cannot drift between operations. The two
    // per-source metrics (search.innertube / search.data_api) answer a
    // different question — which source answered — while this answers how much
    // of our traffic *paid* for the official path. The two cannot be derived
    // from one another: a fallback attempt that the circuit then refused is
    // counted as a denial, not as a call that happened.
    recordYouTubeMetric("search.fallback");
    onFallbackUsed();
    return viaApi;
  }

  return {
    searchVideos(query, searchOptions = {}) {
      return tieredSearch(
        "search",
        () => primary.searchVideos(query, searchOptions),
        () => fallback.searchVideos(query, searchOptions),
        () => recordYouTubeMetric("search.innertube"),
        () => recordYouTubeMetric("search.data_api"),
      );
    },

    searchChannels(query, searchOptions = {}) {
      return tieredSearch(
        "search",
        () => primary.searchChannels(query, searchOptions),
        () => fallback.searchChannels(query, searchOptions),
        () => recordYouTubeMetric("search.innertube"),
        () => recordYouTubeMetric("search.data_api"),
      );
    },

    searchChannelVideos(channelId, searchOptions = {}) {
      return tieredSearch(
        "search",
        () => primary.searchChannelVideos(channelId, searchOptions),
        () => fallback.searchChannelVideos(channelId, searchOptions),
        () => recordYouTubeMetric("search.innertube"),
        () => recordYouTubeMetric("search.data_api"),
      );
    },

    /**
     * Video metadata, cached PER ID rather than per batch. This is the
     * composition §26 and §15 ask for: a batch of 50 that overlaps a previous
     * batch of 10 costs 10 upstream calls, not 50, and the provider's
     * playlist hydration (which batches by 50) and the track page (which
     * fetches one) share entries instead of colliding.
     */
    async getVideos(videoIds: string[]): Promise<YouTubeVideoListResponse> {
      const ids = videoIds.filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length === 0) {
        return { items: [], pageInfo: { totalResults: 0 } };
      }
      const resolved = new Map<string, unknown>();
      const missing: string[] = [];
      for (const id of ids) {
        const hit = videoCache.peek<unknown>(videoCacheKey(id));
        if (hit !== undefined) {
          resolved.set(id, hit);
          recordYouTubeMetric("video.cache_hit");
        } else {
          missing.push(id);
        }
      }
      if (missing.length > 0) {
        let fetched: YouTubeVideoListResponse;
        try {
          fetched = await primary.getVideos(missing);
          recordYouTubeMetric("video.innertube");
        } catch (error) {
          if (!isInnerTubeUnavailable(error)) {
            throw error;
          }
          if (!fallbackClosed()) {
            throw degraded("getVideos", "video metadata unavailable", error);
          }
          recordYouTubeMetric("search.fallback");
          fetched = await fallback.getVideos(missing);
          recordYouTubeMetric("video.data_api");
        }
        for (const item of itemsOf(fetched)) {
          const id = (item as { id?: unknown } | null)?.id;
          if (typeof id !== "string" || id.length === 0) {
            continue;
          }
          resolved.set(id, item);
          // §56: a video id is a STABLE identity. Nothing derived from a
          // resolved stream URL is ever written here — `getInfo` is
          // metadata-only, and the transport's own cache refuses temporary
          // media URLs as a second line of defence.
          videoCache.set(videoCacheKey(id), item);
        }
      }
      // Preserve the caller's order; drop ids no source could resolve.
      const items = ids.flatMap((id) => {
        const item = resolved.get(id);
        return item === undefined ? [] : [item];
      });
      return { items, pageInfo: { totalResults: items.length } };
    },

    /**
     * Channel metadata: OFFICIAL-DATA-REQUIRED (§35). There is no primary
     * source for it, so this is cached rather than tiered. The cache still
     * earns its keep — an artist page costs one `channels.list` per load
     * without it, and artist pages are re-visited constantly.
     */
    async getChannels(channelIds: string[]): Promise<YouTubeChannelListResponse> {
      const ids = channelIds.filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length === 0) {
        return { items: [] };
      }
      return channelCache.resolve(
        channelCacheKey(ids),
        async () => {
          if (!fallbackClosed()) {
            throw degraded(
              "getChannels",
              "channel metadata unavailable while the Data API is paused",
            );
          }
          const response = await fallback.getChannels(ids);
          recordYouTubeMetric("channel.data_api");
          return response;
        },
        { negativeWhen: (value) => itemsOf(value).length === 0 },
      );
    },

    /**
     * Playlists: OFFICIAL-DATA-REQUIRED (§35, §22). `youtubei.js@18`'s WEB
     * `Playlist` exposes no `contents`, so there is no InnerTube path for
     * items, and `playlists.list` is already 1 unit.
     */
    getPlaylist(playlistId: string): Promise<YouTubePlaylistResource | null> {
      return playlistCache.resolve(
        playlistCacheKey(playlistId),
        async () => {
          if (!fallbackClosed()) {
            throw degraded(
              "getPlaylist",
              "playlist metadata unavailable while the Data API is paused",
            );
          }
          const resource = await fallback.getPlaylist(playlistId);
          recordYouTubeMetric("playlist.data_api");
          return resource;
        },
        // A null playlist is a negative entry: re-asking for a playlist that
        // does not exist on every page load is the same waste as re-running a
        // no-result search.
        { negativeWhen: (value) => value === null },
      );
    },

    getPlaylistItems(
      playlistId: string,
      listOptions = {},
    ): Promise<YouTubePlaylistItemsResponse> {
      return playlistCache.resolve(
        playlistItemsCacheKey(playlistId, listOptions.pageToken),
        async () => {
          if (!fallbackClosed()) {
            throw degraded(
              "getPlaylistItems",
              "playlist items unavailable while the Data API is paused",
            );
          }
          const response = await fallback.getPlaylistItems(playlistId, listOptions);
          recordYouTubeMetric("playlist.data_api");
          return response;
        },
        { negativeWhen: (value) => itemsOf(value).length === 0 },
      );
    },
  };
}
