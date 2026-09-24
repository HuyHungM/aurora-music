/**
 * Concrete Deezer `MusicProvider` over the server-only public-API transport.
 *
 * Deezer is METADATA/CATALOG ONLY. Supported capabilities (and only these):
 * search.tracks, tracks.get, search.artists, artists.get, artists.tracks,
 * search.albums, albums.get, albums.tracks, tracks.popular.
 * `stream` is unsupported: `getStreamUrl` exists only because the frozen
 * `MusicProvider` interface requires it, and always throws. Track
 * `previewUrl` values are 30-second previews preserved as metadata — never
 * full-track playback. No stream resolver exists here and none is planned
 * for Deezer; future playback resolves via TrackMatcher + YouTube.
 *
 * `getPlaylist` is an EXTRA method outside the frozen interface (which has
 * no provider-playlist concept) — the same boundary pattern Phase 03
 * established for YouTube.
 */

import type { Album, Artist, Track } from "@/lib/domain";
import { ExtractorError, NormalizationError, TrackNotFoundError } from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import type {
  MusicProvider,
  ProviderCapability,
  ProviderListResult,
  ProviderPagination,
  ProviderSearchQuery,
} from "../types";
import type { DeezerApiTransport, DeezerPagedResponse, DeezerPlaylist } from "./types";
import {
  DEEZER_PROVIDER_ID,
  isDeezerId,
  isReadableTrack,
  normalizeAlbum,
  normalizeArtist,
  normalizeTrack,
} from "./normalize";

const PROVIDER_NAME = "Deezer";

const CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "search.tracks",
  "tracks.get",
  "search.artists",
  "artists.get",
  "artists.tracks",
  "search.albums",
  "albums.get",
  "albums.tracks",
  "tracks.popular",
]);

export type DeezerProvider = MusicProvider & {
  getPlaylist(
    playlistId: string,
    pagination?: ProviderPagination,
  ): Promise<DeezerPlaylist>;
};

function requireQuery(query: ProviderSearchQuery, operation: string): string {
  const trimmed = query.query.trim();
  if (trimmed.length === 0) {
    throw new NormalizationError("query", `${operation} requires a non-empty query`);
  }
  return trimmed;
}

function requireId(value: string, field: string, label: string): string {
  const trimmed = value.trim();
  if (!isDeezerId(trimmed)) {
    throw new NormalizationError(field, `Invalid Deezer ${label} id: "${value}"`);
  }
  return trimmed;
}

function asTotal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function pagedResult<T>(
  response: DeezerPagedResponse,
  items: T[],
  offset: number,
  limit: number | undefined,
): ProviderListResult<T> {
  const total = asTotal(response.total);
  const result: ProviderListResult<T> = { items };
  if (total !== undefined) {
    result.total = total;
  }
  const pageSize = limit ?? items.length;
  const next = offset + pageSize;
  result.nextOffset = total !== undefined && next < total ? next : null;
  return result;
}

function trackItems(response: DeezerPagedResponse): Track[] {
  const data = Array.isArray(response.data) ? response.data : [];
  const tracks: Track[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Parameters<typeof normalizeTrack>[0];
    if (!isReadableTrack(candidate)) {
      continue;
    }
    const normalized = normalizeTrack(candidate);
    if (normalized) {
      tracks.push(normalized.track);
    }
  }
  return tracks;
}

export function createDeezerProvider(
  transport: DeezerApiTransport,
): DeezerProvider {
  return {
    id: DEEZER_PROVIDER_ID,
    name: PROVIDER_NAME,
    capabilities: CAPABILITIES,

    async searchTracks(query: ProviderSearchQuery): Promise<ProviderListResult<Track>> {
      const text = requireQuery(query, "searchTracks");
      const offset = query.offset ?? 0;
      const response = await transport.searchTracks(text, {
        limit: query.limit,
        index: offset,
      });
      return pagedResult(response, trackItems(response), offset, query.limit);
    },

    async searchArtists(query: ProviderSearchQuery): Promise<ProviderListResult<Artist>> {
      const text = requireQuery(query, "searchArtists");
      const offset = query.offset ?? 0;
      const response = await transport.searchArtists(text, {
        limit: query.limit,
        index: offset,
      });
      const data = Array.isArray(response.data) ? response.data : [];
      const artists: Artist[] = [];
      for (const entry of data) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const normalized = normalizeArtist(
          entry as Parameters<typeof normalizeArtist>[0],
        );
        if (normalized) {
          artists.push(normalized);
        }
      }
      return pagedResult(response, artists, offset, query.limit);
    },

    async searchAlbums(query: ProviderSearchQuery): Promise<ProviderListResult<Album>> {
      const text = requireQuery(query, "searchAlbums");
      const offset = query.offset ?? 0;
      const response = await transport.searchAlbums(text, {
        limit: query.limit,
        index: offset,
      });
      const data = Array.isArray(response.data) ? response.data : [];
      const albums: Album[] = [];
      for (const entry of data) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const normalized = normalizeAlbum(
          entry as Parameters<typeof normalizeAlbum>[0],
        );
        if (normalized) {
          albums.push(normalized);
        }
      }
      return pagedResult(response, albums, offset, query.limit);
    },

    async getTrack(trackId: string): Promise<Track> {
      const id = requireId(trackId, "providerTrackId", "track");
      // The transport maps Deezer code 800 to TrackNotFoundError.
      const object = await transport.getTrack(id);
      const normalized = normalizeTrack(object);
      if (!normalized || normalized.trackId !== id) {
        // Exact lookup only: never substitute another track.
        throw new TrackNotFoundError({
          provider: DEEZER_PROVIDER_ID,
          providerTrackId: id,
        });
      }
      return normalized.track;
    },

    async getArtist(artistId: string): Promise<Artist> {
      const id = requireId(artistId, "artistId", "artist");
      const object = await transport.getArtist(id);
      const normalized = normalizeArtist(object);
      if (!normalized) {
        throw new ExtractorError(DEEZER_PROVIDER_ID, "getArtist", "Artist not found");
      }
      return normalized;
    },

    getAlbum(albumId: string): Promise<Album> {
      const id = requireId(albumId, "albumId", "album");
      return transport.getAlbum(id).then((object) => {
        const normalized = normalizeAlbum(object);
        if (!normalized) {
          throw new ExtractorError(DEEZER_PROVIDER_ID, "getAlbum", "Album not found");
        }
        return normalized;
      });
    },

    async getAlbumTracks(
      albumId: string,
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Track>> {
      const id = requireId(albumId, "albumId", "album");
      const offset = pagination?.offset ?? 0;
      const needed = (pagination?.limit ?? 50) + offset;
      const collected: Track[] = [];
      let total: number | undefined;
      let index = 0;
      // Bounded walk: enough pages to satisfy offset+limit, max 10 pages.
      for (let page = 0; page < 10; page += 1) {
        const response = await transport.getAlbumTracks(id, {
          limit: 100,
          index,
        });
        if (total === undefined) {
          total = asTotal(response.total);
        }
        const data = Array.isArray(response.data) ? response.data : [];
        if (data.length === 0) {
          break;
        }
        for (const entry of data) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const candidate = entry as Parameters<typeof normalizeTrack>[0];
          if (!isReadableTrack(candidate)) {
            continue;
          }
          const normalized = normalizeTrack(candidate);
          if (normalized) {
            // Preserve album context the collection implies.
            if (!normalized.track.albumId) {
              normalized.track.albumId = id;
            }
            collected.push(normalized.track);
          }
        }
        index += data.length;
        if (collected.length >= needed) {
          break;
        }
        if (total !== undefined && index >= total) {
          break;
        }
      }
      const windowed = collected.slice(offset, offset + (pagination?.limit ?? collected.length));
      const result: ProviderListResult<Track> = { items: windowed };
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + windowed.length;
      result.nextOffset =
        total !== undefined && next < total ? next : null;
      return result;
    },

    async getArtistTracks(
      artistId: string,
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Track>> {
      const id = requireId(artistId, "artistId", "artist");
      const offset = pagination?.offset ?? 0;
      // Deezer "top" ranking, not chronological — documented ordering.
      const response = await transport.getArtistTopTracks(id, {
        limit: pagination?.limit,
        index: offset,
      });
      return pagedResult(response, trackItems(response), offset, pagination?.limit);
    },

    async getPopularTracks(
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Track>> {
      const offset = pagination?.offset ?? 0;
      const response = await transport.getChartTracks({
        limit: pagination?.limit,
        index: offset,
      });
      return pagedResult(response, trackItems(response), offset, pagination?.limit);
    },

    getFeaturedTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          DEEZER_PROVIDER_ID,
          "tracks.featured",
          "Featured tracks are not supported by the Deezer provider",
        ),
      );
    },

    getRecommendations(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          DEEZER_PROVIDER_ID,
          "tracks.recommendations",
          "Recommendations are not supported by the Deezer provider",
        ),
      );
    },

    getStreamUrl(): Promise<string> {
      // Metadata/catalog only: no full-track playback exists for Deezer.
      // The method exists only because the frozen interface requires it.
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          DEEZER_PROVIDER_ID,
          "stream",
          "Stream resolution is not supported by the Deezer provider",
        ),
      );
    },

    async getPlaylist(
      playlistId: string,
      pagination?: ProviderPagination,
    ): Promise<DeezerPlaylist> {
      const id = requireId(playlistId, "playlistId", "playlist");
      const resource = await transport.getPlaylist(id);
      const title =
        typeof resource.title === "string" && resource.title.trim().length > 0
          ? resource.title.trim()
          : "Untitled playlist";

      const limit = pagination?.limit ?? 50;
      const offset = pagination?.offset ?? 0;
      const needed = offset + limit;
      const ordered: Track[] = [];
      let total = asTotal(resource.nb_tracks);
      let index = 0;
      for (let page = 0; page < 10; page += 1) {
        const response = await transport.getPlaylistTracks(id, {
          limit: 100,
          index,
        });
        if (total === undefined) {
          total = asTotal(response.total);
        }
        const data = Array.isArray(response.data) ? response.data : [];
        if (data.length === 0) {
          break;
        }
        for (const entry of data) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const candidate = entry as Parameters<typeof normalizeTrack>[0];
          if (!isReadableTrack(candidate)) {
            continue;
          }
          const normalized = normalizeTrack(candidate);
          if (normalized && !ordered.some((track) => track.id === normalized.trackId)) {
            ordered.push(normalized.track);
          }
        }
        index += data.length;
        if (ordered.length >= needed) {
          break;
        }
        if (total !== undefined && index >= total) {
          break;
        }
      }
      const windowed = ordered.slice(offset, offset + limit);

      const playlist: DeezerPlaylist = {
        id,
        provider: DEEZER_PROVIDER_ID,
        providerPlaylistId: id,
        title,
        tracks: windowed,
      };
      if (typeof resource.description === "string" && resource.description.length > 0) {
        playlist.description = resource.description;
      }
      const artwork =
        typeof resource.picture_big === "string" && resource.picture_big.length > 0
          ? resource.picture_big
          : typeof resource.picture_medium === "string" && resource.picture_medium.length > 0
            ? resource.picture_medium
            : undefined;
      if (artwork) {
        playlist.artworkUrl = artwork;
      }
      if (total !== undefined) {
        playlist.total = total;
      }
      return playlist;
    },
  };
}
