"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { CheckIcon, PlusIcon, SkipForwardIcon, ListMusicIcon, RadioIcon } from "@/components/ui/icons";
import { getRadioSession } from "@/lib/radio/instance";
import { useLocale } from "@/components/i18n/locale-provider";
import { usePresence } from "@/components/ui/presence";
import { useMenuOpenUp } from "@/components/ui/menu-placement";
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
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none active:bg-surface-2"
      >
        <SkipForwardIcon size={16} className="text-text-muted" />
        <span>{t("menus.playNext")}</span>
      </button>
      <button
        ref={(el) => { if (el) itemsRef.current[itemIdx] = el; itemIdx++; }}
        type="button"
        role="menuitem"
        onClick={handleAddToQueue}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none active:bg-surface-2"
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
        className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none active:bg-surface-2"
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
          className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none active:bg-surface-2"
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
          className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none active:bg-surface-2"
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
  // Which way this menu opens is not a property of the host - it is decided
  // from the surface that was actually rendered, so the taller playlist
  // picker cannot be assumed to fit in the room the short row menu needed.
  // See `menu-placement.ts` for why it is measured rather than guessed.
  //
  // `placementKey` is what makes that true in practice. The picker REPLACES
  // the row menu in the same slot while `mounted` stays true, so without a key
  // that changes on the swap the effect never re-runs: the height measured is
  // the row menu's, and a verdict computed for a 5-item menu gets applied to
  // the ~130px taller picker. That is not a cosmetic difference - the picker
  // then extends past the room the verdict cleared and its lower items land
  // under the fixed player bar, where they are visible but unclickable, and
  // "add to playlist" fails for exactly the users with the most playlists.
  const openUp = useMenuOpenUp({
    open: mounted,
    triggerRef,
    surfaceRef: containerRef,
    placementKey: showPlaylistMenu ? "playlist-picker" : "row-menu",
  });

  const handleToggle = () => {
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
      // collapse the menu underneath it. "Outside" means outside the dialog
      // that HOSTS this trigger, though: a row menu can be opened inside the
      // queue panel or the full player, and those are dialogs too. Testing for
      // any dialog made every click inside the hosting panel exempt, so the
      // menu could not be dismissed by clicking anywhere else in it.
      const target = e.target as Element | null;
      const host = triggerRef.current?.closest('[role="dialog"]') ?? null;
      const clicked = target?.closest?.('[role="dialog"]') ?? null;
      if (clicked && clicked !== host) {
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
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors aurora-press hover:bg-surface-2 hover:text-text-primary"
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
