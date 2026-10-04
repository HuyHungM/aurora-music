/**
 * YouTube Data API v3 transport types + provider-level contracts.
 *
 * SERVER-ONLY. This module carries the API key at runtime (via the client)
 * and must never be imported by browser components. Only normalized Aurora
 * domain types (`Track`, `Artist`, `YouTubePlaylist`) leave this boundary.
 *
 * External payloads are untrusted: every field the normalizer consumes is
 * validated at runtime before use.
 */

/** Minimal subset of a Data API v3 `thumbnail` object we consume. */
export interface YouTubeThumbnail {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface YouTubeThumbnails {
  default?: YouTubeThumbnail | null;
  medium?: YouTubeThumbnail | null;
  high?: YouTubeThumbnail | null;
}

/** Minimal `search.list` item shape (videos + channels). */
export interface YouTubeSearchItem {
  id?: {
    kind?: unknown;
    videoId?: unknown;
    channelId?: unknown;
    playlistId?: unknown;
  } | null;
  snippet?: {
    title?: unknown;
    channelId?: unknown;
    channelTitle?: unknown;
    liveBroadcastContent?: unknown;
    thumbnails?: YouTubeThumbnails | null;
  } | null;
}

export interface YouTubeSearchResponse {
  items?: unknown;
  pageInfo?: {
    totalResults?: unknown;
    resultsPerPage?: unknown;
  } | null;
  nextPageToken?: unknown;
  prevPageToken?: unknown;
}

/** Minimal `videos.list` item shape. */
export interface YouTubeVideo {
  id?: unknown;
  snippet?: {
    title?: unknown;
    channelId?: unknown;
    channelTitle?: unknown;
    liveBroadcastContent?: unknown;
    categoryId?: unknown;
    thumbnails?: YouTubeThumbnails | null;
  } | null;
  contentDetails?: {
    duration?: unknown;
  } | null;
  status?: {
    privacyStatus?: unknown;
    uploadStatus?: unknown;
  } | null;
}

export interface YouTubeVideoListResponse {
  items?: unknown;
  pageInfo?: {
    totalResults?: unknown;
  } | null;
}

/** Minimal `channels.list` item shape. */
export interface YouTubeChannel {
  id?: unknown;
  snippet?: {
    title?: unknown;
    description?: unknown;
    thumbnails?: YouTubeThumbnails | null;
  } | null;
}

export interface YouTubeChannelListResponse {
  items?: unknown;
}

/** Minimal `playlists.list` item shape. */
export interface YouTubePlaylistResource {
  id?: unknown;
  snippet?: {
    title?: unknown;
    description?: unknown;
    channelId?: unknown;
    channelTitle?: unknown;
    thumbnails?: YouTubeThumbnails | null;
  } | null;
  contentDetails?: {
    itemCount?: unknown;
  } | null;
}

/** Minimal `playlistItems.list` item shape. */
export interface YouTubePlaylistItem {
  id?: unknown;
  snippet?: {
    title?: unknown;
    channelId?: unknown;
    channelTitle?: unknown;
    playlistId?: unknown;
    position?: unknown;
    thumbnails?: YouTubeThumbnails | null;
    resourceId?: {
      kind?: unknown;
      videoId?: unknown;
    } | null;
  } | null;
  contentDetails?: {
    videoId?: unknown;
  } | null;
  status?: {
    privacyStatus?: unknown;
  } | null;
}

export interface YouTubePlaylistItemsResponse {
  items?: unknown;
  pageInfo?: {
    totalResults?: unknown;
  } | null;
  nextPageToken?: unknown;
}

/**
 * Normalized YouTube playlist. Lives OUTSIDE the frozen `MusicProvider`
 * interface (which has no provider-playlist concept) as an extra method on
 * the concrete YouTube provider. Ordering mirrors the API; unavailable or
 * private items are skipped, never reordered or substituted.
 */
export interface YouTubePlaylist {
  id: string;
  provider: "youtube";
  providerPlaylistId: string;
  title: string;
  description?: string;
  channelId?: string;
  channelTitle?: string;
  artworkUrl?: string;
  tracks: import("@/lib/domain").Track[];
  total?: number;
}

/**
 * Paging options for a search call.
 *
 * `regionCode` is YouTube's own `regionCode` search parameter. It biases which
 * results YouTube considers locally relevant — it does NOT restrict the
 * catalogue, so a `VN` listener still gets international results when that is
 * what YouTube ranks highest. That is why it is a bias and not a filter, and
 * why it needs no fallback when a market is unknown.
 */
export interface YouTubeSearchOptions {
  limit?: number;
  pageToken?: string;
  regionCode?: string;
}

/** Transport injected into the provider (real fetch client or test double). */
export interface YouTubeApiTransport {
  searchVideos(
    query: string,
    options?: YouTubeSearchOptions,
  ): Promise<YouTubeSearchResponse>;
  searchChannels(
    query: string,
    options?: YouTubeSearchOptions,
  ): Promise<YouTubeSearchResponse>;
  getVideos(videoIds: string[]): Promise<YouTubeVideoListResponse>;
  searchChannelVideos(
    channelId: string,
    options?: YouTubeSearchOptions,
  ): Promise<YouTubeSearchResponse>;
  getChannels(channelIds: string[]): Promise<YouTubeChannelListResponse>;
  getPlaylist(playlistId: string): Promise<YouTubePlaylistResource | null>;
  getPlaylistItems(
    playlistId: string,
    options?: { limit?: number; pageToken?: string },
  ): Promise<YouTubePlaylistItemsResponse>;
}
