/**
 * Concrete YouTube `MusicProvider` over the server-only Data API transport.
 *
 * Supported capabilities (and only these):
 * search.tracks, tracks.get, search.artists, artists.get, artists.tracks.
 * `stream` is advertised ONLY when a playback client is injected (Phase 08);
 * otherwise `getStreamUrl` throws like every other unsupported method.
 * The canonical playback path remains `PlaybackResolver -> YouTubeResolver
 * -> AudioSource`; `getStreamUrl` is a bare-URL adapter over the same
 * resolution for interface compatibility.
 *
 * `getPlaylist` is an EXTRA method outside the frozen interface (which has
 * no provider-playlist concept). Collection playback arrives later; this
 * exposes normalized playlist metadata + ordered track references now.
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
import type { YouTubeApiTransport, YouTubePlaylist } from "./types";
import type { YouTubePlaybackClient } from "./playback/types";
import { createYouTubeResolver } from "./playback/youtube-resolver";
import {
  YOUTUBE_PROVIDER_ID,
  channelIdFromSearchItem,
  isYouTubeVideoId,
  normalizeChannel,
  normalizeSearchItem,
  normalizeThumbnails,
  normalizeVideo,
  videoIdFromPlaylistItem,
} from "./normalize";

const PROVIDER_NAME = "YouTube";

/**
 * `playlistItems.list` returns at most 50 per call, and `videos.list` accepts
 * at most 50 ids. One constant for both, so the two batch sizes cannot drift
 * apart — they are the same upstream limit.
 */
const PAGE_SIZE = 50;

const BASE_CAPABILITIES: readonly ProviderCapability[] = [
  "search.tracks",
  "tracks.get",
  "search.artists",
  "artists.get",
  "artists.tracks",
];

export interface YouTubeProviderOptions {
  /**
   * Optional playback client. When present, the `stream` capability is
   * advertised and `getStreamUrl` resolves through it; the canonical
   * resolver path (`PlaybackResolver`) stays independent of this adapter.
   */
  playback?: YouTubePlaybackClient;
}

export type YouTubeProvider = MusicProvider & {
  getPlaylist(
    playlistId: string,
    pagination?: ProviderPagination,
  ): Promise<YouTubePlaylist>;
};

function requireQuery(query: ProviderSearchQuery, operation: string): string {
  const trimmed = query.query.trim();
  if (trimmed.length === 0) {
    throw new NormalizationError("query", `${operation} requires a non-empty query`);
  }
  return trimmed;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function createYouTubeProvider(
  transport: YouTubeApiTransport,
  options: YouTubeProviderOptions = {},
): YouTubeProvider {
  const playback = options.playback ?? null;
  const capabilities: ReadonlySet<ProviderCapability> = new Set(
    playback ? [...BASE_CAPABILITIES, "stream"] : BASE_CAPABILITIES,
  );
  const streamResolver = playback ? createYouTubeResolver(playback) : null;
  return {
    id: YOUTUBE_PROVIDER_ID,
    name: PROVIDER_NAME,
    capabilities,

    async searchTracks(query: ProviderSearchQuery): Promise<ProviderListResult<Track>> {
      const text = requireQuery(query, "searchTracks");
      const response = await transport.searchVideos(text, { limit: query.limit });
      const items = Array.isArray(response.items) ? response.items : [];
      const tracks: Track[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const normalized = normalizeSearchItem(
          item as Parameters<typeof normalizeSearchItem>[0],
        );
        if (normalized) {
          tracks.push(normalized.track);
        }
      }
      return {
        items: tracks,
        total: asNumber(response.pageInfo?.totalResults),
      };
    },

    async searchArtists(query: ProviderSearchQuery): Promise<ProviderListResult<Artist>> {
      const text = requireQuery(query, "searchArtists");
      const response = await transport.searchChannels(text, { limit: query.limit });
      const items = Array.isArray(response.items) ? response.items : [];
      const channelIds: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const channelId = channelIdFromSearchItem(
          item as Parameters<typeof channelIdFromSearchItem>[0],
        );
        if (channelId && !channelIds.includes(channelId)) {
          channelIds.push(channelId);
        }
      }
      if (channelIds.length === 0) {
        return { items: [], total: asNumber(response.pageInfo?.totalResults) };
      }
      const channels = await transport.getChannels(channelIds);
      const channelItems = Array.isArray(channels.items) ? channels.items : [];
      const artists: Artist[] = [];
      for (const channel of channelItems) {
        if (!channel || typeof channel !== "object") {
          continue;
        }
        const normalized = normalizeChannel(
          channel as Parameters<typeof normalizeChannel>[0],
        );
        if (normalized) {
          artists.push(normalized);
        }
      }
      return { items: artists };
    },

    searchAlbums(): Promise<ProviderListResult<Album>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "search.albums",
          "Album search is not supported by the YouTube provider",
        ),
      );
    },

    async getTrack(trackId: string): Promise<Track> {
      if (!isYouTubeVideoId(trackId)) {
        throw new NormalizationError(
          "providerTrackId",
          `Invalid YouTube video id: "${trackId}"`,
        );
      }
      const response = await transport.getVideos([trackId]);
      const items = Array.isArray(response.items) ? response.items : [];
      const first = items[0];
      if (!first || typeof first !== "object") {
        throw new TrackNotFoundError({
          provider: YOUTUBE_PROVIDER_ID,
          providerTrackId: trackId,
        });
      }
      const normalized = normalizeVideo(
        first as Parameters<typeof normalizeVideo>[0],
      );
      if (!normalized || normalized.videoId !== trackId) {
        // Exact lookup only: never substitute another video.
        throw new TrackNotFoundError({
          provider: YOUTUBE_PROVIDER_ID,
          providerTrackId: trackId,
        });
      }
      return normalized.track;
    },

    async getArtist(artistId: string): Promise<Artist> {
      if (artistId.trim().length === 0) {
        throw new NormalizationError("artistId", "Artist lookup requires a channel id");
      }
      const response = await transport.getChannels([artistId]);
      const items = Array.isArray(response.items) ? response.items : [];
      const first = items[0];
      if (!first || typeof first !== "object") {
        throw new ExtractorError(YOUTUBE_PROVIDER_ID, "getArtist", "Artist not found");
      }
      const normalized = normalizeChannel(
        first as Parameters<typeof normalizeChannel>[0],
      );
      if (!normalized) {
        throw new ExtractorError(YOUTUBE_PROVIDER_ID, "getArtist", "Artist not found");
      }
      return normalized;
    },

    getAlbum(): Promise<Album> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "albums.get",
          "Album lookup is not supported by the YouTube provider",
        ),
      );
    },

    getAlbumTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "albums.tracks",
          "Album tracks are not supported by the YouTube provider",
        ),
      );
    },

    async getArtistTracks(
      artistId: string,
      pagination?: ProviderPagination,
    ): Promise<ProviderListResult<Track>> {
      if (artistId.trim().length === 0) {
        throw new NormalizationError("artistId", "Artist tracks require a channel id");
      }
      const response = await transport.searchChannelVideos(artistId, {
        limit: pagination?.limit,
      });
      const items = Array.isArray(response.items) ? response.items : [];
      const tracks: Track[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const normalized = normalizeSearchItem(
          item as Parameters<typeof normalizeSearchItem>[0],
        );
        if (normalized) {
          tracks.push(normalized.track);
        }
      }
      return {
        items: tracks,
        total: asNumber(response.pageInfo?.totalResults),
      };
    },

    getPopularTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "tracks.popular",
          "Popular tracks are not supported by the YouTube provider",
        ),
      );
    },

    getFeaturedTracks(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "tracks.featured",
          "Featured tracks are not supported by the YouTube provider",
        ),
      );
    },

    getRecommendations(): Promise<ProviderListResult<Track>> {
      return Promise.reject(
        new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "tracks.recommendations",
          "Recommendations are not supported by the YouTube provider",
        ),
      );
    },

    async getStreamUrl(trackId: string): Promise<string> {
      // Bare-URL adapter over the resolver path for interface
      // compatibility. Without an injected playback client the capability
      // is unadvertised and this throws like any unsupported method.
      if (!streamResolver) {
        throw new UnsupportedProviderCapabilityError(
          YOUTUBE_PROVIDER_ID,
          "stream",
          "Stream resolution requires a playback client",
        );
      }
      const source = await streamResolver.resolveSource({
        source: YOUTUBE_PROVIDER_ID,
        id: trackId,
      });
      return source.url;
    },

    async getPlaylist(
      playlistId: string,
      pagination?: ProviderPagination,
    ): Promise<YouTubePlaylist> {
      const id = playlistId.trim();
      if (id.length === 0) {
        throw new NormalizationError("playlistId", "Playlist lookup requires a playlist id");
      }
      const resource = await transport.getPlaylist(id);
      if (!resource) {
        throw new ExtractorError(YOUTUBE_PROVIDER_ID, "getPlaylist", "Playlist not found");
      }
      const title =
        typeof resource.snippet?.title === "string" && resource.snippet.title.trim().length > 0
          ? resource.snippet.title.trim()
          : "Untitled playlist";

      const limit = pagination?.limit ?? 50;
      const offset = pagination?.offset ?? 0;
      const orderedVideoIds: string[] = [];
      let pageToken: string | undefined;
      let total: number | undefined;
      // Bounded page walk (§23, §28).
      //
      // The window is `offset + limit` items and each page holds 50, so the
      // number of pages actually required is `ceil((offset+limit)/50)`. The
      // previous fixed 10-page cap was correct for the default window but
      // over-fetched for small ones — a 20-item request walked pages until
      // `orderedVideoIds.length >= 20`, which stops after one page, so the
      // cap was harmless there; the real waste was `limit: 50` hardcoded per
      // page regardless of how few items were asked for. The page size is
      // now the smaller of the full page and what is still needed, so a 20-item
      // request never asks YouTube for 50.
      const needed = Math.max(1, Math.ceil((offset + limit) / PAGE_SIZE));
      for (let page = 0; page < needed; page += 1) {
        const remaining = offset + limit - orderedVideoIds.length;
        const response = await transport.getPlaylistItems(id, {
          limit: Math.min(PAGE_SIZE, Math.max(remaining, 1)),
          pageToken,
        });
        if (total === undefined) {
          total = asNumber(response.pageInfo?.totalResults);
        }
        const items = Array.isArray(response.items) ? response.items : [];
        for (const item of items) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const videoId = videoIdFromPlaylistItem(
            item as Parameters<typeof videoIdFromPlaylistItem>[0],
          );
          if (videoId && !orderedVideoIds.includes(videoId)) {
            orderedVideoIds.push(videoId);
          }
        }
        const next =
          typeof response.nextPageToken === "string" && response.nextPageToken.length > 0
            ? response.nextPageToken
            : undefined;
        pageToken = next;
        if (!pageToken || orderedVideoIds.length >= offset + limit) {
          break;
        }
      }

      const windowed = orderedVideoIds.slice(offset, offset + limit);
      const byId = new Map<string, Track>();
      for (let index = 0; index < windowed.length; index += PAGE_SIZE) {
        const batch = windowed.slice(index, index + PAGE_SIZE);
        if (batch.length === 0) {
          break;
        }
        const videos = await transport.getVideos(batch);
        const videoItems = Array.isArray(videos.items) ? videos.items : [];
        for (const video of videoItems) {
          if (!video || typeof video !== "object") {
            continue;
          }
          const normalized = normalizeVideo(
            video as Parameters<typeof normalizeVideo>[0],
          );
          if (normalized) {
            byId.set(normalized.videoId, normalized.track);
          }
        }
      }
      // Preserve playlist ordering; drop ids that no longer resolve.
      const tracks = windowed.flatMap((videoId) => {
        const track = byId.get(videoId);
        return track ? [track] : [];
      });

      const artwork = normalizeThumbnails(resource.snippet?.thumbnails);
      const playlist: YouTubePlaylist = {
        id,
        provider: YOUTUBE_PROVIDER_ID,
        providerPlaylistId: id,
        title,
        tracks,
      };
      if (typeof resource.snippet?.description === "string") {
        playlist.description = resource.snippet.description;
      }
      if (typeof resource.snippet?.channelId === "string") {
        playlist.channelId = resource.snippet.channelId;
      }
      if (typeof resource.snippet?.channelTitle === "string") {
        playlist.channelTitle = resource.snippet.channelTitle;
      }
      if (artwork.best) {
        playlist.artworkUrl = artwork.best;
      }
      if (total !== undefined) {
        playlist.total = total;
      }
      return playlist;
    },
  };
}
