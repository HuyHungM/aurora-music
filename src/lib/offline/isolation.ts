/**
 * Server-side isolation for offline (local-file) tracks. SAFE ON THE SERVER —
 * this module deliberately imports no browser API, so a `"use server"` action
 * can use it without pulling the client-only offline modules into the server
 * bundle.
 *
 * WHY A SEPARATE MODULE. Three actions (`recordPlayedAction`,
 * `likeTrackAction`, `addTrackToPlaylistAction`) receive a whole `Track` from
 * the browser and write it. Once `local` joined `SourceType`, a local track
 * could reach the catalog through any of them — it has a title, an artist and
 * an id, so nothing upstream would have stopped it. The exclusion from
 * queue snapshots lives in `player/queue-snapshot.ts`; this is the same rule
 * applied to catalog writes, stated once so all three call sites agree.
 *
 * HIDING THE CONTROLS IS NOT ENOUGH. The UI will not offer these actions for
 * a local row, but a hand-written request does not read the UI. The guard is
 * here because a client is not a trust boundary.
 */

import { LOCAL_SOURCE_TYPE } from "@/lib/domain";

/**
 * True when a value names the offline source, which must never be persisted
 * as catalog data.
 *
 * Checked by exact match rather than "not a known provider" on purpose: this
 * narrows to the new case and leaves every pre-existing provider's behaviour
 * byte-for-byte unchanged.
 */
export function isOfflineSource(value: unknown): boolean {
  return value === LOCAL_SOURCE_TYPE;
}

/** Convenience form for the many `Track`-shaped call sites. */
export function isOfflineTrack(track: { provider?: unknown } | null | undefined): boolean {
  return !!track && isOfflineSource(track.provider);
}