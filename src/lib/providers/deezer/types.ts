/**
 * Deezer public API transport types + provider-level contracts.
 *
 * SERVER-ONLY. Only normalized Aurora domain types (`Track`, `Artist`,
 * `Album`, `DeezerPlaylist`) leave this boundary — raw Deezer payloads
 * never cross it.
 *
 * The catalog endpoints used here require no credentials, so no env
 * configuration exists for Deezer. If authenticated endpoints are ever
 * needed, credentials belong in the existing server-only env system.
 *
 * External payloads are untrusted: every field the normalizer consumes is
 * validated at runtime before use.
 */

/** Deezer API error envelope (often returned with HTTP 200). */
export interface DeezerApiError {
  type?: unknown;
  message?: unknown;
  code?: unknown;
}

export interface DeezerErrorResponse {
  error?: DeezerApiError | null;
}

/** Deezer paged collection envelope (`search`, `.../tracks`, chart). */
export interface DeezerPagedResponse {
  data?: unknown;
  total?: unknown;
  next?: unknown;
  prev?: unknown;
}

/** Minimal Deezer artist object (embedded or full). */
export interface DeezerArtistObject {
  id?: unknown;
  name?: unknown;
  link?: unknown;
  picture_small?: unknown;
  picture_medium?: unknown;
  picture_big?: unknown;
  picture_xl?: unknown;
}

/** Minimal Deezer album object (embedded or full). */
export interface DeezerAlbumObject {
  id?: unknown;
  title?: unknown;
  link?: unknown;
  cover_small?: unknown;
  cover_medium?: unknown;
  cover_big?: unknown;
  cover_xl?: unknown;
  release_date?: unknown;
  artist?: DeezerArtistObject | null;
}

/** Minimal Deezer track object. */
export interface DeezerTrackObject {
  id?: unknown;
  title?: unknown;
  link?: unknown;
  duration?: unknown;
  explicit_lyrics?: unknown;
  preview?: unknown;
  readable?: unknown;
  artist?: DeezerArtistObject | null;
  album?: DeezerAlbumObject | null;
}

/** Minimal Deezer playlist object. */
export interface DeezerPlaylistObject {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  link?: unknown;
  picture_small?: unknown;
  picture_medium?: unknown;
  picture_big?: unknown;
  picture_xl?: unknown;
  nb_tracks?: unknown;
}

/**
 * Normalized Deezer playlist. Lives OUTSIDE the frozen `MusicProvider`
 * interface (which has no provider-playlist concept) as an extra method on
 * the concrete Deezer provider — the same boundary pattern Phase 03
 * established for YouTube. Ordering mirrors the API; unreadable entries
 * are skipped, never reordered or substituted.
 */
export interface DeezerPlaylist {
  id: string;
  provider: "deezer";
  providerPlaylistId: string;
  title: string;
  description?: string;
  artworkUrl?: string;
  tracks: import("@/lib/domain").Track[];
  total?: number;
}

/** Pagination for Deezer's index/limit paging model. */
export interface DeezerPaging {
  limit?: number;
  index?: number;
}

/** Transport injected into the provider (real fetch client or test double). */
export interface DeezerApiTransport {
  searchTracks(query: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  searchArtists(query: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  searchAlbums(query: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  getTrack(trackId: string): Promise<DeezerTrackObject>;
  getArtist(artistId: string): Promise<DeezerArtistObject>;
  getArtistTopTracks(artistId: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  getAlbum(albumId: string): Promise<DeezerAlbumObject>;
  getAlbumTracks(albumId: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  getPlaylist(playlistId: string): Promise<DeezerPlaylistObject>;
  getPlaylistTracks(playlistId: string, paging?: DeezerPaging): Promise<DeezerPagedResponse>;
  getChartTracks(paging?: DeezerPaging): Promise<DeezerPagedResponse>;
}
