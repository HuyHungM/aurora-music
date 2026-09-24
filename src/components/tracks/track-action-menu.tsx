"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { CheckIcon, PlusIcon, SkipForwardIcon, ListMusicIcon } from "@/components/ui/icons";
import { AddToPlaylistMenu } from "./add-to-playlist-menu";

function TrackActionMenuContent({
  track,
  onClose,
  onLikeToggle,
  isLiked,
  showAddToPlaylist,
  onAddToPlaylist,
}: {
  track: Track;
  onClose: () => void;
  onLikeToggle?: () => void;
  isLiked?: boolean;
  showAddToPlaylist?: boolean;
  onAddToPlaylist?: () => void;
}) {
  const engine = useMusicEngine();
  const playNext = (track: Track) => engine?.queue.playNext(track);
  const addToQueue = (track: Track) => engine?.queue.add(track);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);

  useEffect(() => {
    itemsRef.current[0]?.focus();
  }, []);

  const focusItem = (index: number) => {
    const items = itemsRef.current;
    if (items.length === 0) return;
    const next = index < 0 ? items.length - 1 : index >= items.length ? 0 : index;
    items[next]?.focus();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const current = document.activeElement;
        const idx = itemsRef.current.indexOf(current as HTMLButtonElement);
        focusItem(idx + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const current = document.activeElement;
        const idx = itemsRef.current.indexOf(current as HTMLButtonElement);
        focusItem(idx - 1);
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handlePlayNext = () => {
    playNext(track);
    onClose();
  };

  const handleAddToQueue = () => {
    addToQueue(track);
    onClose();
  };

  let itemIdx = 0;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Track actions"
      className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-lg"
    >
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        onClick={handlePlayNext}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
      >
        <SkipForwardIcon size={16} className="text-text-muted" />
        <span>Play next</span>
      </button>
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        onClick={handleAddToQueue}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
      >
        <PlusIcon size={16} className="text-text-muted" />
        <span>Add to queue</span>
      </button>
      {onLikeToggle ? (
        <button
          ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
          type="button"
          role="menuitem"
          onClick={onLikeToggle}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
        >
          {isLiked ? (
            <CheckIcon size={16} className="text-accent" />
          ) : (
            <span className="h-4 w-4" />
          )}
          <span>{isLiked ? "Unlike" : "Like"}</span>
        </button>
      ) : null}
      {showAddToPlaylist && onAddToPlaylist ? (
        <button
          ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
          type="button"
          role="menuitem"
          onClick={onAddToPlaylist}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
        >
          <ListMusicIcon size={16} className="text-text-muted" />
          <span>Add to playlist</span>
        </button>
      ) : null}
    </div>
  );
}

export function TrackActionMenu({
  track,
  onLikeToggle,
  isLiked,
  showLike = false,
  showAddToPlaylist = false,
  className,
}: {
  track: Track;
  onLikeToggle?: () => void;
  isLiked?: boolean;
  showLike?: boolean;
  showAddToPlaylist?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showPlaylistMenu, setShowPlaylistMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setShowPlaylistMenu(false);
  }, []);

  useEffect(() => {
    // Return focus to the trigger when the menu (or its submenu) closes.
    // Programmatic focus shows no ring for mouse users.
    if (wasOpenRef.current && !isOpen) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  const handleAddToPlaylist = () => {
    setShowPlaylistMenu(true);
  };

  const handlePlaylistMenuClose = () => {
    setShowPlaylistMenu(false);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {isOpen && !showPlaylistMenu ? (
        <TrackActionMenuContent
          track={track}
          onClose={handleClose}
          onLikeToggle={showLike ? onLikeToggle : undefined}
          isLiked={isLiked}
          showAddToPlaylist={showAddToPlaylist}
          onAddToPlaylist={showAddToPlaylist ? handleAddToPlaylist : undefined}
        />
      ) : null}
      {isOpen && showPlaylistMenu ? (
        <AddToPlaylistMenu track={track} onClose={handlePlaylistMenuClose} />
      ) : null}
    </div>
  );
}
