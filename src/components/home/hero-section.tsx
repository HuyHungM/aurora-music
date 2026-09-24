"use client";

import type { Track } from "@/lib/domain";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { TrackArt } from "@/components/tracks/track-art";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";

export function HeroSection({ track }: { track: Track }) {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;

  const handlePlay = () => {
    if (!engine) {
      return;
    }
    if (isCurrentPlaying) {
      engine.pause();
    } else {
      void engine.play(track);
    }
  };

  return (
    <section
      aria-label="Featured track"
      className="relative overflow-hidden rounded-2xl border border-border-subtle bg-surface-2/60 p-6 sm:p-8"
    >
      <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/20 via-transparent to-purple-500/10" />
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <TrackArt
          src={track.artworkUrl}
          alt={track.title}
          size={160}
          className="w-full shrink-0 rounded-xl sm:w-40"
        />
        <div className="flex flex-1 flex-col gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-accent">
            Featured
          </span>
          <h2 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
            {track.title}
          </h2>
          <p className="text-sm text-text-muted">
            {track.artistName}
            {track.albumName ? ` \u00B7 ${track.albumName}` : ""}
          </p>
          <div>
            <button
              type="button"
              onClick={handlePlay}
              aria-label={isCurrentPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              {isCurrentPlaying ? (
                <>
                  <PauseIcon size={18} /> Pause
                </>
              ) : (
                <>
                  <PlayIcon size={18} /> Play
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
