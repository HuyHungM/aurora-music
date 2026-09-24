/**
 * Narrow bridge from resolved playback sources to the existing player.
 *
 * `withPlaybackSource` attaches a freshly resolved URL to an IN-MEMORY
 * Track copy so `PlayerEngine.load` (which reads `streamUrl`) can play it
 * without any engine signature change. The copy must never be persisted:
 * PlaybackState, DAL writes, and recently-played flows keep using the
 * stable track identity. Temporary URLs stay ephemeral by construction.
 *
 * `createResolutionGuard` gives the future playback controller stale-result
 * protection: each resolution claims a monotonically increasing token and
 * only the latest token may apply its result. The pure resolver itself
 * holds no player state; the guard lives at this controller boundary.
 */

import type { AudioSource, SerializedAudioSource, Track } from "@/lib/domain";

/**
 * Returns an in-memory Track copy carrying the resolved URL as its
 * transient `streamUrl`. Memory only — never persist the result.
 */
export function withPlaybackSource(
  track: Track,
  source: Pick<AudioSource | SerializedAudioSource, "url">,
): Track {
  return { ...track, streamUrl: source.url };
}

export interface ResolutionGuard {
  /** Claims the next generation token for a new resolution attempt. */
  claim(): number;
  /** True when the token is still the latest claim. */
  isCurrent(token: number): boolean;
  /** Latest claimed token (0 when nothing claimed yet). */
  current(): number;
}

/** Monotonic generation guard against stale async resolutions. */
export function createResolutionGuard(): ResolutionGuard {
  let generation = 0;
  return {
    claim(): number {
      generation += 1;
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
    current(): number {
      return generation;
    },
  };
}
