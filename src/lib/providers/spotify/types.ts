/**
 * Spotify Web API transport types + provider-level contracts.
 *
 * SERVER-ONLY. Only normalized Aurora domain types (`Track`, `Artist`,
 * `Album`, `SpotifyPlaylist`) leave this boundary — raw Spotify payloads
 * (and access tokens) never cross it.
 *
 * Shapes follow the CURRENT Web API (post-February-2026 migration):
 * - No batch `GET /tracks?ids=`, `GET /albums?ids=`, `GET /artists?ids=`.
 * - No `/artists/{id}/top-tracks`.
 * - Playlist items live at `/playlists/{id}/items` with an `items` array
 *   (the old `/tracks` path and `tracks.tracks` shape are gone).
 * - `popularity`, `followers`, `available_markets`, `label` are treated as
 *   optional throughout: they may be absent and must never crash parsing.
 * - `external_ids` (ISRC) is optional but preserved when present.
 *
 * External payloads are untrusted: every consumed field is validated at
 * runtime before use.
 */

export interface SpotifyImage {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface SpotifyExternalUrls {
  spotify?: unknown;
}

export interface SpotifyArtistRef {
  id?: unknown;
  name?: unknown;
  external_urls?: SpotifyExternalUrls | null;
}

export interface SpotifyArtistObject {
  id?: unknown;
  name?: unknown;
  images?: unknown;
  external_urls?: SpotifyExternalUrls | null;
}

export interface SpotifyAlbumRef {
  id?: unknown;
  name?: unknown;
  images?: unknown;
  release_date?: unknown;
  release_date_precision?: unknown;
  artists?: unknown;
  external_urls?: SpotifyExternalUrls | null;
}

export interface SpotifyAlbumObject extends SpotifyAlbumRef {
  album_type?: unknown;
  total_tracks?: unknown;
  external_ids?: Record<string, unknown> | null;
}

export interface SpotifyTrackObject {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  duration_ms?: unknown;
  explicit?: unknown;
  preview_url?: unknown;
  isrc?: unknown;
  external_ids?: Record<string, unknown> | null;
  external_urls?: SpotifyExternalUrls | null;
  artists?: unknown;
  album?: SpotifyAlbumRef | null;
  disc_number?: unknown;
  track_number?: unknown;
}

export interface SpotifyPage {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
  next?: unknown;
}

export interface SpotifySearchResponse {
  tracks?: SpotifyPage | null;
  artists?: SpotifyPage | null;
  albums?: SpotifyPage | null;
}

export interface SpotifyPlaylistObject {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  images?: unknown;
  owner?: { id?: unknown; display_name?: unknown } | null;
  tracks?: { total?: unknown } | null;
  external_urls?: SpotifyExternalUrls | null;
}

export interface SpotifyPlaylistItem {
  track?: SpotifyTrackObject | null;
}

export interface SpotifyPlaylistItemsResponse {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
  next?: unknown;
}

/**
 * Normalized Spotify playlist. Lives OUTSIDE the frozen `MusicProvider`
 * interface (which has no provider-playlist concept) as an extra method on
 * the concrete Spotify provider — the boundary pattern Phases 03/04
 * established. With app-only authorization, item retrieval can return 403
 * for playlists outside the token owner's scope; that surfaces as a typed
 * permission failure, never as an empty playlist.
 */
export interface SpotifyPlaylist {
  id: string;
  provider: "spotify";
  providerPlaylistId: string;
  title: string;
  description?: string;
  artworkUrl?: string;
  ownerId?: string;
  tracks: import("@/lib/domain").Track[];
  total?: number;
}

/** Pagination for Spotify's offset/limit paging model. */
export interface SpotifyPaging {
  limit?: number;
  offset?: number;
}

/** Minimal token source injected into the transport (real or test double). */
export interface SpotifyTokenSource {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

/** Transport injected into the provider (real fetch client or test double). */
export interface SpotifyApiTransport {
  search(
    query: string,
    types: Array<"track" | "artist" | "album">,
    paging?: SpotifyPaging,
  ): Promise<SpotifySearchResponse>;
  getTrack(trackId: string): Promise<SpotifyTrackObject>;
  getArtist(artistId: string): Promise<SpotifyArtistObject>;
  getArtistAlbums(artistId: string, paging?: SpotifyPaging): Promise<SpotifyPage>;
  getAlbum(albumId: string): Promise<SpotifyAlbumObject>;
  getAlbumTracks(albumId: string, paging?: SpotifyPaging): Promise<SpotifyPage>;
  getPlaylist(playlistId: string): Promise<SpotifyPlaylistObject>;
  getPlaylistItems(
    playlistId: string,
    paging?: SpotifyPaging,
  ): Promise<SpotifyPlaylistItemsResponse>;
}
