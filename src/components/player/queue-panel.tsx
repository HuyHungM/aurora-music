"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { TrackArt } from "@/components/tracks/track-art";
import { Button } from "@/components/ui/button";
import { focusFirstByLabel } from "@/components/ui/focus";
import { ArrowDownIcon, ArrowUpIcon, PauseIcon, PlayIcon, QueueIcon, XIcon } from "@/components/ui/icons";

function QueueItemMenu({ position, trackTitle, disabled }: { position: number; trackTitle: string; disabled?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const engine = useMusicEngine();
  const removeFromQueue = (position: number) => engine?.queue.remove(position);

  useEffect(() => {
    // Return focus to the trigger when the menu closes.
    if (wasOpenRef.current && !isOpen) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // Consume before the panel-level handler (registered earlier, on
        // bubble): closing a row menu must not close the whole panel.
        e.stopPropagation();
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown, true);
    itemRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  if (disabled) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${trackTitle}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label="Track actions"
          className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-lg"
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              removeFromQueue(position);
              setIsOpen(false);
            }}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
          >
            <XIcon size={16} className="text-text-muted" />
            <span>Remove from queue</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function QueuePanel() {
  const engine = useMusicEngine();
  // Panel visibility is local UI chrome state, not engine state.
  const isQueueOpen = usePlayerStore((s) => s.isQueueOpen);
  const closeQueue = usePlayerStore((s) => s.closeQueue);
  const identities = useMusicEngineState((s) => s.queue);
  const playOrder = engine?.queue.playOrder ?? [];
  const position = useMusicEngineState((s) => s.currentIndex);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const listRef = useRef<HTMLUListElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const playAtPosition = useCallback(
    (pos: number) => engine?.playAt(pos),
    [engine],
  );
  const next = useCallback(() => engine?.skip(), [engine]);
  const prev = useCallback(() => engine?.previous(), [engine]);
  const moveQueueItem = useCallback(
    (pos: number, direction: "up" | "down") => {
      engine?.queue.move(pos, pos + (direction === "up" ? -1 : 1));
    },
    [engine],
  );

  useEffect(() => {
    if (isQueueOpen && currentRef.current?.scrollIntoView) {
      currentRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isQueueOpen, position]);

  useEffect(() => {
    // Move focus into the panel on open so keyboard users land inside it.
    // Programmatic focus does not show a focus ring for mouse users.
    if (
      isQueueOpen &&
      dialogRef.current &&
      !dialogRef.current.contains(document.activeElement)
    ) {
      dialogRef.current.focus();
    }
  }, [isQueueOpen]);

  const closeAndRestoreFocus = useCallback(() => {
    closeQueue();
    // The panel unmounts; return focus to the trigger that opened it.
    focusFirstByLabel("Up next");
  }, [closeQueue]);

  useEffect(() => {
    if (!isQueueOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        prev();
        return;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isQueueOpen, closeAndRestoreFocus, next, prev]);

  if (!isQueueOpen) {
    return null;
  }

  const items = playOrder.map((queueIndex, pos) => ({
    pos,
    track: identities[queueIndex],
  }));

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Queue"
      tabIndex={-1}
      className="fixed bottom-[calc(7rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-h-[70svh] w-[calc(100vw-2rem)] max-w-md flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-2xl sm:bottom-[calc(7.5rem+env(safe-area-inset-bottom))] lg:bottom-[calc(6rem+2rem)] lg:right-6 lg:left-auto lg:mx-0 lg:w-96 focus:outline-none"
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <QueueIcon size={18} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">
          Up next
          <span className="ml-2 text-xs font-normal text-text-muted">
            {items.length} {items.length === 1 ? "track" : "tracks"}
          </span>
        </h2>
        <span className="flex-1" />
        <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Close queue" onClick={closeAndRestoreFocus}>
          <XIcon size={18} />
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted">The queue is empty.</p>
      ) : (
        <ul ref={listRef} className="flex-1 overflow-y-auto py-1">
          {items.map(({ pos, track }) => {
            if (!track) {
              return null;
            }
            const artistName = track.artists[0]?.name ?? "";
            const artworkUrl = resolveArtworkUrl(track.artwork);
            const trackId = `${track.primarySource.source}:${track.primarySource.id}`;
            const isCurrent = pos === position;
            const actionLabel =
              isCurrent && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`;
            const handleClick = () => {
              if (isCurrent && isPlaying) {
                engine?.pause();
                return;
              }
              playAtPosition(pos);
            };
            return (
              <li
                key={trackId}
                ref={isCurrent ? currentRef : undefined}
              >
                <div
                  className={`flex items-center gap-3 px-4 py-2 ${
                    isCurrent ? "bg-surface-2/60" : "hover:bg-surface-2/40"
                  }`}
                >
                  <TrackArt src={artworkUrl} alt={track.title} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {track.title}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {isCurrent ? "Now playing" : artistName}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={actionLabel}
                    onClick={handleClick}
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-primary transition-colors hover:bg-surface-2"
                  >
                    {isCurrent && isPlaying ? (
                      <PauseIcon size={18} />
                    ) : (
                      <PlayIcon size={18} />
                    )}
                  </button>
                  <div className="flex items-center">
                    <button
                      type="button"
                      aria-label={`Move "${track.title}" up`}
                      disabled={pos === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveQueueItem(pos, "up");
                      }}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ArrowUpIcon size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move "${track.title}" down`}
                      disabled={pos === items.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveQueueItem(pos, "down");
                      }}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ArrowDownIcon size={16} />
                    </button>
                  </div>
                  {!isCurrent && (
                    <QueueItemMenu position={pos} trackTitle={track.title} disabled={isCurrent} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}