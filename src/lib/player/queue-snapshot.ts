import type { Track } from "@/lib/domain";

/**
 * Versioned playback-session snapshot for authenticated persistence
 * (Phase 40 queue snapshot, completed as the Phase 43 persistent
 * playback session). The snapshot stores stable track identity +
 * display metadata only — NEVER temporary playback URLs (no
 * googlevideo / AudioSource / stream / preview URLs, no expiry, no
 * bitrate). After restore, the current track is re-resolved fresh
 * through PlaybackResolver; queued tracks stay identity-only until
 * played.
 *
 * Occurrences are the queue's own, one per canonical track: the store rejects
 * a second entry for a track it already holds, so a snapshot written by this
 * build never contains a repeat. Snapshots written BEFORE that invariant did,
 * and this file does not retro-claim otherwise — a repeat here is valid input
 * and is repaired at the single point where a persisted queue becomes live
 * (`PlayerStore.restoreQueueSnapshot`), which rebuilds the entries, the play
 * order and the cursor together rather than trusting the stored arrays.
 *
 * Version history (migratable, never an opaque blob):
 * - v1: queue + playOrder + cursor + mediaPosition + shuffle + repeat.
 * - v2: adds `volume` + `muted` (player preferences Aurora already
 *   models in PlayerStore) and `savedAt` (staleness signal). v1 rows
 *   are upgraded on read by `migrateQueueSnapshot`, never discarded.
 */

export const QUEUE_SNAPSHOT_VERSION = 2;

/** Oldest snapshot version this build can still read and upgrade. */
export const MIN_MIGRATABLE_QUEUE_SNAPSHOT_VERSION = 1;

/** Volume used when a v1 snapshot (no volume field) is migrated. */
export const DEFAULT_SNAPSHOT_VOLUME = 1;

/** Hard cap on persisted entries (defensive; the queue itself is unbounded). */
export const MAX_PERSISTED_QUEUE_ENTRIES = 200;

/** Trailing debounce for queue-mutation snapshot writes (ms, one-shot). */
export const QUEUE_SNAPSHOT_DEBOUNCE_MS = 500;

export type SnapshotRepeatMode = "off" | "all" | "one";

export interface PersistedQueueEntry {
  provider: string;
  providerTrackId: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId?: string;
  albumName?: string;
  artworkUrl?: string;
  duration?: number;
  explicit?: boolean;
  genres?: string[];
  /** Carried merged source refs (display/resolution identity, never URLs). */
  sources?: Array<{ source: string; id: string }>;
}

export interface PersistedQueueSnapshot {
  version: number;
  entries: PersistedQueueEntry[];
  /** Raw playOrder (indices into entries); persisted verbatim, never recomputed. */
  playOrder: number[];
  /** Cursor within playOrder (-1 when the queue is empty). */
  position: number;
  /** Media position in seconds for the current track. */
  mediaPosition: number;
  shuffle: boolean;
  repeat: SnapshotRepeatMode;
  /** Player volume in [0, 1] (Phase 43; v1 rows migrate to the default). */
  volume: number;
  muted: boolean;
  /** Epoch millis the snapshot was written; staleness only, never ordering. */
  savedAt: number;
}

export interface QueueSnapshotInput {
  queue: Track[];
  playOrder: number[];
  /** Cursor within playOrder. */
  position: number;
  mediaPosition: number;
  shuffle: boolean;
  repeat: SnapshotRepeatMode;
  /** Live player volume in [0, 1]; omitted values fall back to the default. */
  volume?: number;
  /** Live mute state; omitted values fall back to unmuted. */
  muted?: boolean;
  /** Write timestamp; defaults to now (tests pass an explicit value). */
  savedAt?: number;
}

/**
 * Stable content identity of a snapshot: everything that changes what the
 * user hears, and deliberately NOT `savedAt`. The write-dedupe compares
 * this so a heartbeat re-serializing the same session does not issue a
 * pointless request, while a genuinely newer write still records its time.
 */
export function queueSnapshotContentKey(snapshot: PersistedQueueSnapshot): string {
  return JSON.stringify({
    entries: snapshot.entries,
    playOrder: snapshot.playOrder,
    position: snapshot.position,
    mediaPosition: snapshot.mediaPosition,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    volume: snapshot.volume,
    muted: snapshot.muted,
  });
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function toEntry(track: Track): PersistedQueueEntry | null {
  const provider = cleanString(track.provider);
  const providerTrackId = cleanString(track.providerTrackId ?? track.id);
  const title = cleanString(track.title);
  const artistId = cleanString(track.artistId);
  const artistName = cleanString(track.artistName);
  if (!provider || !providerTrackId || !title || !artistId || !artistName) {
    return null;
  }
  const entry: PersistedQueueEntry = {
    provider,
    providerTrackId,
    title,
    artistId,
    artistName,
  };
  const albumId = cleanString(track.albumId);
  if (albumId) entry.albumId = albumId;
  const albumName = cleanString(track.albumName);
  if (albumName) entry.albumName = albumName;
  const artworkUrl = cleanString(track.artworkUrl);
  if (artworkUrl) entry.artworkUrl = artworkUrl;
  if (
    typeof track.duration === "number" &&
    Number.isFinite(track.duration) &&
    track.duration > 0
  ) {
    entry.duration = Math.floor(track.duration);
  }
  if (typeof track.explicit === "boolean") entry.explicit = track.explicit;
  const genres = cleanStringArray(track.genres);
  if (genres) entry.genres = genres;
  // Restore carried merged sources so resolution behaves exactly as it
  // did pre-persist. Only well-formed {source,id} refs survive; any
  // URL-bearing or malformed payload is dropped.
  const rawSources = track.metadata?.sources;
  if (Array.isArray(rawSources)) {
    const sources: Array<{ source: string; id: string }> = [];
    for (const raw of rawSources) {
      if (!raw || typeof raw !== "object") continue;
      const source = cleanString((raw as { source?: unknown }).source);
      const id = cleanString((raw as { id?: unknown }).id);
      if (source && id) sources.push({ source, id });
    }
    if (sources.length > 0) entry.sources = sources;
  }
  return entry;
}

/**
 * Serializes live queue state. Never throws; unserializable tracks are
 * dropped (their slots vanish — indices are rebuilt against the kept
 * entries). Entries beyond the cap are truncated from the tail with
 * playOrder repaired, so indices can never dangle.
 */
export function serializeQueueSnapshot(input: QueueSnapshotInput): PersistedQueueSnapshot {
  const kept: PersistedQueueEntry[] = [];
  const indexMap = new Map<number, number>();
  const limit = Math.min(input.queue.length, MAX_PERSISTED_QUEUE_ENTRIES);
  for (let i = 0; i < limit; i += 1) {
    const entry = toEntry(input.queue[i] as Track);
    if (entry) {
      indexMap.set(i, kept.length);
      kept.push(entry);
    }
  }
  const playOrder: number[] = [];
  for (const rawIndex of input.playOrder) {
    if (!Number.isInteger(rawIndex)) continue;
    const mapped = indexMap.get(rawIndex);
    if (mapped !== undefined) playOrder.push(mapped);
  }
  let position = -1;
  if (
    Number.isInteger(input.position) &&
    input.position >= 0 &&
    input.position < playOrder.length
  ) {
    position = input.position;
  } else if (playOrder.length > 0) {
    position = 0;
  }
  const mediaPosition =
    Number.isFinite(input.mediaPosition) && input.mediaPosition > 0
      ? Math.floor(input.mediaPosition)
      : 0;
  const volume =
    typeof input.volume === "number" && Number.isFinite(input.volume)
      ? Math.min(Math.max(input.volume, 0), 1)
      : DEFAULT_SNAPSHOT_VOLUME;
  return {
    version: QUEUE_SNAPSHOT_VERSION,
    entries: kept,
    playOrder,
    position,
    mediaPosition,
    shuffle: input.shuffle === true,
    repeat:
      input.repeat === "all" || input.repeat === "one" ? input.repeat : "off",
    volume,
    muted: input.muted === true,
    savedAt:
      typeof input.savedAt === "number" && Number.isFinite(input.savedAt)
        ? Math.floor(input.savedAt)
        : Date.now(),
  };
}

function isValidEntry(value: unknown): value is PersistedQueueEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  for (const key of ["provider", "providerTrackId", "title", "artistId", "artistName"]) {
    if (typeof entry[key] !== "string" || (entry[key] as string).trim().length === 0) {
      return false;
    }
  }
  // Hard rejection: playback-URL-shaped fields must never be restored.
  for (const forbidden of ["streamUrl", "previewUrl", "url", "mimeType", "expiresAt", "bitrate"]) {
    if (entry[forbidden] !== undefined) return false;
  }
  if (entry.sources !== undefined) {
    if (!Array.isArray(entry.sources)) return false;
    for (const source of entry.sources) {
      if (!source || typeof source !== "object") return false;
      const ref = source as Record<string, unknown>;
      if (typeof ref.source !== "string" || typeof ref.id !== "string") return false;
    }
  }
  return true;
}

/**
 * Validates an unknown persisted value and migrates it to the current
 * snapshot version. Returns the snapshot when it is fully trustworthy,
 * otherwise null (caller discards — never crashes, never half-restores).
 *
 * v1 rows gain the Phase 43 fields at their documented defaults
 * (full volume, unmuted, no staleness signal) so an existing account
 * keeps its queue instead of silently losing it. Unknown or future
 * versions are discarded rather than guessed at.
 */
export function validateQueueSnapshot(value: unknown): PersistedQueueSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const version = candidate.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < MIN_MIGRATABLE_QUEUE_SNAPSHOT_VERSION ||
    version > QUEUE_SNAPSHOT_VERSION
  ) {
    return null;
  }
  if (version === QUEUE_SNAPSHOT_VERSION) {
    return validateCurrentQueueSnapshot(candidate);
  }
  return migrateQueueSnapshot(candidate);
}

/**
 * Upgrades a validated older snapshot to the current version. Only
 * v1 → v2 exists today; each step is explicit and total so a future
 * version adds one entry rather than rewriting history.
 */
function migrateQueueSnapshot(candidate: Record<string, unknown>): PersistedQueueSnapshot | null {
  let working = candidate;
  if (working.version === 1) {
    // v1 carried no player preferences and no write timestamp. The
    // version is stamped forward so the current validator (which is
    // deliberately current-version-only) accepts the upgraded row.
    working = {
      ...working,
      version: QUEUE_SNAPSHOT_VERSION,
      volume: DEFAULT_SNAPSHOT_VOLUME,
      muted: false,
      savedAt: 0,
    };
  }
  return validateCurrentQueueSnapshot(working);
}

/** Structural + semantic validation of a current-version snapshot. */
function validateCurrentQueueSnapshot(
  candidate: Record<string, unknown>,
): PersistedQueueSnapshot | null {
  if (candidate.version !== QUEUE_SNAPSHOT_VERSION) return null;
  if (!Array.isArray(candidate.entries)) return null;
  if (!Array.isArray(candidate.playOrder)) return null;
  const entries = candidate.entries;
  if (entries.length > MAX_PERSISTED_QUEUE_ENTRIES) return null;
  for (const entry of entries) {
    if (!isValidEntry(entry)) return null;
  }
  for (const index of candidate.playOrder) {
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
      return null;
    }
  }
  const position: unknown = candidate.position;
  if (typeof position !== "number" || !Number.isInteger(position)) {
    return null;
  }
  if (
    entries.length === 0
      ? position !== -1
      : position < 0 || position >= (candidate.playOrder as unknown[]).length
  ) {
    return null;
  }
  const mediaPosition = candidate.mediaPosition;
  if (typeof mediaPosition !== "number" || !Number.isFinite(mediaPosition) || mediaPosition < 0) {
    return null;
  }
  if (typeof candidate.shuffle !== "boolean") return null;
  if (candidate.repeat !== "off" && candidate.repeat !== "all" && candidate.repeat !== "one") {
    return null;
  }
  const volume = candidate.volume;
  if (
    typeof volume !== "number" ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > 1
  ) {
    return null;
  }
  if (typeof candidate.muted !== "boolean") return null;
  const savedAt = candidate.savedAt;
  if (
    typeof savedAt !== "number" ||
    !Number.isFinite(savedAt) ||
    savedAt < 0
  ) {
    return null;
  }
  return {
    version: QUEUE_SNAPSHOT_VERSION,
    entries: entries as PersistedQueueEntry[],
    playOrder: (candidate.playOrder as number[]).slice(),
    position: position as number,
    mediaPosition: Math.floor(mediaPosition as number),
    shuffle: candidate.shuffle as boolean,
    repeat: candidate.repeat as SnapshotRepeatMode,
    volume,
    muted: candidate.muted as boolean,
    savedAt: Math.floor(savedAt as number),
  };
}

/** Rebuilds display Tracks from a validated snapshot (identity only). */
export function snapshotToTracks(snapshot: PersistedQueueSnapshot): Track[] {
  return snapshot.entries.map((entry) => {
    const track: Track = {
      id: entry.providerTrackId,
      provider: entry.provider as Track["provider"],
      providerTrackId: entry.providerTrackId,
      title: entry.title,
      artistId: entry.artistId,
      artistName: entry.artistName,
    };
    if (entry.albumId) track.albumId = entry.albumId;
    if (entry.albumName) track.albumName = entry.albumName;
    if (entry.artworkUrl) track.artworkUrl = entry.artworkUrl;
    if (entry.duration !== undefined) track.duration = entry.duration;
    if (entry.explicit !== undefined) track.explicit = entry.explicit;
    if (entry.genres) track.genres = [...entry.genres];
    if (entry.sources) {
      track.metadata = {
        sources: entry.sources.map((source) => ({ ...source })),
      };
    }
    return track;
  });
}
