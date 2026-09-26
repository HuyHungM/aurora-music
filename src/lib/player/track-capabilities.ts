import type { Track } from "@/lib/domain";
import { isSourceType } from "@/lib/domain";

/**
 * UI capability model for unified Aurora tracks (Phase 37).
 *
 * This is the SINGLE well-defined boundary where playback resolvability
 * is derived for presentation. It consumes existing domain state only:
 *
 * - A unified search group carries its FULL merged source list in
 *   `metadata.sources` (written by the TrackIdentity→Track adapter so the
 *   PlaybackController can restore the playable source at play time).
 * - The PlaybackResolver picks the first source with a registered
 *   resolver; the only registered source is `youtube`
 *   (`createServerSourceResolver` in PlayerHost).
 *
 * This module mirrors that `pick()` decision WITHOUT duplicating
 * resolution: no network, no matching, no scoring, no provider API calls.
 * It answers "can Aurora attempt playback for this row?" — the controller
 * remains the authority on whether an attempt succeeds.
 *
 * Rules:
 * - A track is `playable` when any carried or primary source is
 *   resolver-registered (youtube), regardless of which provider supplied
 *   the primary metadata. A Spotify/Deezer-primary track WITH a merged
 *   YouTube source exposes Play; without one it is `catalog-only`.
 * - Unknown/test source types (mock/jamendo — removed providers,
 *   test-only) default to attemptable: production's source set is closed
 *   (youtube/spotify/deezer), so this fallback only affects test doubles
 *   and never invents unplayability.
 * - Queue, like, playlist, and details actions are always available:
 *   library/queue/details are provider-agnostic concepts, and queue
 *   entries resolve (or report terminal errors) through the existing
 *   engine UI at play time.
 */
export type TrackPlayability = "playable" | "catalog-only";

export interface TrackCapabilities {
  canPlay: boolean;
  canQueue: boolean;
  canLike: boolean;
  canAddToPlaylist: boolean;
  canOpenDetails: boolean;
  playability: TrackPlayability;
}

/** Source types with a registered playback resolver (mirrors PlayerHost). */
const RESOLVABLE_SOURCES: readonly string[] = ["youtube"];

interface CarriedSource {
  source: string;
  id: string;
}

function isCarriedSource(value: unknown): value is CarriedSource {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CarriedSource>;
  return (
    typeof candidate.source === "string" &&
    candidate.source.length > 0 &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  );
}

function carriedSources(track: Track): CarriedSource[] {
  const raw = track.metadata?.sources;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isCarriedSource);
}

export function trackPlayability(track: Track): TrackPlayability {
  const sources: CarriedSource[] = [
    ...carriedSources(track),
    {
      source: track.provider,
      id: track.providerTrackId ?? track.id,
    },
  ];
  if (sources.some((ref) => RESOLVABLE_SOURCES.includes(ref.source))) {
    return "playable";
  }
  // Closed production source set: youtube (above) is resolvable, so a
  // spotify/deezer-only identity is catalog-only. Unknown/test sources
  // stay attemptable rather than inventing unplayability.
  const known = sources.some((ref) => isSourceType(ref.source));
  return known ? "catalog-only" : "playable";
}

export function trackCapabilities(track: Track): TrackCapabilities {
  const playability = trackPlayability(track);
  return {
    canPlay: playability === "playable",
    canQueue: true,
    canLike: true,
    canAddToPlaylist: true,
    canOpenDetails: true,
    playability,
  };
}

export type CollectionPlayability = "empty" | "playable" | "catalog-only";

/** A collection can attempt playback when ANY member can. */
export function collectionPlayability(tracks: Track[]): CollectionPlayability {
  if (tracks.length === 0) {
    return "empty";
  }
  return tracks.some((track) => trackPlayability(track) === "playable")
    ? "playable"
    : "catalog-only";
}
