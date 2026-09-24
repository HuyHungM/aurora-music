/**
 * Ephemeral playback source produced by the Music Engine resolver layer.
 *
 * An AudioSource is NOT stable track identity. It is resolved at play time
 * and must never be persisted: stream URLs can be signed, session-scoped,
 * or expiring. Persist only {@link TrackRef} (`provider` + `providerTrackId`)
 * and resolve a fresh AudioSource when restoring playback.
 *
 * Later integration concern (documented, not implemented here): the existing
 * `Track.streamUrl` / `Track.previewUrl` contract and `PlayerEngine.load`
 * remain frozen in Phase 01. The resolver -> AudioSource -> PlayerEngine
 * migration belongs to the playback integration phases.
 */
export interface AudioSource {
  url: string;
  mimeType?: string;
  durationMs?: number;
  /** Wall-clock expiry of the underlying stream URL, when known. */
  expiresAt?: Date;
  bitrate?: number;
}

/**
 * JSON-safe representation of an AudioSource for server/client transport.
 * Dates are encoded as ISO strings; nothing secret is ever included.
 */
export interface SerializedAudioSource {
  url: string;
  mimeType?: string;
  durationMs?: number;
  expiresAt?: string;
  bitrate?: number;
}

/** Returns true when the source has a known expiry at or before `now`. */
export function isAudioSourceExpired(
  source: AudioSource | undefined | null,
  now: number = Date.now(),
): boolean {
  if (!source || !source.expiresAt) {
    return false;
  }
  const expires = source.expiresAt.getTime();
  if (!Number.isFinite(expires)) {
    return false;
  }
  return expires <= now;
}

/** Serializes an AudioSource without depending on default Error/JSON quirks. */
export function serializeAudioSource(source: AudioSource): SerializedAudioSource {
  const serialized: SerializedAudioSource = { url: source.url };
  if (source.mimeType !== undefined) {
    serialized.mimeType = source.mimeType;
  }
  if (source.durationMs !== undefined) {
    serialized.durationMs = source.durationMs;
  }
  if (source.bitrate !== undefined) {
    serialized.bitrate = source.bitrate;
  }
  if (source.expiresAt instanceof Date && !Number.isNaN(source.expiresAt.getTime())) {
    serialized.expiresAt = source.expiresAt.toISOString();
  }
  return serialized;
}

/**
 * Parses a transport payload back into an AudioSource. Returns null for
 * malformed input instead of throwing, so provider boundary code can map
 * failures to typed errors.
 */
export function parseAudioSource(input: unknown): AudioSource | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.url !== "string" || candidate.url.length === 0) {
    return null;
  }
  const source: AudioSource = { url: candidate.url };
  if (typeof candidate.mimeType === "string" && candidate.mimeType.length > 0) {
    source.mimeType = candidate.mimeType;
  }
  if (
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs >= 0
  ) {
    source.durationMs = Math.floor(candidate.durationMs);
  }
  if (
    typeof candidate.bitrate === "number" &&
    Number.isFinite(candidate.bitrate) &&
    candidate.bitrate > 0
  ) {
    source.bitrate = Math.floor(candidate.bitrate);
  }
  const expiresAt = candidate.expiresAt;
  if (typeof expiresAt === "string" && expiresAt.length > 0) {
    const parsed = new Date(expiresAt);
    if (!Number.isNaN(parsed.getTime())) {
      source.expiresAt = parsed;
    }
  } else if (expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())) {
    source.expiresAt = expiresAt;
  }
  return source;
}
