/**
 * Server-only Spotify Web API transport over native fetch.
 *
 * Zero new dependencies. Bearer tokens come from the injected token
 * source (Client Credentials, in-memory only). One-recovery rule per
 * logical request: on 401 the cached token is invalidated, refreshed
 * ONCE, and the request retried ONCE — a second 401 becomes a credential
 * failure, never a loop.
 *
 * Uses only CURRENT endpoints (no removed batch/top-tracks/browse APIs).
 * All failures are normalized to Aurora engine errors; raw HTTP details,
 * tokens, and secrets never escape this boundary.
 */

import { ExtractorError, TrackNotFoundError } from "@/lib/domain";
import type { TrackRef } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";
import type {
  SpotifyAlbumObject,
  SpotifyApiTransport,
  SpotifyArtistObject,
  SpotifyPage,
  SpotifyPaging,
  SpotifyPlaylistItemsResponse,
  SpotifyPlaylistObject,
  SpotifySearchResponse,
  SpotifyTokenSource,
  SpotifyTrackObject,
} from "./types";

const API_BASE = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_ID = "spotify";

export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SpotifyClientOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

interface FailedResponse {
  status: number;
  message: string;
}

function spotifyErrorMessage(body: unknown): string {
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

export function createSpotifyApiTransport(
  tokenSource: SpotifyTokenSource,
  options: SpotifyClientOptions = {},
): SpotifyApiTransport {
  const fetchFn: FetchFn =
    options.fetchFn ??
    ((input, init) =>
      fetch(input, init) as Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }>);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function rawGet(
    operation: string,
    path: string,
    params: Record<string, string>,
    token: string,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ExtractorError(
        PROVIDER_ID,
        operation,
        "Spotify request failed",
        { retryable: true, cause: error },
      );
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (error) {
      throw new ExtractorError(PROVIDER_ID, operation, "Spotify returned an unreadable response", {
        cause: error,
      });
    }
    return { status: response.status, body };
  }

  function classify(
    operation: string,
    failed: FailedResponse,
    notFound?: { ref?: TrackRef; message: string },
  ): never {
    const { status, message } = failed;
    const detail = message || `Spotify API error ${status}`;
    if (status === 400) {
      throw new ExtractorError(PROVIDER_ID, operation, `Invalid Spotify request: ${detail}`);
    }
    if (status === 401) {
      // Reached only after the one-refresh recovery failed: the token
      // itself is rejected, so this is a credential problem.
      throw new InvalidProviderCredentialsError(PROVIDER_ID, "Spotify rejected the access token");
    }
    if (status === 403) {
      throw new ExtractorError(PROVIDER_ID, operation, `Spotify forbids this request: ${detail}`);
    }
    if (status === 404) {
      if (notFound?.ref) {
        throw new TrackNotFoundError(notFound.ref);
      }
      throw new ExtractorError(PROVIDER_ID, operation, notFound?.message ?? "Not found");
    }
    if (status === 429) {
      throw new ExtractorError(PROVIDER_ID, operation, "Spotify rate limit exceeded", {
        retryable: true,
      });
    }
    if (status >= 500) {
      throw new ExtractorError(PROVIDER_ID, operation, "Spotify unavailable", {
        retryable: true,
      });
    }
    throw new ExtractorError(PROVIDER_ID, operation, detail);
  }

  async function request(
    operation: string,
    path: string,
    params: Record<string, string> = {},
    notFound?: { ref?: TrackRef; message: string },
  ): Promise<unknown> {
    const token = await tokenSource.getAccessToken();
    const first = await rawGet(operation, path, params, token);
    if (first.status >= 200 && first.status < 300) {
      return first.body;
    }
    if (first.status !== 401) {
      classify(operation, { status: first.status, message: spotifyErrorMessage(first.body) }, notFound);
    }
    // One-recovery rule: invalidate, refresh once, retry once.
    tokenSource.invalidate();
    const fresh = await tokenSource.getAccessToken();
    const second = await rawGet(operation, path, params, fresh);
    if (second.status >= 200 && second.status < 300) {
      return second.body;
    }
    classify(operation, { status: second.status, message: spotifyErrorMessage(second.body) }, notFound);
  }

  function asObject<T>(operation: string, body: unknown): T {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ExtractorError(PROVIDER_ID, operation, "Spotify returned a malformed response");
    }
    return body as T;
  }

  function pagingParams(paging: SpotifyPaging = {}): Record<string, string> {
    const params: Record<string, string> = {};
    if (paging.limit !== undefined) {
      params.limit = String(clampLimit(paging.limit));
    }
    if (paging.offset !== undefined) {
      params.offset = String(clampOffset(paging.offset));
    }
    return params;
  }

  return {
    async search(query, types, paging = {}) {
      const body = await request("search", "/search", {
        q: query,
        type: types.join(","),
        ...pagingParams(paging),
      });
      return asObject<SpotifySearchResponse>("search", body);
    },

    async getTrack(trackId) {
      const body = await request("getTrack", `/tracks/${trackId}`, {}, {
        ref: { provider: PROVIDER_ID, providerTrackId: trackId },
        message: "Track not found",
      });
      return asObject<SpotifyTrackObject>("getTrack", body);
    },

    async getArtist(artistId) {
      const body = await request("getArtist", `/artists/${artistId}`, {}, {
        message: "Artist not found",
      });
      return asObject<SpotifyArtistObject>("getArtist", body);
    },

    async getArtistAlbums(artistId, paging = {}) {
      const body = await request(
        "getArtistAlbums",
        `/artists/${artistId}/albums`,
        pagingParams(paging),
        { message: "Artist not found" },
      );
      return asObject<SpotifyPage>("getArtistAlbums", body);
    },

    async getAlbum(albumId) {
      const body = await request("getAlbum", `/albums/${albumId}`, {}, {
        message: "Album not found",
      });
      return asObject<SpotifyAlbumObject>("getAlbum", body);
    },

    async getAlbumTracks(albumId, paging = {}) {
      const body = await request(
        "getAlbumTracks",
        `/albums/${albumId}/tracks`,
        pagingParams(paging),
        { message: "Album not found" },
      );
      return asObject<SpotifyPage>("getAlbumTracks", body);
    },

    async getPlaylist(playlistId) {
      const body = await request("getPlaylist", `/playlists/${playlistId}`, {
        fields: "id,name,description,images,owner,tracks.total,external_urls",
      }, { message: "Playlist not found" });
      return asObject<SpotifyPlaylistObject>("getPlaylist", body);
    },

    async getPlaylistItems(playlistId, paging = {}) {
      const body = await request(
        "getPlaylistItems",
        `/playlists/${playlistId}/items`,
        pagingParams(paging),
        { message: "Playlist not found" },
      );
      return asObject<SpotifyPlaylistItemsResponse>("getPlaylistItems", body);
    },
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 10;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 50);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(Math.floor(offset), 0);
}
