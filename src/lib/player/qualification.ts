/**
 * Play-qualification rule (spec phase 5, §33).
 *
 * A track counts as a "qualified play" only when BOTH conditions hold:
 *  1. Playback actually started (the media element entered the playing state),
 *     which the caller is responsible for asserting.
 *  2. The playhead has progressed past a meaningful, deterministic threshold.
 *
 * Threshold: the earlier of (30 seconds, half the track duration). For tracks
 * without a known duration, only the 30-second rule applies.
 */
export const PLAY_QUALIFICATION_MAX_SECONDS = 30;

export function qualificationThresholdSeconds(duration?: number): number {
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    return Math.min(duration / 2, PLAY_QUALIFICATION_MAX_SECONDS);
  }
  return PLAY_QUALIFICATION_MAX_SECONDS;
}

export function isQualifiedPlay(
  currentTime: number,
  duration?: number,
  startedPlaying = true,
): boolean {
  if (!startedPlaying) {
    return false;
  }
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return false;
  }
  return currentTime >= qualificationThresholdSeconds(duration);
}