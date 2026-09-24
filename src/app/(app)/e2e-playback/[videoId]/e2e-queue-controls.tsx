"use client";

import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { Track } from "@/lib/domain";

/**
 * Minimal E2E scaffolding for the live playback suite. Uses ONLY the public
 * MusicEngine facade — the same path every production play button uses.
 * No direct store/engine/resolver access, no fakes.
 */
export function E2EQueueControls({ tracks }: { tracks: Track[] }) {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((state) => state.currentTrack);
  const isPlaying = useMusicEngineState((state) => state.isPlaying);

  return (
    <section aria-label="E2E queue controls" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="E2E play collection"
          onClick={() => engine?.playCollection(tracks, 0)}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold"
        >
          E2E: play collection
        </button>
        <button
          type="button"
          aria-label="E2E queue next"
          onClick={() => {
            const next = tracks[1];
            if (next) {
              engine?.queue.playNext(next);
            }
          }}
          className="rounded-full border px-4 py-2 text-sm font-semibold"
        >
          E2E: queue next
        </button>
      </div>
      <p className="text-xs text-text-muted" data-testid="e2e-status">
        {`E2E status: ${currentTrack?.title ?? "none"} / ${
          isPlaying ? "playing" : "paused"
        }`}
      </p>
    </section>
  );
}
