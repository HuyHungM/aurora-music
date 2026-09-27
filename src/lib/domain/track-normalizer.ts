/**
 * Canonical cross-provider normalization: provider `Track` -> `TrackIdentity`.
 *
 * Pure and dependency-free (no fetch, no database, no player). Each provider
 * result becomes ONE independent identity with EXACTLY the source reference
 * its provider supplied — never more. Cross-provider equivalence is NOT
 * computed here; that is the future TrackMatcher. Merging additional
 * sources into an identity happens ONLY through the explicit
 * `mergeSourceReference` call with caller-supplied references.
 *
 * Reconciliation rules (Track vs TrackIdentity):
 * - Duration: provider seconds -> canonical integer milliseconds.
 *   Unknown/invalid stays `undefined`; zero is never fabricated.
 * - Artists: legacy `Track` carries one primary artist. The identity keeps
 *   the full list when callers supply it, otherwise the primary alone.
 * - Album: built only when BOTH provider album id and name are known;
 *   a bare album id is preserved in source metadata instead of inventing
 *   a title. Missing album stays `undefined`.
 * - Artwork: a single provider URL maps to the `medium` slot (the default
 *   preference of `resolveArtworkUrl`); unknown sizes are never guessed.
 * - Legacy `Track` fields (`streamUrl`, `previewUrl`, provider blobs) are
 *   NEVER copied into identity or source references.
 */

import type { Album } from "./album";
import type { Artist } from "./artist";
import type { Artwork } from "./artwork";
import type { SearchResult } from "./search-result";
import type { SourceReference, SourceReferenceMetadata } from "./source-reference";
import { isSourceType, sourceReferenceKey } from "./source-reference";
import type { SourceType } from "./common";
import type { Track } from "./track";
import type { TrackIdentity } from "./track-identity";
import { NormalizationError } from "./errors";

export interface ToIdentityOptions {
  /** Override the generated Aurora internal id (refresh flows, tests). */
  id?: string;
  /** Complete artist list; defaults to the track's primary artist alone. */
  artists?: Artist[];
}

export interface CanonicalSearchInput {
  items: Track[];
  total?: number;
  nextOffset?: number | null;
}

/**
 * Generates an Aurora internal identity (existing cuid-style strategy).
 *
 * `crypto.randomUUID()` is a SECURE-CONTEXT-ONLY API: browsers expose it only
 * on `https://` and on loopback. Aurora is routinely opened from another
 * device as `http://<lan-ip>:3000` during development, where
 * `crypto.randomUUID` is `undefined` and a bare call throws `TypeError:
 * crypto.randomUUID is not a function`. That throw is not local - this id is
 * minted on every `toTrackIdentity`, i.e. on every playback, queue, dedupe and
 * snapshot path - and every caller catches it as "track could not canonicalize":
 * playback then reports "This track has no playable stream right now." with no
 * network call, the queue snapshot reads as empty, and the player bar says
 * nothing is playing. In other words, one insecure origin silently disabled the
 * product.
 *
 * So the chain prefers `randomUUID` and otherwise mints the SAME UUIDv4 shape
 * from `crypto.getRandomValues`, which every context - secure or not, browser
 * or server - exposes. The two paths must stay interchangeable because these
 * ids are persisted and compared.
 *
 * The final fallback never throws: a missing primitive here surfaces as a
 * swallowed "unavailable" error in playback, which is the exact failure mode
 * this chain exists to prevent. Collisions matter far less than uptime for an
 * internal track identity (same reasoning as the tab id in
 * `lib/multi-tab/playback-ownership.ts`).
 */
export function generateIdentityId(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === "function") {
    return webcrypto.randomUUID();
  }
  if (webcrypto && typeof webcrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webcrypto.getRandomValues(bytes);
    // RFC 4122 version 4 and variant bits, so the result is indistinguishable
    // from `randomUUID()` to anything that parses the shape.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (const byte of bytes) {
      hex.push(byte.toString(16).padStart(2, "0"));
    }
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }
  let tail = "";
  for (let index = 0; index < 12; index += 1) {
    tail += Math.floor(Math.random() * 16).toString(16);
  }
  return `00000000-0000-4000-8000-${tail}`;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return asNonEmptyString(metadata[key]);
}

/**
 * Builds the source reference a provider track directly supplies.
 * Returns null when the track carries no stable provider identity
 * (unknown provider or missing id) — such tracks cannot canonicalize.
 */
export function trackToSourceReference(track: Track): SourceReference | null {
  if (!isSourceType(track.provider)) {
    return null;
  }
  const id = asNonEmptyString(track.providerTrackId);
  if (!id) {
    return null;
  }
  const reference: SourceReference = { source: track.provider, id };
  const url = asNonEmptyString(track.providerUrl);
  if (url) {
    reference.url = url;
  }
  const metadata: SourceReferenceMetadata = {};
  const isrc = metadataString(track.metadata, "isrc");
  if (isrc) {
    metadata.isrc = isrc;
  }
  const channelId = metadataString(track.metadata, "channelId");
  if (channelId) {
    metadata.channelId = channelId;
  }
  const albumId = metadataString(track.metadata, "albumId") ?? asNonEmptyString(track.albumId);
  if (albumId) {
    metadata.albumId = albumId;
  }
  const artistId = metadataString(track.metadata, "artistId") ?? asNonEmptyString(track.artistId);
  if (artistId) {
    metadata.artistId = artistId;
  }
  if (Object.keys(metadata).length > 0) {
    reference.metadata = metadata;
  }
  return reference;
}

function primaryArtistOf(track: Track): Artist {
  return {
    id: track.artistId,
    provider: track.provider,
    providerArtistId: track.artistId,
    name: track.artistName,
  };
}

function albumOf(track: Track): Album | undefined {
  const albumId = asNonEmptyString(track.albumId);
  const albumName = asNonEmptyString(track.albumName);
  // Both or nothing: a title must never be invented for a bare id.
  if (!albumId || !albumName) {
    return undefined;
  }
  return {
    id: albumId,
    provider: track.provider,
    providerAlbumId: albumId,
    title: albumName,
    artistId: track.artistId,
    artistName: track.artistName,
  };
}

function durationMsOf(track: Track): number | undefined {
  const seconds = track.duration;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

function artworkOf(track: Track): Artwork | undefined {
  const url = asNonEmptyString(track.artworkUrl);
  if (!url) {
    return undefined;
  }
  // Single URL of unknown size -> the default-preference (medium) slot.
  return { medium: url };
}

function metadataOf(track: Track): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (typeof track.explicit === "boolean") {
    metadata.explicit = track.explicit;
  }
  const live = metadataString(track.metadata, "liveBroadcastContent");
  if (live) {
    metadata.liveBroadcastContent = live;
  }
  for (const key of ["discNumber", "trackNumber"] as const) {
    const value = track.metadata?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      metadata[key] = Math.floor(value);
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function artistsOf(track: Track, options: ToIdentityOptions): Artist[] {
  const supplied = options.artists?.filter(
    (artist): artist is Artist =>
      !!artist &&
      asNonEmptyString(artist.id) !== undefined &&
      asNonEmptyString(artist.name) !== undefined,
  );
  if (supplied && supplied.length > 0) {
    return [...supplied];
  }
  return [primaryArtistOf(track)];
}

/**
 * Converts one provider track into its canonical identity. The identity
 * carries EXACTLY ONE source: the reference the provider supplied. Throws
 * `NormalizationError` when the track lacks stable provider identity or a
 * title — such input cannot canonicalize.
 */
export function toTrackIdentity(track: Track, options: ToIdentityOptions = {}): TrackIdentity {
  if (!isSourceType(track.provider)) {
    throw new NormalizationError(
      "provider",
      `Cannot canonicalize track from unknown provider "${track.provider}"`,
    );
  }
  const source = trackToSourceReference(track);
  if (!source) {
    throw new NormalizationError(
      "providerTrackId",
      "Cannot canonicalize a track without a stable provider id",
    );
  }
  if (asNonEmptyString(track.title) === undefined) {
    throw new NormalizationError("title", "Cannot canonicalize a track without a title");
  }
  if (asNonEmptyString(track.artistId) === undefined) {
    throw new NormalizationError("artistId", "Cannot canonicalize a track without an artist id");
  }
  if (asNonEmptyString(track.artistName) === undefined) {
    throw new NormalizationError("artistName", "Cannot canonicalize a track without an artist name");
  }
  const id = options.id !== undefined ? asNonEmptyString(options.id) : generateIdentityId();
  if (!id) {
    throw new NormalizationError("id", "Canonical identity requires a non-empty Aurora id");
  }

  const identity: TrackIdentity = {
    id,
    title: track.title,
    artists: artistsOf(track, options),
    sources: [source],
    primarySource: source,
  };
  const album = albumOf(track);
  if (album) {
    identity.album = album;
  }
  const durationMs = durationMsOf(track);
  if (durationMs !== undefined) {
    identity.durationMs = durationMs;
  }
  const artwork = artworkOf(track);
  if (artwork) {
    identity.artwork = artwork;
  }
  const metadata = metadataOf(track);
  if (metadata) {
    identity.metadata = metadata;
  }
  return identity;
}

/**
 * Explicitly merges a caller-supplied source reference into an identity.
 * Immutable: returns a new identity, leaving the input untouched.
 *
 * - Same `source:id` already present -> that entry is refreshed in place
 *   (and the primary pointer follows when the refreshed entry is primary).
 * - New key -> appended; the existing primary NEVER changes.
 * - Nothing is invented: only the supplied reference is added.
 * - No similarity, confidence, or matching logic lives here.
 */
export function mergeSourceReference(
  identity: TrackIdentity,
  source: SourceReference,
): TrackIdentity {
  if (!isSourceType(source.source)) {
    throw new NormalizationError(
      "source",
      `Cannot merge a reference from unknown source "${source.source}"`,
    );
  }
  if (asNonEmptyString(source.id) === undefined) {
    throw new NormalizationError("id", "Cannot merge a source reference without an id");
  }
  const key = sourceReferenceKey(source);
  const primaryKey = sourceReferenceKey(identity.primarySource);
  const merged: SourceReference = {
    source: source.source,
    id: source.id,
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(source.metadata !== undefined ? { metadata: { ...source.metadata } } : {}),
  };
  const sources = identity.sources.map((candidate) =>
    sourceReferenceKey(candidate) === key ? merged : candidate,
  );
  if (!sources.some((candidate) => sourceReferenceKey(candidate) === key)) {
    sources.push(merged);
  }
  return {
    ...identity,
    sources,
    primarySource: primaryKey === key ? merged : identity.primarySource,
  };
}

/**
 * Adapts one provider's search result into canonical form. Each item gets a
 * FRESH identity — items are never merged or deduplicated, even when they
 * describe the same provider resource twice. Query, provenance, and
 * pagination are preserved.
 */
export function toCanonicalSearchResult(
  input: CanonicalSearchInput,
  query: string,
  source: SourceType,
): SearchResult<TrackIdentity> {
  if (!isSourceType(source)) {
    throw new NormalizationError(
      "source",
      `Cannot adapt results from unknown source "${source}"`,
    );
  }
  const result: SearchResult<TrackIdentity> = {
    items: input.items.map((track) => toTrackIdentity(track)),
    query,
    sources: [source],
  };
  if (input.total !== undefined) {
    result.total = input.total;
  }
  if (input.nextOffset !== undefined) {
    result.nextOffset = input.nextOffset;
  }
  return result;
}

/**
 * Structural invariant check for canonical identities:
 * non-empty Aurora id, at least one source, primary present in sources,
 * non-negative duration when known, non-empty artist list, valid source
 * types, no stream URLs in references.
 */
export function isValidTrackIdentity(identity: TrackIdentity): boolean {
  if (!identity || asNonEmptyString(identity.id) === undefined) {
    return false;
  }
  if (asNonEmptyString(identity.title) === undefined) {
    return false;
  }
  if (!Array.isArray(identity.artists) || identity.artists.length === 0) {
    return false;
  }
  if (
    identity.durationMs !== undefined &&
    (!Number.isFinite(identity.durationMs) || identity.durationMs < 0)
  ) {
    return false;
  }
  if (!Array.isArray(identity.sources) || identity.sources.length === 0) {
    return false;
  }
  const keys = new Set<string>();
  for (const source of identity.sources) {
    if (!source || !isSourceType(source.source)) {
      return false;
    }
    if (asNonEmptyString(source.id) === undefined) {
      return false;
    }
    if (typeof source.url === "string" && isPlaybackUrl(source.url)) {
      return false;
    }
    keys.add(sourceReferenceKey(source));
  }
  return keys.has(sourceReferenceKey(identity.primarySource));
}

function isPlaybackUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return (
    lowered.includes("mime=audio") ||
    lowered.includes("expire=") ||
    lowered.includes("/preview/") ||
    lowered.endsWith(".mp3")
  );
}
