"use client";

import type { ReactNode } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { EngineRepeatMode } from "@/lib/music/music-engine";
import { TrackArt } from "@/components/tracks/track-art";
import { ExpandIcon, PauseIcon, PlayIcon, QueueIcon, RepeatIcon, RepeatOneIcon } from "@/components/ui/icons";

function Button({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-primary transition-colors hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

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

export function MiniPlayer() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const error = useMusicEngineState((s) => s.error);
  const repeat = useMusicEngineState((s) => s.repeat);
  const repeatDisplay = repeatLabel(repeat);
  // Queue/full-player visibility is local UI chrome state, not engine state.
  const openQueue = usePlayerStore((s) => s.openQueue);
  const openFullPlayer = usePlayerStore((s) => s.openFullPlayer);

  if (!currentTrack) {
    return null;
  }

  const artworkUrl = resolveArtworkUrl(currentTrack.artwork);
  const artistName = currentTrack.artists[0]?.name ?? "";

  return (
    <div
      role="region"
      aria-label="Mini player"
      className="fixed inset-x-0 bottom-12 z-40 flex h-16 items-center gap-3 border-t border-border-subtle bg-surface-1 px-3 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <TrackArt src={artworkUrl} alt={currentTrack.title} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{currentTrack.title}</p>
        <p className="truncate text-xs text-text-muted">
          {error ? error.message : artistName}
        </p>
      </div>
      <button
        type="button"
        aria-label={repeatDisplay === "one" ? "Repeat: one" : `Repeat: ${repeatDisplay}`}
        onClick={() => engine?.setRepeat(nextRepeatMode(repeat))}
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors hover:bg-surface-2 ${
          repeatDisplay !== "off" ? "text-accent" : "text-text-muted hover:text-text-primary"
        }`}
      >
        {repeatDisplay === "one" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
      </button>
      <button
        type="button"
        aria-label="Up next"
        onClick={openQueue}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <QueueIcon size={20} />
      </button>
      <button
        type="button"
        aria-label="Expand player"
        onClick={openFullPlayer}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <ExpandIcon size={20} />
      </button>
      <Button
        label={isPlaying ? "Pause" : "Play"}
        onClick={() => engine?.togglePlay()}
      >
        {isLoading ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        ) : isPlaying ? (
          <PauseIcon size={22} />
        ) : (
          <PlayIcon size={22} />
        )}
      </Button>
    </div>
  );
}