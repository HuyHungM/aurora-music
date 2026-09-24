export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}