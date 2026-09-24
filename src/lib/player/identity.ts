import type { Track } from "@/lib/domain";

export function trackKey(track: Pick<Track, "provider" | "id">): string {
  return `${track.provider}:${track.id}`;
}

export function sameTrack(
  a: Track | null | undefined,
  b: Pick<Track, "provider" | "id"> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.provider === b.provider && a.id === b.id;
}