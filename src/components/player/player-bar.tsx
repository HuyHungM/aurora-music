"use client";

import { resolveArtworkUrl } from "@/lib/domain";
import { usePlayerStore } from "@/lib/player/store";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { EngineRepeatMode } from "@/lib/music/music-engine";
import { formatPlaybackTime } from "@/lib/player/format";
import { TrackArt } from "@/components/tracks/track-art";
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
} from "@/components/ui/icons";

/** Engine repeat vocabulary mapped back onto the established UI labels. */
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

export function PlayerBar() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const currentTime = useMusicEngineState((s) => s.position);
  const duration = useMusicEngineState((s) => s.duration);
  const volume = useMusicEngineState((s) => s.volume);
  const muted = useMusicEngineState((s) => s.muted);
  const error = useMusicEngineState((s) => s.error);
  const shuffle = useMusicEngineState((s) => s.shuffle);
  const repeat = useMusicEngineState((s) => s.repeat);
  const queueIndex = useMusicEngineState((s) => s.currentIndex);
  const repeatDisplay = repeatLabel(repeat);
  const artistName = currentTrack?.artists[0]?.name ?? "";
  const artworkUrl = currentTrack ? resolveArtworkUrl(currentTrack.artwork) : undefined;
  // Queue-panel visibility is local UI chrome state, not engine state.
  const openQueue = usePlayerStore((s) => s.openQueue);

  const seekMax = duration > 0 ? duration : 1;
  const seekValue = Math.min(Math.max(currentTime, 0), seekMax);
  const displayVolume = muted ? 0 : volume;

  return (
    <div
      role="region"
      aria-label="Player bar"
      className="fixed inset-x-0 bottom-0 z-40 hidden h-[6rem] border-t border-border-subtle bg-surface-1 lg:left-60 lg:flex"
    >
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {currentTrack ? (
            <>
              <TrackArt src={artworkUrl} alt={currentTrack.title} size={44} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-text-primary">
                  {currentTrack.title}
                </span>
                <span className="truncate text-xs text-text-muted">
                  {artistName}
                </span>
              </span>
            </>
          ) : (
            <span className="truncate text-sm text-text-muted">Nothing playing</span>
          )}
        </div>

        <div className="flex items-center gap-2" role="group" aria-label="Playback controls">
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
            disabled={!currentTrack}
          >
            <SkipBackIcon size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={() => engine?.togglePlay()}
            disabled={!currentTrack || isLoading}
          >
            {isLoading ? (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
            ) : isPlaying ? (
              <PauseIcon size={22} />
            ) : (
              <PlayIcon size={22} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Next track"
            onClick={() => engine?.skip()}
            disabled={!currentTrack}
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

        <div className="flex items-center gap-3 justify-self-end">
          <div className="flex min-w-44 flex-col gap-1">
            <div className="flex items-center gap-2">
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
            </div>
            <div className="flex justify-between text-[11px] tabular-nums text-text-muted">
              <span>{formatPlaybackTime(currentTime)}</span>
              <span>{formatPlaybackTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label="Up next"
              onClick={openQueue}
            >
              <QueueIcon size={20} />
            </Button>
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
              className="w-24 accent-accent"
            />
          </div>
        </div>
      </div>

      {error && currentTrack ? (
        <div
          role="status"
          className="absolute inset-x-0 -top-7 mx-auto flex w-max max-w-[90%] items-center gap-3 truncate rounded-t-lg border border-b-0 border-border-subtle bg-surface-1 px-4 py-1.5 text-xs text-text-secondary"
        >
          <span className="truncate">{error.message}</span>
          <button
            type="button"
            aria-label="Retry playback"
            onClick={() => {
              if (queueIndex >= 0) {
                engine?.playAt(queueIndex);
              }
            }}
            className="shrink-0 rounded-full border border-border-strong px-2.5 py-0.5 font-semibold text-text-primary transition-colors hover:border-accent/50 hover:text-accent"
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}