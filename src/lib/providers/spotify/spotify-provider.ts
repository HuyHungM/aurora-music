/**
 * Concrete Spotify `MusicProvider` over the server-only Web API transport.
 *
 * Spotify is METADATA/CATALOG ONLY. Supported capabilities (and only these):
 * search.tracks, tracks.get, search.artists, artists.get, search.albums,
 * albums.get, albums.tracks.
 * `artists.tracks` is unsupported: the old top-tracks endpoint was removed
 * and artist albums cannot honestly fill a "tracks" contract. `stream` is
 * unsupported: `getStreamUrl` exists only because the frozen interface
 * requires it. No Web Playback SDK, no audio extraction, no ripping.
 *
 * Extras outside the frozen interface (same boundary pattern as YouTube /
 * Deezer): `getArtistAlbums` (the still-supported artist catalog endpoint)
 * and `getPlaylist` (metadata + best-effort items; app-only authorization
 * can 403 on out-of-scope playlists, surfaced as a permission failure).
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
import type {
  SpotifyAlbumObject,
  SpotifyApiTransport,
  SpotifyArtistObject,
  SpotifyPage,
  SpotifyPlaylist,
  SpotifyTrackObject,
} from "./types";
import {
  SPOTIFY_PROVIDER_ID,
  isSpotifyId,
  normalizeAlbum,
  normalizeArtist,
  normalizeImages,
  normalizeTrack,
} from "./normalize";

const PROVIDER_NAME = "Spotify";

/**
 * Search API cap per request; larger asks paginate boundedly.
 *
 * This is the API's own maximum, not a conservative default. At 10 the search
 * page — which asks for 20 — spent two sequential round trips per type-
 * scoped search, three searches per render, for a result set the second
 * request could not grow past. One request now covers every ask the product
 * makes, and the loop below is only reached by a caller wanting more than the
 * API returns in one page.
 */
const SEARCH_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 5;
/** Collection page size for albums/playlists/artist-albums. */
const COLLECTION_PAGE_SIZE = 50;
const MAX_COLLECTION_PAGES = 5;

const CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "search.tracks",
  "tracks.get",
  "search.artists",
  "artists.get",
  "search.albums",
  "albums.get",
  "albums.tracks",
]);

export type SpotifyProvider = MusicProvider & {
  getArtistAlbums(
    artistId: string,
    pagination?: ProviderPagination,
  ): Promise<ProviderListResult<Album>>;
  getPlaylist(
    playlistId: string,
    pagination?: ProviderPagination,
  ): Promise<SpotifyPlaylist>;
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
  if (!isSpotifyId(trimmed)) {
    throw new NormalizationError(field, `Invalid Spotify ${label} id: "${value}"`);
  }
  return trimmed;
}

function asTotal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function pageItems<T>(page: SpotifyPage | null | undefined): T[] {
  if (!page || !Array.isArray(page.items)) {
    return [];
  }
  return page.items.filter((entry): entry is T => !!entry && typeof entry === "object");
}

export function createSpotifyProvider(
  transport: SpotifyApiTransport,
): SpotifyProvider {
  type SearchRaw = SpotifyTrackObject | SpotifyArtistObject | SpotifyAlbumObject;

  async function searchPaged(
    kind: "track" | "artist" | "album",
    text: string,
    limit: number | undefined,
    offset: number,
  ): Promise<{ raw: SearchRaw[]; total: number | undefined }> {
    const want = limit ?? SEARCH_PAGE_SIZE;
    const pages = Math.min(Math.ceil(want / SEARCH_PAGE_SIZE), MAX_SEARCH_PAGES);
    const raw: SearchRaw[] = [];
    let total: number | undefined;
    for (let page = 0; page < pages; page += 1) {
      const pageOffset = offset + page * SEARCH_PAGE_SIZE;
      const pageSize = Math.min(SEARCH_PAGE_SIZE, want - raw.length);
      if (pageSize <= 0) {
        break;
      }
      const response = await transport.search(text, [kind], {
        limit: pageSize,
        offset: pageOffset,
      });
      const section = kind === "track" ? response.tracks : kind === "artist" ? response.artists : response.albums;
      if (total === undefined) {
        total = asTotal(section?.total);
      }
      const items = pageItems<SearchRaw>(section);
      raw.push(...items);
      if (items.length < pageSize) {
        break;
      }
    }
    return { raw, total };
  }

  return {
    id: SPOTIFY_PROVIDER_ID,
    name: PROVIDER_NAME,
    capabilities: CAPABILITIES,

    async searchTracks(query: ProviderSearchQuery): Promise<ProviderListResult<Track>> {
      const text = requireQuery(query, "searchTracks");
      const offset = query.offset ?? 0;
      const { raw, total } = await searchPaged("track", text, query.limit, offset);
      const tracks: Track[] = [];
      for (const entry of raw) {
        const normalized = normalizeTrack(entry as SpotifyTrackObject);
        if (normalized) {
          tracks.push(normalized.track);
        }
      }
      const result: ProviderListResult<Track> = { items: tracks };
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + tracks.length;
      result.nextOffset = total !== undefined && next < total ? next : null;
      return result;
    },

    async searchArtists(query: ProviderSearchQuery): Promise<ProviderListResult<Artist>> {
      const text = requireQuery(query, "searchArtists");
      const offset = query.offset ?? 0;
      const { raw, total } = await searchPaged("artist", text, query.limit, offset);
      const artists: Artist[] = [];
      for (const entry of raw) {
        const normalized = normalizeArtist(entry as SpotifyArtistObject);
        if (normalized) {
          artists.push(normalized);
        }
      }
      const result: ProviderListResult<Artist> = { items: artists };
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + artists.length;
      result.nextOffset = total !== undefined && next < total ? next : null;
      return result;
    },

    async searchAlbums(query: ProviderSearchQuery): Promise<ProviderListResult<Album>> {
      const text = requireQuery(query, "searchAlbums");
      const offset = query.offset ?? 0;
      const { raw, total } = await searchPaged("album", text, query.limit, offset);
      const albums: Album[] = [];
      for (const entry of raw) {
        const normalized = normalizeAlbum(entry as SpotifyAlbumObject);
        if (normalized) {
          albums.push(normalized);
        }
      }
      const result: ProviderListResult<Album> = { items: albums };
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + albums.length;
      result.nextOffset = total !== undefined && next < total ? next : null;
      return result;
    },

    async getTrack(trackId: string): Promise<Track> {
      const id = requireId(trackId, "providerTrackId", "track");
      // The transport maps 404 to TrackNotFoundError.
      const object = await transport.getTrack(id);
      const normalized = normalizeTrack(object);
      if (!normalized || normalized.trackId !== id) {
        // Exact lookup only: never substitute another track.
        throw new TrackNotFoundError({
          provider: SPOTIFY_PROVIDER_ID,
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
        throw new ExtractorError(SPOTIFY_PROVIDER_ID, "getArtist", "Artist not found");
      }
      return normalized;
    },

    getAlbum(albumId: string): Promise<Album> {
      const id = requireId(albumId, "albumId", "album");
      return transport.getAlbum(id).then((object) => {
        const normalized = normalizeAlbum(object);
        if (!normalized) {
          throw new ExtractorError(SPOTIFY_PROVIDER_ID, "getAlbum", "Album not found");
        }
        return normalized;
      });
    },

    async getAlbumTracks(
      albumId: string,
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Track>> {
      const id = requireId(albumId, "albumId", "album");
      const limit = pagination?.limit ?? COLLECTION_PAGE_SIZE;
      const offset = pagination?.offset ?? 0;
      const pages = Math.min(
        Math.ceil((offset + limit) / COLLECTION_PAGE_SIZE) || 1,
        MAX_COLLECTION_PAGES,
      );
      const collected: Track[] = [];
      let total: number | undefined;
      for (let page = 0; page < pages; page += 1) {
        const response = await transport.getAlbumTracks(id, {
          limit: COLLECTION_PAGE_SIZE,
          offset: page * COLLECTION_PAGE_SIZE,
        });
        if (total === undefined) {
          total = asTotal(response.total);
        }
        const items = pageItems<SpotifyTrackObject>(response);
        if (items.length === 0) {
          break;
        }
        for (const entry of items) {
          const normalized = normalizeTrack(entry);
          if (normalized) {
            // Album-track items are simplified (no album embedding):
            // restore the collection context the request implies.
            if (!normalized.track.albumId) {
              normalized.track.albumId = id;
            }
            collected.push(normalized.track);
          }
        }
        if (collected.length >= offset + limit) {
          break;
        }
        if (total !== undefined && (page + 1) * COLLECTION_PAGE_SIZE >= total) {
          break;
        }
      }
      const windowed = collected.slice(offset, offset + limit);
      const result: ProviderListResult<Track> = { items: windowed };
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + windowed.length;
      result.nextOffset = total !== undefined && next < total ? next : null;
      return result;
    },

    getArtistTracks(): Promise<ProviderListResult<Track>> {
      // The removed top-tracks endpoint has no honest replacement: artist
      // albums cannot fill a "tracks" contract without faking data.
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          SPOTIFY_PROVIDER_ID,
          "artists.tracks",
          "Artist top tracks were removed from the Spotify API and have no replacement",
        ),
      );
    },

    async getArtistAlbums(
      artistId: string,
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Album>> {
      const id = requireId(artistId, "artistId", "artist");
      const limit = pagination?.limit ?? COLLECTION_PAGE_SIZE;
      const offset = pagination?.offset ?? 0;
      const response = await transport.getArtistAlbums(id, {
        limit: Math.min(limit, COLLECTION_PAGE_SIZE),
        offset,
      });
      const albums: Album[] = [];
      for (const entry of pageItems<SpotifyAlbumObject>(response)) {
        const normalized = normalizeAlbum(entry);
        if (normalized) {
          albums.push(normalized);
        }
      }
      const result: ProviderListResult<Album> = { items: albums };
      const total = asTotal(response.total);
      if (total !== undefined) {
        result.total = total;
      }
      const next = offset + albums.length;
      result.nextOffset = total !== undefined && next < total ? next : null;
      return result;
    },

    getPopularTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          SPOTIFY_PROVIDER_ID,
          "tracks.popular",
          "Popular tracks are not supported by the Spotify provider",
        ),
      );
    },

    getFeaturedTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          SPOTIFY_PROVIDER_ID,
          "tracks.featured",
          "Featured tracks are not supported by the Spotify provider",
        ),
      );
    },

    getRecommendations(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          SPOTIFY_PROVIDER_ID,
          "tracks.recommendations",
          "Recommendations are not supported by the Spotify provider",
        ),
      );
    },

    getStreamUrl(): Promise<string> {
      // Metadata/catalog only: no Spotify playback exists or is planned.
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          SPOTIFY_PROVIDER_ID,
          "stream",
          "Stream resolution is not supported by the Spotify provider",
        ),
      );
    },

    async getPlaylist(
      playlistId: string,
      pagination?: ProviderPagination,
    ): Promise<SpotifyPlaylist> {
      const id = requireId(playlistId, "playlistId", "playlist");
      const resource = await transport.getPlaylist(id);
      const title =
        typeof resource.name === "string" && resource.name.trim().length > 0
          ? resource.name.trim()
          : "Untitled playlist";

      const limit = pagination?.limit ?? COLLECTION_PAGE_SIZE;
      const offset = pagination?.offset ?? 0;
      const needed = offset + limit;
      const ordered: Track[] = [];
      let total = asTotal(resource.tracks?.total);
      for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
        const response = await transport.getPlaylistItems(id, {
          limit: COLLECTION_PAGE_SIZE,
          offset: page * COLLECTION_PAGE_SIZE,
        });
        if (total === undefined) {
          total = asTotal(response.total);
        }
        const items = pageItems<{ track?: SpotifyTrackObject | null }>(response);
        if (items.length === 0) {
          break;
        }
        for (const entry of items) {
          // Null = removed track; non-track types (episodes) normalize
          // to null. Both are skipped, never substituted.
          const normalized = normalizeTrack(entry.track ?? null);
          if (normalized) {
            // Spotify playlists may legitimately repeat a track:
            // duplicates are content, not a pagination bug.
            ordered.push(normalized.track);
          }
        }
        if (ordered.length >= needed) {
          break;
        }
        if (total !== undefined && (page + 1) * COLLECTION_PAGE_SIZE >= total) {
          break;
        }
      }
      // A 403 from app-only authorization propagates as a typed permission
      // failure from the transport — never an empty playlist.
      const windowed = ordered.slice(offset, offset + limit);

      const artwork = normalizeImages(resource.images);
      const playlist: SpotifyPlaylist = {
        id,
        provider: SPOTIFY_PROVIDER_ID,
        providerPlaylistId: id,
        title,
        tracks: windowed,
      };
      if (typeof resource.description === "string" && resource.description.length > 0) {
        playlist.description = resource.description;
      }
      if (artwork.best) {
        playlist.artworkUrl = artwork.best;
      }
      const ownerId =
        resource.owner && typeof resource.owner.id === "string"
          ? resource.owner.id
          : undefined;
      if (ownerId) {
        playlist.ownerId = ownerId;
      }
      if (total !== undefined) {
        playlist.total = total;
      }
      return playlist;
    },
  };
}
