/**
 * Deezer -> Aurora normalization. Converts validated public-API payloads
 * into Aurora domain types. Nothing Deezer-shaped leaves this module:
 * callers receive `Track` / `Artist` / `Album` only.
 *
 * Identity: `provider = "deezer"`, `providerTrackId` = Deezer numeric id as
 * a string. Durations come from Deezer in whole seconds and are never
 * estimated. Preview URLs (`previewUrl`) are 30-second previews preserved
 * as metadata — never full-track playback (`stream` stays unsupported).
 */

import type { Album, Artist, Track } from "@/lib/domain";
import type {
  DeezerAlbumObject,
  DeezerArtistObject,
  DeezerTrackObject,
} from "./types";

export const DEEZER_PROVIDER_ID = "deezer";

const DEEZER_ID_PATTERN = /^[1-9][0-9]*$/;

/** True for stable Deezer numeric ids (checked before remote calls). */
export function isDeezerId(value: string): boolean {
  return DEEZER_ID_PATTERN.test(value);
}

/** Normalizes a Deezer numeric id (number or numeric string) to a string. */
export function normalizeDeezerId(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      return null;
    }
    return String(value);
  }
  if (typeof value === "string" && isDeezerId(value.trim())) {
    return value.trim();
  }
  return null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface NormalizedArtwork {
  small?: string;
  medium?: string;
  large?: string;
  best?: string;
}

/** Maps Deezer picture/cover triples onto semantic sizes. */
export function normalizePictures(pictures: {
  small?: unknown;
  medium?: unknown;
  big?: unknown;
}): NormalizedArtwork {
  const small = asNonEmptyString(pictures.small);
  const medium = asNonEmptyString(pictures.medium);
  const large = asNonEmptyString(pictures.big);
  const result: NormalizedArtwork = {};
  if (small) result.small = small;
  if (medium) result.medium = medium;
  if (large) result.large = large;
  const best = large ?? medium ?? small;
  if (best) result.best = best;
  return result;
}

function artistPictures(artist: DeezerArtistObject | null | undefined): NormalizedArtwork {
  if (!artist || typeof artist !== "object") {
    return {};
  }
  return normalizePictures({
    small: artist.picture_small,
    medium: artist.picture_medium,
    big: artist.picture_big,
  });
}

function albumCovers(album: DeezerAlbumObject | null | undefined): NormalizedArtwork {
  if (!album || typeof album !== "object") {
    return {};
  }
  return normalizePictures({
    small: album.cover_small,
    medium: album.cover_medium,
    big: album.cover_big,
  });
}

export function deezerTrackUrl(trackId: string): string {
  return `https://www.deezer.com/track/${trackId}`;
}

export function deezerArtistUrl(artistId: string): string {
  return `https://www.deezer.com/artist/${artistId}`;
}

export function deezerAlbumUrl(albumId: string): string {
  return `https://www.deezer.com/album/${albumId}`;
}

/**
 * Unreadable entries (region-locked/removed playlist items) carry no
 * playable metadata. Skipped during collection hydration, never surfaced
 * as tracks.
 */
export function isReadableTrack(track: DeezerTrackObject | null | undefined): boolean {
  if (!track || typeof track !== "object") {
    return false;
  }
  return track.readable !== false;
}

export interface NormalizedTrack {
  trackId: string;
  track: Track;
}

/** Normalizes one Deezer track object. Null when identity/title is missing. */
export function normalizeTrack(
  track: DeezerTrackObject | null | undefined,
): NormalizedTrack | null {
  if (!track || typeof track !== "object") {
    return null;
  }
  const trackId = normalizeDeezerId(track.id);
  if (!trackId) {
    return null;
  }
  const title = asNonEmptyString(track.title);
  if (!title) {
    return null;
  }

  const artist = track.artist;
  const artistId = artist && typeof artist === "object" ? normalizeDeezerId(artist.id) : null;
  const artistName = (artist && typeof artist === "object" ? asNonEmptyString(artist.name) : undefined) ?? "Unknown artist";

  const album = track.album;
  const albumObj = album && typeof album === "object" ? album : null;
  const albumId = albumObj ? normalizeDeezerId(albumObj.id) : null;
  const albumName = albumObj ? asNonEmptyString(albumObj.title) : undefined;

  const artwork = albumCovers(albumObj);
  const duration = asNonNegativeInt(track.duration);
  const explicit = asBoolean(track.explicit_lyrics);
  const previewUrl = asNonEmptyString(track.preview);
  const providerUrl = asNonEmptyString(track.link) ?? deezerTrackUrl(trackId);

  const normalized: Track = {
    id: trackId,
    provider: DEEZER_PROVIDER_ID,
    providerTrackId: trackId,
    title,
    artistId: artistId ?? trackId,
    artistName,
    providerUrl,
    metadata: {
      artistId,
      albumId,
    },
  };
  if (albumId) {
    normalized.albumId = albumId;
  }
  if (albumName) {
    normalized.albumName = albumName;
  }
  if (artwork.best) {
    normalized.artworkUrl = artwork.best;
  }
  if (duration !== undefined) {
    normalized.duration = duration;
  }
  if (explicit !== undefined) {
    normalized.explicit = explicit;
  }
  if (previewUrl) {
    normalized.previewUrl = previewUrl;
  }
  return { trackId, track: normalized };
}

/** Normalizes one Deezer artist object. Null when identity/name is missing. */
export function normalizeArtist(artist: DeezerArtistObject): Artist | null {
  if (!artist || typeof artist !== "object") {
    return null;
  }
  const artistId = normalizeDeezerId(artist.id);
  if (!artistId) {
    return null;
  }
  const name = asNonEmptyString(artist.name);
  if (!name) {
    return null;
  }
  const artwork = artistPictures(artist);
  const normalized: Artist = {
    id: artistId,
    provider: DEEZER_PROVIDER_ID,
    providerArtistId: artistId,
    name,
  };
  if (artwork.best) {
    normalized.image = artwork.best;
  }
  return normalized;
}

/** Normalizes one Deezer album object. Null when identity/title is missing. */
export function normalizeAlbum(album: DeezerAlbumObject): Album | null {
  if (!album || typeof album !== "object") {
    return null;
  }
  const albumId = normalizeDeezerId(album.id);
  if (!albumId) {
    return null;
  }
  const title = asNonEmptyString(album.title);
  if (!title) {
    return null;
  }
  const artist = album.artist;
  const artistId = artist && typeof artist === "object" ? normalizeDeezerId(artist.id) : null;
  const artistName = (artist && typeof artist === "object" ? asNonEmptyString(artist.name) : undefined) ?? "Unknown artist";

  const artwork = albumCovers(album);
  const releaseDate = asNonEmptyString(album.release_date);

  const normalized: Album = {
    id: albumId,
    provider: DEEZER_PROVIDER_ID,
    providerAlbumId: albumId,
    title,
    artistId: artistId ?? albumId,
    artistName,
  };
  if (artwork.best) {
    normalized.artwork = artwork.best;
  }
  if (releaseDate) {
    normalized.releaseDate = releaseDate;
  }
  return normalized;
}
