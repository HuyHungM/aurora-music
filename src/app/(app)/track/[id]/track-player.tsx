"use client";

import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { Track } from "@/lib/domain";
import { TrackArt } from "@/components/tracks/track-art";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";
import { LikeButton } from "@/components/tracks/like-button";

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function TrackPlayer({
  track,
  initialLiked,
}: {
  track: Track;
  initialLiked: boolean;
}) {
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

  const duration = formatDuration(track.duration);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <TrackArt
          src={track.artworkUrl}
          alt={track.title}
          size={192}
          className="h-48 w-full shrink-0 rounded-xl sm:h-48 sm:w-48"
        />
        <div className="flex flex-1 flex-col gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-accent">
            Track
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
            {track.title}
          </h1>
          <p className="text-sm text-text-muted">{track.artistName}</p>
          {track.albumName ? (
            <p className="text-xs text-text-muted">{track.albumName}</p>
          ) : null}
          <div className="flex items-center gap-3">
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
            <LikeButton
              track={track}
              initialLiked={initialLiked}
              size={18}
              className="h-12 w-12"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-text-muted">
        {duration ? (
          <span className="rounded-full bg-surface-2 px-3 py-1">
            {duration}
          </span>
        ) : null}
        {track.explicit ? (
          <span className="rounded-full bg-surface-2 px-3 py-1 font-semibold uppercase">
            Explicit
          </span>
        ) : null}
        {track.genres && track.genres.length > 0
          ? track.genres.map((genre) => (
              <span key={genre} className="rounded-full bg-surface-2 px-3 py-1">
                {genre}
              </span>
            ))
          : null}
      </div>
    </div>
  );
}
