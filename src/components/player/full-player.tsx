"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { EngineRepeatMode } from "@/lib/music/music-engine";
import { formatPlaybackTime } from "@/lib/player/format";
import { TrackArt } from "@/components/tracks/track-art";
import { focusFirstByLabel } from "@/components/ui/focus";
import { Button } from "@/components/ui/button";
import {
  PauseIcon,
  PlayIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
  VolumeMuteIcon,
  XIcon,
} from "@/components/ui/icons";

function repeatLabel(repeat: EngineRepeatMode): "off" | "all" | "one" {
  if (repeat === "track") {
    return "one";
  }
  if (repeat === "queue") {
    return "all";
  }
  return "off";
}

function nextRepeatMode(repeat: EngineRepeatMode): EngineRepeatMode {
  if (repeat === "off") {
    return "queue";
  }
  if (repeat === "queue") {
    return "track";
  }
  return "off";
}

export function FullPlayer() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const currentTime = useMusicEngineState((s) => s.position);
  const duration = useMusicEngineState((s) => s.duration);
  const volume = useMusicEngineState((s) => s.volume);
  const muted = useMusicEngineState((s) => s.muted);
  const shuffle = useMusicEngineState((s) => s.shuffle);
  const repeat = useMusicEngineState((s) => s.repeat);
  const repeatDisplay = repeatLabel(repeat);
  // Full-player visibility is local UI chrome state, not engine state.
  const isFullPlayerOpen = usePlayerStore((s) => s.isFullPlayerOpen);
  const closeFullPlayer = usePlayerStore((s) => s.closeFullPlayer);
  const openQueue = usePlayerStore((s) => s.openQueue);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isFullPlayerOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFullPlayer();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // Announce the dialog on open unless focus already landed inside.
    if (
      dialogRef.current &&
      !dialogRef.current.contains(document.activeElement)
    ) {
      dialogRef.current.focus();
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Return focus to the trigger in the mini player.
      focusFirstByLabel("Expand player");
    };
  }, [isFullPlayerOpen, closeFullPlayer]);

  if (!currentTrack || !isFullPlayerOpen) return null;

  const artworkUrl = resolveArtworkUrl(currentTrack.artwork);
  const artistName = currentTrack.artists[0]?.name ?? "";

  const seekMax = duration > 0 ? duration : 1;
  const seekValue = Math.min(Math.max(currentTime, 0), seekMax);
  const displayVolume = muted ? 0 : volume;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Now playing"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-surface-1 lg:hidden animate-in slide-in-from-bottom-2/4 duration-300 focus:outline-none"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <span className="text-sm font-semibold text-text-primary">Now Playing</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label="Close player"
          onClick={closeFullPlayer}
        >
          <XIcon size={20} />
        </Button>
      </div>

      <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 py-6">
        <TrackArt
          src={artworkUrl}
          alt={currentTrack.title}
          size={160}
          className="max-w-[80vw] rounded-xl"
        />

        <div className="w-full max-w-xs text-center">
          <h2 className="truncate text-lg font-semibold text-text-primary">
            {currentTrack.title}
          </h2>
          <p className="truncate text-sm text-text-muted">{artistName}</p>
        </div>

        <div className="w-full max-w-sm">
          <input
            type="range"
            min={0}
            max={seekMax}
            step={1}
            value={seekValue}
            aria-label="Seek"
            onChange={(event) => engine?.seek(Number(event.currentTarget.value))}
            onKeyDown={(e) => {
              const step = 5;
              if (e.key === "ArrowRight") {
                e.preventDefault();
                engine?.seek(Math.min(currentTime + step, seekMax));
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                engine?.seek(Math.max(currentTime - step, 0));
              } else if (e.key === "Home") {
                e.preventDefault();
                engine?.seek(0);
              } else if (e.key === "End") {
                e.preventDefault();
                engine?.seek(seekMax);
              }
            }}
            className="w-full accent-accent focus-visible:outline-2 focus-visible:outline-accent"
          />
          <div className="flex justify-between text-[11px] tabular-nums text-text-muted">
            <span>{formatPlaybackTime(currentTime)}</span>
            <span>{formatPlaybackTime(duration)}</span>
          </div>
        </div>

        <div
          className="flex items-center gap-2"
          role="group"
          aria-label="Playback controls"
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
            aria-pressed={shuffle}
            onClick={() => engine?.shuffle()}
          >
            <ShuffleIcon size={20} className={shuffle ? "text-accent" : ""} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Previous track"
            onClick={() => engine?.previous()}
          >
            <SkipBackIcon size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-12 w-12"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={() => engine?.togglePlay()}
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
            ) : isPlaying ? (
              <PauseIcon size={24} />
            ) : (
              <PlayIcon size={24} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Next track"
            onClick={() => engine?.skip()}
          >
            <SkipForwardIcon size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={`Repeat: ${repeatDisplay}`}
            aria-pressed={repeatDisplay !== "off"}
            onClick={() => engine?.setRepeat(nextRepeatMode(repeat))}
          >
            {repeatDisplay === "one" ? (
              <RepeatOneIcon size={20} className="text-accent" />
            ) : (
              <RepeatIcon size={20} className={repeatDisplay === "all" ? "text-accent" : ""} />
            )}
          </Button>
        </div>

        <div className="flex w-full max-w-sm items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => engine?.toggleMute()}
          >
            {muted ? <VolumeMuteIcon size={20} /> : <VolumeIcon size={20} />}
          </Button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={displayVolume}
            aria-label="Volume"
            onChange={(event) => engine?.setVolume(Number(event.currentTarget.value))}
            className="flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label="Up next"
          onClick={openQueue}
        >
          <QueueIcon size={20} />
        </Button>
      </div>
    </div>
  );
}
