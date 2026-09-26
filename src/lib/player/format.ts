export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * Track-list duration label. Unlike playback time, unknown durations
 * render as nothing (no "0:00" placeholder in rows and headers).
 */
export function formatTrackDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}