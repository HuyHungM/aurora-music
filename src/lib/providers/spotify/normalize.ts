/**
 * Spotify -> Aurora normalization. Converts validated Web API payloads
 * into Aurora domain types. Nothing Spotify-shaped leaves this module:
 * callers receive `Track` / `Artist` / `Album` only.
 *
 * Identity: `provider = "spotify"`, `providerTrackId` = Spotify base62 id.
 * Durations come from Spotify (`duration_ms`) in whole seconds and are
 * never estimated. ISRC (`external_ids.isrc`) is preserved when present
 * for future cross-source matching — matching itself is out of scope.
 *
 * Known model limits (documented, not worked around):
 * - `Artist`/`Album` have no URL/metadata slots, so canonical Spotify
 *   links and `album_type` cannot be stored on them; `Track.providerUrl`
 *   carries the canonical track link for attribution.
 * - `Track` models a single primary artist; additional artists on
 *   multi-artist tracks are dropped (the raw DTO is never exposed).
 */

import type { Album, Artist, Track } from "@/lib/domain";
import type {
  SpotifyAlbumObject,
  SpotifyAlbumRef,
  SpotifyArtistObject,
  SpotifyArtistRef,
  SpotifyImage,
  SpotifyTrackObject,
} from "./types";

export const SPOTIFY_PROVIDER_ID = "spotify";

const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]+$/;
const MAX_SPOTIFY_ID_LENGTH = 64;

/** Plausible Spotify base62 id (checked before remote calls). */
export function isSpotifyId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_SPOTIFY_ID_LENGTH &&
    SPOTIFY_ID_PATTERN.test(trimmed)
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asSpotifyUrl(value: { external_urls?: { spotify?: unknown } | null } | null | undefined): string | undefined {
  return asNonEmptyString(value?.external_urls?.spotify);
}

function asIsrc(value: { external_ids?: Record<string, unknown> | null } | null | undefined): string | undefined {
  const isrc = value?.external_ids?.isrc;
  return asNonEmptyString(isrc);
}

export interface NormalizedArtwork {
  small?: string;
  medium?: string;
  large?: string;
  best?: string;
}

/**
 * Maps Spotify image lists onto semantic sizes, source-faithfully: sorted
 * by width ascending (widthless entries keep API order at the end), then
 * small = smallest, large = largest, medium = middle. No crops generated.
 */
export function normalizeImages(images: unknown): NormalizedArtwork {
  if (!Array.isArray(images)) {
    return {};
  }
  const entries: Array<{ url: string; width: number; index: number }> = [];
  images.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const { url, width } = entry as SpotifyImage;
    const clean = asNonEmptyString(url);
    if (!clean) {
      return;
    }
    entries.push({
      url: clean,
      width: typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 0,
      index,
    });
  });
  const withWidth = entries.filter((entry) => entry.width > 0).sort((a, b) => a.width - b.width);
  const withoutWidth = entries
    .filter((entry) => entry.width === 0)
    .sort((a, b) => a.index - b.index);
  const sorted = [...withWidth, ...withoutWidth];
  if (sorted.length === 0) {
    return {};
  }
  const result: NormalizedArtwork = {};
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first) {
    result.small = first.url;
  }
  if (last && last !== first) {
    result.large = last.url;
  }
  if (sorted.length >= 3) {
    const middle = sorted[Math.floor(sorted.length / 2)];
    if (middle && middle !== first && middle !== last) {
      result.medium = middle.url;
    }
  }
  const best = result.large ?? result.medium ?? result.small;
  if (best) {
    result.best = best;
  }
  return result;
}

function primaryArtistRef(
  artists: unknown,
): { artistId: string; artistName: string } | null {
  if (!Array.isArray(artists)) {
    return null;
  }
  for (const entry of artists) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const ref = entry as SpotifyArtistRef;
    const artistId = asNonEmptyString(ref.id);
    const artistName = asNonEmptyString(ref.name);
    if (artistId && artistName) {
      return { artistId, artistName };
    }
  }
  return null;
}

export interface NormalizedTrack {
  trackId: string;
  track: Track;
}

/** Normalizes one Spotify track object. Null when identity/title is missing. */
export function normalizeTrack(track: SpotifyTrackObject | null | undefined): NormalizedTrack | null {
  if (!track || typeof track !== "object") {
    return null;
  }
  const trackId = asNonEmptyString(track.id);
  if (!trackId || !isSpotifyId(trackId)) {
    return null;
  }
  if (track.type !== undefined && track.type !== "track") {
    // Playlist entries can hold episodes; Aurora models tracks only.
    return null;
  }
  const title = asNonEmptyString(track.name);
  if (!title) {
    return null;
  }
  const primary = primaryArtistRef(track.artists);

  const album = track.album;
  const albumRef: SpotifyAlbumRef | null =
    album && typeof album === "object" ? album : null;
  const albumId = albumRef ? asNonEmptyString(albumRef.id) : undefined;
  const albumName = albumRef ? asNonEmptyString(albumRef.name) : undefined;
  const albumArtwork = albumRef ? normalizeImages(albumRef.images) : {};

  const durationMs = track.duration_ms;
  const duration =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.floor(durationMs / 1000)
      : undefined;

  const normalized: Track = {
    id: trackId,
    provider: SPOTIFY_PROVIDER_ID,
    providerTrackId: trackId,
    title,
    artistId: primary?.artistId ?? trackId,
    artistName: primary?.artistName ?? "Unknown artist",
    providerUrl: asSpotifyUrl(track) ?? `https://open.spotify.com/track/${trackId}`,
    metadata: {
      artistId: primary?.artistId ?? null,
      albumId: albumId ?? null,
    },
  };
  if (albumId) {
    normalized.albumId = albumId;
  }
  if (albumName) {
    normalized.albumName = albumName;
  }
  if (albumArtwork.best) {
    normalized.artworkUrl = albumArtwork.best;
  }
  if (duration !== undefined) {
    normalized.duration = duration;
  }
  if (typeof track.explicit === "boolean") {
    normalized.explicit = track.explicit;
  }
  const previewUrl = asNonEmptyString(track.preview_url);
  if (previewUrl) {
    // Preview-only audio metadata; never full-track playback.
    normalized.previewUrl = previewUrl;
  }
  const isrc = asIsrc(track) ?? (albumRef ? asIsrc(albumRef as { external_ids?: Record<string, unknown> | null }) : undefined);
  if (isrc && normalized.metadata) {
    (normalized.metadata as Record<string, unknown>).isrc = isrc;
  }
  if (typeof track.disc_number === "number" && Number.isFinite(track.disc_number)) {
    (normalized.metadata as Record<string, unknown>).discNumber = Math.floor(track.disc_number);
  }
  if (typeof track.track_number === "number" && Number.isFinite(track.track_number)) {
    (normalized.metadata as Record<string, unknown>).trackNumber = Math.floor(track.track_number);
  }
  return { trackId, track: normalized };
}

/** Normalizes one Spotify artist object. Null when identity/name is missing. */
export function normalizeArtist(artist: SpotifyArtistObject | null | undefined): Artist | null {
  if (!artist || typeof artist !== "object") {
    return null;
  }
  const artistId = asNonEmptyString(artist.id);
  if (!artistId || !isSpotifyId(artistId)) {
    return null;
  }
  const name = asNonEmptyString(artist.name);
  if (!name) {
    return null;
  }
  const artwork = normalizeImages(artist.images);
  const normalized: Artist = {
    id: artistId,
    provider: SPOTIFY_PROVIDER_ID,
    providerArtistId: artistId,
    name,
  };
  if (artwork.best) {
    normalized.image = artwork.best;
  }
  return normalized;
}

/** Normalizes one Spotify album object. Null when identity/title is missing. */
export function normalizeAlbum(album: SpotifyAlbumObject | null | undefined): Album | null {
  if (!album || typeof album !== "object") {
    return null;
  }
  const albumId = asNonEmptyString(album.id);
  if (!albumId || !isSpotifyId(albumId)) {
    return null;
  }
  const title = asNonEmptyString(album.name);
  if (!title) {
    return null;
  }
  const primary = primaryArtistRef(album.artists);
  const artwork = normalizeImages(album.images);
  const releaseDate = asNonEmptyString(album.release_date);

  const normalized: Album = {
    id: albumId,
    provider: SPOTIFY_PROVIDER_ID,
    providerAlbumId: albumId,
    title,
    artistId: primary?.artistId ?? albumId,
    artistName: primary?.artistName ?? "Unknown artist",
  };
  if (artwork.best) {
    normalized.artwork = artwork.best;
  }
  if (releaseDate) {
    normalized.releaseDate = releaseDate;
  }
  return normalized;
}
