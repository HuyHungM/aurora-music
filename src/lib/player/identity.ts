import type { Track } from "@/lib/domain";

export function trackKey(track: Pick<Track, "provider" | "id">): string {
  return `${track.provider}:${track.id}`;
}