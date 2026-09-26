/**
 * Server-only YouTube Data API v3 transport over native fetch.
 *
 * This is the OFFICIAL adapter and the only module that spends official
 * quota. Phase 55 moved discovery (search, video metadata) to InnerTube and
 * left this file with the operations that genuinely need official semantics:
 * channel metadata, and playlists. See `docs/youtube-request-map.md` for the
 * per-endpoint justification and `tiered-transport.ts` for the source
 * selection that keeps this adapter out of the common path.
 *
 * All failures are normalized to Aurora engine errors at this boundary;
 * raw fetch/SDK errors never escape.
 */

import { ExtractorError } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";
import { dataApiCircuit } from "./innertube/data-api-circuit";
import type { DataApiCircuit } from "./innertube/data-api-circuit";
import { recordYouTubeMetric } from "./innertube/metrics";
import type {
  YouTubeApiTransport,
  YouTubeChannelListResponse,
  YouTubePlaylistItemsResponse,
  YouTubePlaylistResource,
  YouTubeSearchResponse,
  YouTubeVideoListResponse,
} from "./types";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_ID = "youtube";

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    errors?: Array<{ reason?: unknown; message?: unknown }>;
  };
}

function firstReason(body: ApiErrorBody): string | null {
  const reasons = body.error?.errors ?? [];
  for (const entry of reasons) {
    if (typeof entry?.reason === "string" && entry.reason.length > 0) {
      return entry.reason;
    }
  }
  return null;
}

function mapApiFailure(
  operation: string,
  status: number,
  body: ApiErrorBody,
  message: string,
): never {
  const reason = firstReason(body);
  const detail = typeof message === "string" && message.length > 0 ? message : `YouTube API error ${status}`;

  if (
    status === 401 ||
    status === 403 ||
    reason === "API_KEY_INVALID" ||
    reason === "API_KEY_NOT_VALID" ||
    reason === "accessNotConfigured" ||
    reason === "forbidden"
  ) {
    // 403 overlaps quota errors; quota reasons are checked first below by
    // callers? No — order matters: check quota reasons before credentials.
    if (
      reason === "quotaExceeded" ||
      reason === "dailyLimitExceeded" ||
      reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded"
    ) {
      throw new ExtractorError(PROVIDER_ID, operation, `YouTube quota exceeded: ${detail}`, {
        retryable: reason === "rateLimitExceeded" || reason === "userRateLimitExceeded",
      });
    }
    throw new InvalidProviderCredentialsError(PROVIDER_ID, `YouTube credentials rejected: ${detail}`);
  }

  if (
    reason === "quotaExceeded" ||
    reason === "dailyLimitExceeded" ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded" ||
    status === 429
  ) {
    throw new ExtractorError(PROVIDER_ID, operation, `YouTube quota exceeded: ${detail}`, {
      retryable: reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || status === 429,
    });
  }

  if (status >= 500) {
    throw new ExtractorError(PROVIDER_ID, operation, `YouTube unavailable: ${detail}`, {
      retryable: true,
    });
  }

  throw new ExtractorError(PROVIDER_ID, operation, detail);
}

/**
 * Narrow fetch dependency for tests. Defaults to the global fetch so
 * production uses no wrapper and tests inject recorded fixtures.
 */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface YouTubeClientOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  /**
   * Quota breaker. Defaults to the process-wide instance so production cannot
   * forget it. Tests pass their own (or call `dataApiCircuit.reset()`), because
   * the breaker is deliberately process state: sharing it is the point.
   */
  circuit?: DataApiCircuit;
}

export function createYouTubeApiTransport(
  apiKey: string,
  options: YouTubeClientOptions = {},
): YouTubeApiTransport {
  const fetchFn: FetchFn =
    options.fetchFn ??
    ((input, init) =>
      fetch(input, init) as Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }>);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const circuit = options.circuit ?? dataApiCircuit;

  async function request(
    operation: string,
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (circuit.shouldSkip()) {
      // Thrown BEFORE the fetch: an open circuit means the call is known to
      // fail, and spending an upstream round-trip to learn that again is the
      // behaviour this phase exists to remove.
      throw new ExtractorError(
        PROVIDER_ID,
        operation,
        "YouTube Data API is paused after a quota failure",
        { retryable: false },
      );
    }
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set("key", apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await fetchFn(url.toString(), {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      circuit.reportOtherFailure();
      throw new ExtractorError(
        PROVIDER_ID,
        operation,
        error instanceof Error ? `YouTube request failed: ${error.message}` : "YouTube request failed",
        { retryable: true, cause: error },
      );
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch (error) {
      circuit.reportOtherFailure();
      throw new ExtractorError(PROVIDER_ID, operation, "YouTube returned an unreadable response", {
        cause: error,
      });
    }

    if (!response.ok) {
      const parsed = (body ?? {}) as ApiErrorBody;
      const message =
        typeof parsed.error?.message === "string" ? parsed.error.message : "";
      // Classify BEFORE mapping, so the breaker sees Google's own reason
      // rather than having to recover it from a message string.
      circuit.reportQuotaFailure(firstReason(parsed), response.status);
      recordYouTubeMetric("data_api_failed");
      mapApiFailure(operation, response.status, parsed, message);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      circuit.reportOtherFailure();
      throw new ExtractorError(PROVIDER_ID, operation, "YouTube returned a malformed response");
    }
    const record = body as Record<string, unknown>;
    if (record.items !== undefined && !Array.isArray(record.items)) {
      circuit.reportOtherFailure();
      throw new ExtractorError(PROVIDER_ID, operation, "YouTube returned a malformed response");
    }
    circuit.reportSuccess();
    return record;
  }

  return {
    async searchVideos(query, searchOptions = {}) {
      const params: Record<string, string> = {
        part: "snippet",
        type: "video",
        q: query,
        maxResults: String(clampLimit(searchOptions.limit)),
      };
      if (searchOptions.pageToken) {
        params.pageToken = searchOptions.pageToken;
      }
      return (await request("search", "/search", params)) as unknown as YouTubeSearchResponse;
    },

    async searchChannels(query, searchOptions = {}) {
      const params: Record<string, string> = {
        part: "snippet",
        type: "channel",
        q: query,
        maxResults: String(clampLimit(searchOptions.limit)),
      };
      if (searchOptions.pageToken) {
        params.pageToken = searchOptions.pageToken;
      }
      return (await request("search", "/search", params)) as unknown as YouTubeSearchResponse;
    },

    async getVideos(videoIds) {
      // `part` is exactly what `normalizeVideo` reads and nothing more.
      // `status` was previously requested and never consumed — `privacyStatus`
      // is only read by `isAvailableVideo`, which the provider does not call
      // (private videos surface as `TrackNotFoundError` on exact lookup, not
      // as a filtered row). Requesting a part nobody reads is a documented
      // waste; §27 says request only what is needed.
      return (await request("getVideos", "/videos", {
        part: "snippet,contentDetails",
        id: videoIds.join(","),
        maxResults: String(Math.min(videoIds.length, 50)),
      })) as unknown as YouTubeVideoListResponse;
    },

    async searchChannelVideos(channelId, searchOptions = {}) {
      const params: Record<string, string> = {
        part: "snippet",
        type: "video",
        channelId,
        order: "date",
        maxResults: String(clampLimit(searchOptions.limit)),
      };
      if (searchOptions.pageToken) {
        params.pageToken = searchOptions.pageToken;
      }
      return (await request("getChannelVideos", "/search", params)) as unknown as YouTubeSearchResponse;
    },

    async getChannels(channelIds) {
      return (await request("getChannels", "/channels", {
        part: "snippet",
        id: channelIds.join(","),
        maxResults: String(Math.min(channelIds.length, 50)),
      })) as unknown as YouTubeChannelListResponse;
    },

    async getPlaylist(playlistId) {
      const response = (await request("getPlaylist", "/playlists", {
        part: "snippet,contentDetails",
        id: playlistId,
      })) as unknown as { items?: unknown };
      const items = Array.isArray(response.items) ? response.items : [];
      const first = items[0] as YouTubePlaylistResource | undefined;
      return first ?? null;
    },

    async getPlaylistItems(playlistId, listOptions = {}) {
      return (await request("getPlaylistItems", "/playlistItems", {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults: String(clampLimit(listOptions.limit, 50)),
        ...(listOptions.pageToken ? { pageToken: listOptions.pageToken } : {}),
      })) as unknown as YouTubePlaylistItemsResponse;
    },
  };
}

function clampLimit(limit: number | undefined, max = 25): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(limit), 1), max);
}
