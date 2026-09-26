"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { CheckIcon, PlusIcon, SkipForwardIcon, ListMusicIcon, RadioIcon } from "@/components/ui/icons";
import { getRadioSession } from "@/lib/radio/instance";
import { useLocale } from "@/components/i18n/locale-provider";
import { usePresence } from "@/components/ui/presence";
import { AddToPlaylistMenu } from "./add-to-playlist-menu";

function TrackActionMenuContent({
  track,
  onClose,
  onLikeToggle,
  isLiked,
  showAddToPlaylist,
  onAddToPlaylist,
  openUp,
  presenceProps,
}: {
  track: Track;
  onClose: () => void;
  onLikeToggle?: () => void;
  isLiked?: boolean;
  showAddToPlaylist?: boolean;
  onAddToPlaylist?: () => void;
  openUp: boolean;
  presenceProps: { "data-presence": "entering" | "entered" | "exiting"; inert: boolean };
}) {
  const engine = useMusicEngine();
  const { t } = useLocale();
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

  const handleStartRadio = () => {
    const session = getRadioSession();
    if (engine && session) {
      void session.startTrackRadio(engine, track, {
        key: "radio.labelFromTrack",
        params: { title: track.title },
      });
    }
    onClose();
  };

  let itemIdx = 0;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("menus.trackActions")}
      {...presenceProps}
      className={`${openUp ? "presence-menu-up" : "presence-menu"} aurora-glass-float absolute right-0 z-dropdown w-48 overflow-hidden rounded-lg border border-border-subtle ${
        openUp ? "bottom-full mb-1" : "top-full mt-1"
      }`}
    >
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        onClick={handlePlayNext}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
      >
        <SkipForwardIcon size={16} className="text-text-muted" />
        <span>{t("menus.playNext")}</span>
      </button>
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        onClick={handleAddToQueue}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
      >
        <PlusIcon size={16} className="text-text-muted" />
        <span>{t("menus.addToQueue")}</span>
      </button>
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        aria-label={t("menus.startRadioFor", { title: track.title })}
        onClick={handleStartRadio}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
      >
        <RadioIcon size={16} className="text-text-muted" />
        <span>{t("menus.startRadio")}</span>
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
          <span>{isLiked ? t("menus.unlike") : t("menus.like")}</span>
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
          <span>{t("menus.addToPlaylist")}</span>
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
  // Open upward when the trigger sits close to the viewport bottom so
  // menus/submenus are never trapped behind the fixed player bar.
  const [openUp, setOpenUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  // One lifecycle for the whole open region (Phase 48). It is owned here
  // rather than inside each child because the region has two mutually
  // exclusive children: the menu and the playlist picker swap in the same
  // slot, and a per-child lifecycle would mean two independent exit timers
  // racing to decide which one unmounts. Keying on `isOpen` means the swap is
  // instant (a navigation inside an open surface, not a dismissal) and every
  // actual close animates exactly once.
  const { mounted, presenceProps } = usePresence(isOpen);

  const { t } = useLocale();
  const handleToggle = () => {
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setOpenUp(window.innerHeight - rect.bottom < 300);
    }
    setIsOpen(!isOpen);
  };

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
      // Dialogs (e.g. the portaled create-playlist dialog) live outside
      // the menu container by design; interacting with one must never
      // collapse the menu underneath it.
      const target = e.target as Element | null;
      if (target?.closest?.('[role="dialog"]')) {
        return;
      }
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
    <div ref={containerRef} className={`relative shrink-0 ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("menus.actionsFor", { title: track.title })}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleToggle}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {mounted && !showPlaylistMenu ? (
        <TrackActionMenuContent
          track={track}
          onClose={handleClose}
          onLikeToggle={showLike ? onLikeToggle : undefined}
          isLiked={isLiked}
          showAddToPlaylist={showAddToPlaylist}
          onAddToPlaylist={showAddToPlaylist ? handleAddToPlaylist : undefined}
          openUp={openUp}
          presenceProps={presenceProps}
        />
      ) : null}
      {mounted && showPlaylistMenu ? (
        <AddToPlaylistMenu
          track={track}
          onClose={handlePlaylistMenuClose}
          openUp={openUp}
          presenceProps={presenceProps}
        />
      ) : null}
    </div>
  );
}
