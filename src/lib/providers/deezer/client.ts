/**
 * Server-only Deezer public API transport over native fetch.
 *
 * Zero new dependencies. The catalog endpoints used here (`search`,
 * `track`, `artist`, `album`, `playlist`, `chart`) require no credentials,
 * so this client carries no secrets.
 *
 * Deezer quirks handled here:
 * - Data errors arrive as HTTP 200 + `{"error": {type, message, code}}`.
 *   Code 800 means "no data" (unknown id); code 4 means quota exceeded.
 * - All failures are normalized to Aurora engine errors; raw fetch errors
 *   never escape this boundary.
 */

import { ExtractorError, TrackNotFoundError } from "@/lib/domain";
import type { TrackRef } from "@/lib/domain";
import type {
  DeezerAlbumObject,
  DeezerApiTransport,
  DeezerArtistObject,
  DeezerPagedResponse,
  DeezerPaging,
  DeezerPlaylistObject,
  DeezerTrackObject,
} from "./types";

const API_BASE = "https://api.deezer.com";
const REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_ID = "deezer";

/** Deezer "no data" code for unknown ids. */
const NO_DATA_CODE = 800;
/** Deezer quota-exceeded code. */
const QUOTA_CODE = 4;

function asErrorCode(body: unknown): number | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function errorMessage(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return "";
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
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

export interface DeezerClientOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export function createDeezerApiTransport(
  options: DeezerClientOptions = {},
): DeezerApiTransport {
  const fetchFn: FetchFn =
    options.fetchFn ??
    ((input, init) =>
      fetch(input, init) as Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }>);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request(
    operation: string,
    path: string,
    params: Record<string, string> = {},
    notFound?: { ref?: TrackRef; message: string },
  ): Promise<unknown> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await fetchFn(url.toString(), {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ExtractorError(
        PROVIDER_ID,
        operation,
        error instanceof Error ? `Deezer request failed: ${error.message}` : "Deezer request failed",
        { retryable: true, cause: error },
      );
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch (error) {
      throw new ExtractorError(PROVIDER_ID, operation, "Deezer returned an unreadable response", {
        cause: error,
      });
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new ExtractorError(PROVIDER_ID, operation, "Deezer rate limit exceeded", {
          retryable: true,
        });
      }
      if (response.status >= 500) {
        throw new ExtractorError(PROVIDER_ID, operation, "Deezer unavailable", {
          retryable: true,
        });
      }
      const code = asErrorCode(body);
      if (code === QUOTA_CODE) {
        throw new ExtractorError(PROVIDER_ID, operation, "Deezer quota exceeded", {
          retryable: true,
        });
      }
      const detail = errorMessage(body) || `Deezer API error ${response.status}`;
      throw new ExtractorError(PROVIDER_ID, operation, detail);
    }

    const code = asErrorCode(body);
    if (code !== null) {
      // HTTP 200 with an error envelope.
      if (code === QUOTA_CODE) {
        throw new ExtractorError(PROVIDER_ID, operation, "Deezer quota exceeded", {
          retryable: true,
        });
      }
      if (code === NO_DATA_CODE && notFound) {
        // Unknown id for an exact lookup: structural not-found, never a
        // failure. Search paths never pass `notFound`, so a zero-result
        // search (plain `data: []`) stays distinct from this path.
        if (notFound.ref) {
          throw new TrackNotFoundError(notFound.ref);
        }
        throw new ExtractorError(PROVIDER_ID, operation, notFound.message, {
          retryable: false,
        });
      }
      const detail = errorMessage(body) || "Deezer request failed";
      throw new ExtractorError(PROVIDER_ID, operation, detail, {
        retryable: false,
      });
    }

    return body;
  }

  function pagingParams(paging: DeezerPaging = {}): Record<string, string> {
    const params: Record<string, string> = {};
    if (paging.limit !== undefined) {
      params.limit = String(clampLimit(paging.limit));
    }
    if (paging.index !== undefined) {
      params.index = String(clampIndex(paging.index));
    }
    return params;
  }

  function asObject<T>(operation: string, body: unknown): T {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ExtractorError(PROVIDER_ID, operation, "Deezer returned a malformed response");
    }
    return body as T;
  }

  async function getObject<T>(
    operation: string,
    path: string,
    notFoundMessage: string,
  ): Promise<T> {
    const body = await request(operation, path, {}, { message: notFoundMessage });
    return asObject<T>(operation, body);
  }

  return {
    async searchTracks(query, paging = {}) {
      return (await request("search", "/search", {
        q: query,
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async searchArtists(query, paging = {}) {
      return (await request("search", "/search/artist", {
        q: query,
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async searchAlbums(query, paging = {}) {
      return (await request("search", "/search/album", {
        q: query,
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async getTrack(trackId) {
      const body = await request(
        "getTrack",
        `/track/${trackId}`,
        {},
        {
          ref: { provider: PROVIDER_ID, providerTrackId: trackId },
          message: "Track not found",
        },
      );
      return asObject<DeezerTrackObject>("getTrack", body);
    },

    async getArtist(artistId) {
      const body = await request(
        "getArtist",
        `/artist/${artistId}`,
        {},
        { message: "Artist not found" },
      );
      return asObject<DeezerArtistObject>("getArtist", body);
    },

    async getArtistTopTracks(artistId, paging = {}) {
      return (await request("getArtistTopTracks", `/artist/${artistId}/top`, {
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async getAlbum(albumId) {
      return getObject<DeezerAlbumObject>("getAlbum", `/album/${albumId}`, "Album not found");
    },

    async getAlbumTracks(albumId, paging = {}) {
      return (await request("getAlbumTracks", `/album/${albumId}/tracks`, {
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async getPlaylist(playlistId) {
      return getObject<DeezerPlaylistObject>(
        "getPlaylist",
        `/playlist/${playlistId}`,
        "Playlist not found",
      );
    },

    async getPlaylistTracks(playlistId, paging = {}) {
      return (await request("getPlaylistTracks", `/playlist/${playlistId}/tracks`, {
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },

    async getChartTracks(paging = {}) {
      return (await request("getChartTracks", "/chart/0/tracks", {
        ...pagingParams(paging),
      })) as DeezerPagedResponse;
    },
  };
}

export { NO_DATA_CODE };

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 25;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 100);
}

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.max(Math.floor(index), 0);
}
