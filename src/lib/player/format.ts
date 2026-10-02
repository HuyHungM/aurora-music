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
 *
 * Adaptive: `MM:SS` below one hour (`03:42`, never `00:03:42`), `HH:MM:SS`
 * at and above it (`01:02:34`). The hour component appears only when
 * non-zero, and is padded to at least two digits; minutes and seconds are
 * always exactly two digits. Input is seconds,
 * matching `Track.duration` (`identity-track.ts` divides `durationMs` by
 * 1000 at ingestion, so this never sees milliseconds).
 */
export function formatTrackDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = minutes.toString().padStart(2, "0");
  const ss = rest.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}