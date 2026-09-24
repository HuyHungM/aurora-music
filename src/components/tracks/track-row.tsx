"use client";

import type { Track } from "@/lib/domain";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { TrackArt } from "./track-art";
import { TrackActionMenu } from "./track-action-menu";
import { PauseIcon, PlayIcon } from "@/components/ui/icons";

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function TrackRow({
  track,
  collectionTracks,
  collectionIndex,
  showMenu = false,
  showAddToPlaylist = false,
  onLikeToggle,
  isLiked = false,
  onRemoveFromPlaylist,
}: {
  track: Track;
  collectionTracks?: Track[];
  collectionIndex?: number;
  showMenu?: boolean;
  showAddToPlaylist?: boolean;
  onLikeToggle?: () => void;
  isLiked?: boolean;
  onRemoveFromPlaylist?: () => void;
}) {
  const duration = formatDuration(track.duration);
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;

  const handleClick = () => {
    if (!engine) {
      return;
    }
    if (isCurrentPlaying) {
      engine.pause();
      return;
    }
    if (collectionTracks && collectionIndex !== undefined) {
      engine.playCollection(collectionTracks, collectionIndex);
    } else {
      void engine.play(track);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/60">
      <TrackArt src={track.artworkUrl} alt={track.title} size={44} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-text-primary">{track.title}</span>
        <span className="truncate text-xs text-text-muted">{track.artistName}</span>
      </span>
      {duration ? <span className="shrink-0 text-xs tabular-nums text-text-muted">{duration}</span> : null}
      <button
        type="button"
        aria-label={isCurrentPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
        onClick={handleClick}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-primary transition-colors hover:bg-surface-2"
      >
        {isCurrentPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      </button>
      {onRemoveFromPlaylist ? (
        <button
          type="button"
          aria-label={`Remove ${track.title} from playlist`}
          onClick={onRemoveFromPlaylist}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-red-400"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      ) : null}
      {showMenu ? (
        <TrackActionMenu
          track={track}
          showLike={true}
          onLikeToggle={onLikeToggle}
          isLiked={isLiked}
          showAddToPlaylist={showAddToPlaylist}
        />
      ) : null}
    </div>
  );
}
