"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useContext,
  useLayoutEffect,
  createContext,
} from "react";
import { createPortal } from "react-dom";
import { usePresence } from "@/components/ui/presence";
import { useMenuOpenUp, MENU_TRIGGER_GAP_PX } from "@/components/ui/menu-placement";
import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl, type Track } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { identityToTrack } from "@/lib/music/identity-track";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { focusFirstByLabel, useFocusTrap } from "@/components/ui/focus";
import { AddToPlaylistMenu } from "@/components/tracks/add-to-playlist-menu";
import { getRadioSession, subscribeRadioSession } from "@/lib/radio/instance";
import { KeepListeningToggle } from "@/components/player/keep-listening-toggle";
import { AutoplayButton } from "@/components/player/autoplay-button";
import { useLocale } from "@/components/i18n/locale-provider";
import { useSyncExternalStore } from "react";
import { ArrowDownIcon, ArrowUpIcon, ListMusicIcon, PauseIcon, PlayIcon, QueueIcon, RadioIcon, XIcon } from "@/components/ui/icons";

/**
 * The panel's own menu layer, handed to every row menu below `lg`.
 *
 * WHY A LAYER AT ALL. The queue list is a scroll container - it has to be,
 * the queue is unbounded and the panel is not - and a scroll container clips
 * everything inside it, including a menu that opens downward from a row near
 * the bottom of the visible list. The row menu is ~200px tall and the list
 * is ~420px tall, so a row in the middle of the list has less than 200px on
 * either side: no amount of flipping fits. A surface has to LEAVE the
 * scroller, and the only place it can go without losing the panel's stacking
 * context (and with it, the ordering against the page behind) is the panel
 * itself. So the panel owns an empty, click-through layer that sits above
 * its scroll content, and the row menus render into it.
 *
 * `pointer-events-none` keeps the layer from becoming an invisible shield
 * over the rows: the layer is the full panel box, and the surface is the
 * only thing in it that takes pointer events.
 */
const QueueMenuLayerContext = createContext<HTMLElement | null>(null);

/**
 * Where a row's menu goes, in the layer's own coordinate space.
 *
 * The layer is `absolute inset-0` on the panel, so it is the positioning
 * context for what is rendered into it and these are offsets from the
 * panel's padding box. They are kept together (rather than a `top` or a
 * `bottom` chosen at render time) because which side the menu opens on is
 * itself decided from the rendered surface - `useMenuOpenUp` - and the
 * offsets have to answer both questions.
 */
interface QueueMenuPlacement {
  right: number;
  top: number;
  bottom: number;
}

function QueueItemMenu({
  position,
  track,
  trackTitle,
  disabled,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  position: number;
  track: Track;
  trackTitle: string;
  disabled?: boolean;
  // Phase 54: reordering moved into this menu for viewports too narrow to
  // afford a visible drag handle. See the note on the move buttons in
  // `renderRow` for the measurement behind that decision.
  onMove?: (direction: "up" | "down") => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showPlaylistMenu, setShowPlaylistMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  /** The portaled surface, whichever of the two is in the slot right now. */
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layer = useContext(QueueMenuLayerContext);
  const [placement, setPlacement] = useState<QueueMenuPlacement | null>(null);
  // One lifecycle for the row's open region (Phase 48), owned here for the
  // same reason as in `TrackActionMenu`: the menu and the picker share one
  // slot, so a single exit timer must decide which of them unmounts.
  const {
    mounted: menuMounted,
    presenceProps: menuPresence,
  } = usePresence(isOpen);
  const engine = useMusicEngine();
  const { t } = useLocale();
  const removeFromQueue = (position: number) => engine?.queue.remove(position);
  // Same rule as every other menu in the product (`menu-placement.ts`),
  // measured against the surface this panel actually rendered.
  const openUp = useMenuOpenUp({
    open: menuMounted,
    triggerRef,
    surfaceRef,
    placementKey: showPlaylistMenu ? "playlist" : "actions",
  });
  const surfaceStyle = placement
    ? openUp
      ? { bottom: placement.bottom, right: placement.right }
      : { top: placement.top, right: placement.right }
    : undefined;

  useLayoutEffect(() => {
    if (!menuMounted || !layer) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    // Right edge to the trigger's right edge, exactly the `right-0` the
    // in-flow menus get for free from their own wrapper. Both sides are
    // measured because which one is used is decided after the surface has
    // been rendered (see `openUp` above).
    setPlacement({
      right: layerRect.right - triggerRect.right,
      top: triggerRect.bottom - layerRect.top + MENU_TRIGGER_GAP_PX,
      bottom: layerRect.bottom - triggerRect.top + MENU_TRIGGER_GAP_PX,
    });
  }, [layer, menuMounted, showPlaylistMenu]);

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
      // The portaled create-playlist dialog lives outside the menu
      // container by design; interacting with it must not collapse
      // the queue menu underneath. "Outside" means outside the dialog that
      // HOSTS this row, though - the queue panel is itself a dialog, so
      // testing for any dialog made every click inside the panel exempt and
      // left the row menu with no way to be dismissed but Escape.
      const target = e.target as Element | null;
      const host = triggerRef.current?.closest('[role="dialog"]') ?? null;
      const clicked = target?.closest?.('[role="dialog"]') ?? null;
      if (clicked && clicked !== host) {
        return;
      }
      // Two containers, because the surface is in one and the trigger in the
      // other: a click on either is inside the menu, anything else is not.
      const node = e.target as Node;
      const inside =
        menuRef.current?.contains(node) === true ||
        surfaceRef.current?.contains(node) === true;
      if (!inside) {
        setShowPlaylistMenu(false);
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // While the playlist picker is open it owns Escape (and the
        // portaled dialog owns its own); swallowing it here would yank
        // the whole row menu out from under them.
        if (showPlaylistMenu) {
          return;
        }
        e.preventDefault();
        // Consume before the panel-level handler (registered earlier, on
        // bubble): closing a row menu must not close the whole panel.
        e.stopPropagation();
        setIsOpen(false);
      }
    }

    // The surface is anchored to a row, not to the panel, so anything that
    // moves the row under it has to dismiss it. An in-flow menu gets this for
    // free - it is painted inside the row, so it travels with it - which is
    // exactly why a menu rendered in the layer has to be told.
    function handleAnchorMoved() {
      setShowPlaylistMenu(false);
      setIsOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown, true);
    // Capture phase: the list scrolls on its own element, and an event that
    // never bubbles to `window` would not reach a bubble-phase listener.
    window.addEventListener("scroll", handleAnchorMoved, true);
    window.addEventListener("resize", handleAnchorMoved);
    itemRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleAnchorMoved, true);
      window.removeEventListener("resize", handleAnchorMoved);
    };
  }, [isOpen, showPlaylistMenu]);

  if (disabled) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("menus.actionsFor", { title: trackTitle })}
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
      {/* The surface is rendered into the panel's own layer, not here. See
          `QueueMenuLayerContext`: the rows live in a scroll container, and a
          menu that stays inside one is cut off by it. */}
      {menuMounted && layer
        ? createPortal(
            showPlaylistMenu ? (
              <AddToPlaylistMenu
                track={track}
                onClose={() => {
                  setShowPlaylistMenu(false);
                  setIsOpen(false);
                }}
                openUp={openUp}
                presenceProps={menuPresence}
                placement={surfaceStyle}
                surfaceRef={surfaceRef}
              />
            ) : (
              <div
                ref={surfaceRef}
                role="menu"
                aria-label={t("menus.trackActions")}
                {...menuPresence}
                className={`${openUp ? "presence-menu-up" : "presence-menu"} aurora-glass-float pointer-events-auto absolute z-dropdown w-48 overflow-hidden rounded-lg border border-border-subtle`}
                style={surfaceStyle}
              >
                <button
                  ref={itemRef}
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPlaylistMenu(true);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
                >
                  <ListMusicIcon size={16} className="text-text-muted" />
                  <span>{t("menus.addToPlaylist")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={t("menus.startRadioFor", { title: trackTitle })}
                  onClick={(e) => {
                    e.stopPropagation();
                    const session = getRadioSession();
                    if (engine && session) {
                      void session.startTrackRadio(engine, track, {
                        key: "radio.labelFromTrack",
                        params: { title: trackTitle },
                      });
                    }
                    setIsOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
                >
                  <RadioIcon size={16} className="text-text-muted" />
                  <span>{t("menus.startRadio")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canMoveUp}
                  aria-label={t("queue.moveUp", { title: trackTitle })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove?.("up");
                    setIsOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <ArrowUpIcon size={16} className="text-text-muted" />
                  <span>{t("queue.moveUpShort")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canMoveDown}
                  aria-label={t("queue.moveDown", { title: trackTitle })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove?.("down");
                    setIsOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <ArrowDownIcon size={16} className="text-text-muted" />
                  <span>{t("queue.moveDownShort")}</span>
                </button>
                <button
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
                  <span>{t("queue.removeFromQueue")}</span>
                </button>
              </div>
            ),
            layer,
          )
        : null}
    </div>
  );
}

/**
 * Is the queue a wide side panel? (Phase 54)
 *
 * The queue is TWO different surfaces wearing one component: a modal bottom
 * sheet below `lg`, and a non-modal side panel at `lg` and up. Everything that
 * must differ between them - `aria-modal`, a focus trap, the scrim, the
 * scroll lock - depends on which one is mounted, and a CSS class cannot
 * decide it. So it is decided here, from the same `lg` boundary the CSS uses
 * (`min-width: 1024px`), and read through `useSyncExternalStore` like the
 * radio status above rather than through a resize listener in an effect that
 * would repaint the tree.
 *
 * A module-level store, because `useSyncExternalStore` calls `subscribe` once
 * per mount: allocating a fresh `MediaQueryList` inside a component body
 * would resubscribe on every render.
 */
const WIDE_QUEUE_QUERY = "(min-width: 1024px)";
let wideQueueMql: MediaQueryList | null = null;
const wideQueueListeners = new Set<() => void>();

function wideQueueMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) {
    return null;
  }
  if (!wideQueueMql) {
    wideQueueMql = window.matchMedia(WIDE_QUEUE_QUERY);
    wideQueueMql.addEventListener("change", () => {
      for (const listener of wideQueueListeners) listener();
    });
  }
  return wideQueueMql;
}

function readIsWideQueue(): boolean {
  return wideQueueMedia()?.matches ?? false;
}

function subscribeIsWideQueue(onStoreChange: () => void): () => void {
  const media = wideQueueMedia();
  if (!media) {
    return () => {};
  }
  wideQueueListeners.add(onStoreChange);
  return () => {
    wideQueueListeners.delete(onStoreChange);
  };
}

function useIsWideQueue(): boolean {
  return useSyncExternalStore(subscribeIsWideQueue, readIsWideQueue, () => false);
}

function useRadioStatus() {
  // getSnapshot returns the session's stable state reference (never a
  // fresh object per call); field selection happens during render.
  const state = useSyncExternalStore(
    subscribeRadioSession,
    () => getRadioSession()?.getState() ?? null,
    () => null,
  );
  if (!state || !state.active) {
    return null;
  }
  return {
    label: state.label,
    generating: state.generating,
    exhausted: state.exhausted,
  };
}

export function QueuePanel() {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const radioStatus = useRadioStatus();
  // Phase 54: decides whether this instance is a modal sheet or a non-modal
  // side panel. See the store above - the two are genuinely different
  // surfaces, not one surface styled twice.
  const isWideQueue = useIsWideQueue();
  // Panel visibility is local UI chrome state, not engine state.
  const isQueueOpen = usePlayerStore((s) => s.isQueueOpen);
  const closeQueue = usePlayerStore((s) => s.closeQueue);
  const identities = useMusicEngineState((s) => s.queue);
  // Subscribe to the engine's published playOrder, not the queue facade's
  // queue.playOrder. The facade getter is a plain read outside any
  // subscription, and s.queue is reference-stable across a reorder by
  // design — so useSyncExternalStore bailed out and Move Up/Down and the
  // shuffle toggle silently repainted nothing while the model had changed.
  const playOrder = useMusicEngineState((s) => s.playOrder);
  const position = useMusicEngineState((s) => s.currentIndex);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const listRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The layer is published as state, not a ref, because the row menus read
  // it during render: a ref would be null on the render that first puts the
  // layer on screen, and the callback ref fires again on every remount.
  const [menuLayer, setMenuLayer] = useState<HTMLElement | null>(null);
  const { mounted: queueMounted, presenceProps: queuePresence } =
    usePresence(isQueueOpen);

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
    focusFirstByLabel(t("queue.upNext"));
  }, [closeQueue, t]);

  // Phase 54: the sheet is modal, so it behaves like one.
  //
  // A 70svh panel floating over a still-scrollable page, with no scrim, no
  // `aria-modal` and no Tab trap, is the worst of both: a phone user can
  // scroll the page out from under the sheet with a thumb that was meant for
  // the list, and a keyboard user can Tab into controls behind a surface that
  // has already covered them. All three are cheap to fix and all three are
  // false at `lg`, where this is a side panel and blocking the page would be
  // wrong - so every one of them is gated on `!isWideQueue` rather than on a
  // media query in CSS, because a focus trap cannot be expressed in CSS.
  const isModalQueue = isQueueOpen && !isWideQueue;
  useFocusTrap(dialogRef, isModalQueue);

  useEffect(() => {
    if (!isModalQueue) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isModalQueue]);

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

  // Presence (Phase 48). The panel is a bottom-anchored sheet on mobile and a
  // right-hand panel on desktop, so it gets the `sheet` vocabulary: it rises
  // from its own bottom edge rather than scaling, because a queue that grows
  // while it opens reads as a different panel.
  //
  // Note what the effect above is keyed on. Keyboard handling, focus return
  // and the open-trigger scroll all stop at CLOSE REQUEST, while the panel
  // itself stays mounted for the length of its exit. That ordering is the
  // point: an exiting panel must not keep listening for keys or keep pulling
  // focus, and it must not eat clicks either — which the
  // `[data-presence="exiting"]` pointer-events rule in `globals.css` handles
  // for the 140ms it is still on screen.
  if (!queueMounted) {
    return null;
  }

  const items = playOrder.map((queueIndex, pos) => ({
    pos,
    queueIndex,
    track: identities[queueIndex],
  }));

  const currentItem = items.find(({ pos }) => pos === position) ?? null;
  const upcoming = items.filter(({ pos }) => (currentItem ? pos !== position : true));

  const renderRow = ({ pos, track }: { pos: number; track: (typeof items)[number]["track"] }) => {
    if (!track) {
      return null;
    }
    const artistName = track.artists[0]?.name ?? "";
    const artworkUrl = resolveArtworkUrl(track.artwork);
    const trackId = `${track.primarySource.source}:${track.primarySource.id}`;
    const isCurrent = pos === position;
    const actionLabel =
      isCurrent && isPlaying
        ? t("queue.pauseLabel", { title: track.title })
        : t("queue.playLabel", { title: track.title });
    const handleClick = () => {
      if (isCurrent && isPlaying) {
        engine?.pause();
        return;
      }
      playAtPosition(pos);
    };
    // Keyed by play-order position, which is unique per rendered row. The
    // queue itself holds one entry per canonical track, so this is not
    // disambiguating repeated tracks - it is what keeps a row's identity
    // stable while the user drags it, and unique while the order changes.
    return (
      <li
        key={`queue-pos-${pos}:${trackId}`}
        ref={isCurrent ? currentRef : undefined}
      >
        <div
          className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
            isCurrent ? "bg-accent-muted/70" : "hover:bg-surface-hover"
          }`}
        >
          <Artwork src={artworkUrl} alt="" size="thumbnail" pixelSize={40} />
          <div className="min-w-0 flex-1">
            <p
              className={`truncate text-sm font-medium ${
                isCurrent ? "text-accent-hover" : "text-text-primary"
              }`}
            >
              {track.title}
            </p>
            <p className="truncate text-xs text-text-muted">
              {isCurrent ? t("queue.nowPlaying") : artistName}
            </p>
          </div>
          <button
            type="button"
            aria-label={actionLabel}
            onClick={handleClick}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-primary transition-colors hover:bg-surface-active"
          >
            {isCurrent && isPlaying ? (
              <PauseIcon size={18} />
            ) : (
              <PlayIcon size={18} />
            )}
          </button>
          {/* The Move up / Move down pair stays `hidden sm:flex` (Phase 54).

              That `sm` boundary was the defect: below 640px the queue could
              not be reordered AT ALL, so a capability that exists on a
              desktop and a tablet silently did not exist on a phone.

              The fix is not to add two more 44px buttons to the row. Measured
              at 360px: the sheet is 328px wide, minus 8px of list padding and
              12px of row padding, leaving 288px. The row already spends
              40px artwork + 44px play + 44px overflow on 164px including
              gaps, which leaves 124px for the title and artist. Two more
              44px buttons plus a gap cost 100px of that, leaving 24px - and a
              44px drag handle instead of the pair would still cost 56px,
              leaving 68px. A queue whose rows show an artwork and four icons
              and no track name is not a queue.

              So below `sm` reordering moves into the row's overflow menu,
              which is already on screen at zero additional width cost, is a
              real menu (arrow keys, Escape, focus return) rather than a
              gesture, and is the platform convention for secondary row
              actions. Above `sm` the visible pair remains, because on a
              pointer device a visible control beats a menu.

              Drag-to-reorder is deliberately NOT implemented. A drag needs a
              visible handle to be discoverable and to avoid conflicting with
              list scrolling, and there is no width for one at 360px. See
              `docs/scope-boundaries.md`. */}
          <div className="hidden items-center sm:flex">
            <button
              type="button"
              aria-label={t("queue.moveUp", { title: track.title })}
              disabled={pos === 0}
              onClick={(e) => {
                e.stopPropagation();
                moveQueueItem(pos, "up");
              }}
              className="aurora-touch grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUpIcon size={16} />
            </button>
            <button
              type="button"
              aria-label={t("queue.moveDown", { title: track.title })}
              disabled={pos === items.length - 1}
              onClick={(e) => {
                e.stopPropagation();
                moveQueueItem(pos, "down");
              }}
              className="aurora-touch grid h-10 w-10 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowDownIcon size={16} />
            </button>
          </div>
          {!isCurrent && track ? (
            <QueueItemMenu
              position={pos}
              track={identityToTrack(track)}
              trackTitle={track.title}
              disabled={isCurrent}
              onMove={(direction) => moveQueueItem(pos, direction)}
              canMoveUp={pos > 0}
              canMoveDown={pos < items.length - 1}
            />
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <>
      {/* Phase 54: the scrim, and only on the surface that is modal.
          `lg:hidden` is not a simplification - at `lg` the queue is a side
          panel beside the page, and dimming the page behind it would be
          wrong, so the scrim must not exist there at all. It carries the
          same `presence-backdrop` lifecycle as the panel so both enter and
          leave together, and it sits at the same `z-dialog` in the same
          stacking context one node earlier, so the panel always wins the
          tie without needing a token between 90 and 90. */}
      <div
        aria-hidden="true"
        onClick={closeAndRestoreFocus}
        {...queuePresence}
        className="presence-backdrop fixed inset-0 z-dialog bg-black/40 lg:hidden"
      />
      <QueueMenuLayerContext.Provider value={menuLayer}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t("queue.dialog")}
        // Truthful only on the sheet: at `lg` the page behind is meant to
        // stay reachable.
        aria-modal={isWideQueue ? undefined : true}
        tabIndex={-1}
        {...queuePresence}
        // The queue is ONE floating surface with a controlled shadow - not a
        // stack of glass cards, one per row (Phase 53, §30). Fifty rows each
        // carrying their own `backdrop-filter` is the single most expensive
        // thing this feature could have done, and it would have looked like
        // confetti. The rows keep plain hover tints; the panel is the glass.
        // `aurora-glass-float` replaces `bg-surface-elevated shadow-lg` and both
        // are removed rather than left behind.
        //
        // Phase 54: `max-h` is now bounded from the TOP as well as the bottom.
        // The sheet is anchored `bottom-[calc(9rem + inset)]` with
        // `max-h-[70svh]`, and 70svh of a 375px-tall landscape phone is 262px,
        // which fits - but of a 320px viewport (a small phone with the browser
        // chrome open) 70svh plus the 9rem anchor exceeds the screen and the
        // header row rendered off the top with no way to scroll to it. Capping
        // against the space actually available between the anchor and the
        // safe-area top makes the sheet fit by construction.
        //
        // No `overflow-hidden`, and that is deliberate: a row menu renders
        // into the layer below so it can be bigger than the list it opened
        // from, and the panel clipping its own layer would put the clipping
        // back one level up. The rounded corners never needed it —
        // `rounded-2xl` clips this element's own background and border.
        className="presence-sheet aurora-glass-float fixed bottom-[calc(9rem+env(safe-area-inset-bottom))] z-dialog mx-auto flex max-h-[min(70svh,calc(100dvh-9rem-env(safe-area-inset-bottom)-env(safe-area-inset-top)))] w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md flex-col rounded-2xl border border-border-subtle sm:bottom-[calc(9.5rem+env(safe-area-inset-bottom))] lg:bottom-[calc(6rem+1.5rem)] lg:right-6 lg:left-auto lg:mx-0 lg:w-96 focus:outline-none"
      >
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <QueueIcon size={18} className="text-text-muted" />
        <h2 className="min-w-0 text-sm font-semibold text-text-primary">
          {t("queue.title")}
          <span className="ml-2 text-xs font-normal text-text-muted">
            {items.length === 1
              ? t("queue.tracksCountOne")
              : t("queue.tracksCount", { count: items.length })}
          </span>
          {radioStatus?.label ? (
            <span className="mt-0.5 block truncate text-xs font-normal text-accent">
              {t(radioStatus.label.key, radioStatus.label.params)}
            </span>
          ) : null}
        </h2>
        <span className="flex-1" />
        <AutoplayButton size={18} />
        <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={t("queue.close")} onClick={closeAndRestoreFocus}>
          <XIcon size={18} />
        </Button>
      </div>
      {radioStatus?.generating ? (
        <p role="status" className="border-b border-border-subtle px-4 py-2 text-xs text-text-muted">
          {t("radio.findingMore")}
        </p>
      ) : null}
      {radioStatus && !radioStatus.generating && radioStatus.exhausted ? (
        <p role="status" className="border-b border-border-subtle px-4 py-2 text-xs text-text-muted">
          {t("radio.ranOut")}
        </p>
      ) : null}
      {/* Phase 47: the one primary "Keep listening" control. `useRadioStatus`
          returns null when no station is active, so this condition is exactly
          "radio is not driving the queue" — radio's own generation is
          authoritative then, and a second continuation toggle would be two
          competing controls for one queue (§55). */}
      {items.length > 0 && !radioStatus ? (
        <KeepListeningToggle />
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">{t("queue.emptyTitle")}</p>
          <p className="max-w-xs text-xs leading-relaxed text-text-muted">
            {t("queue.emptyDescription")}
          </p>
        </div>
      ) : (
        // `overscroll-contain`: the queue is a sheet over a page the user can
        // still see, and it is the highest-frequency scroll area in the
        // product - a long queue is normal, not exceptional. Reaching the end
        // of it and continuing would scroll the page behind the sheet, which
        // reads as the sheet drifting. Containing it also stops a trackpad
        // flick from chaining out of a 70svh panel, which is short enough that
        // the end is easy to hit by accident.
        <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {currentItem?.track ? (
            <section aria-label={t("queue.nowPlayingSection")} className="mb-2">
              <p className="t-caption px-2 pb-1 font-semibold uppercase tracking-[0.12em]">
                {t("queue.nowPlayingHeading")}
              </p>
              <ul>{renderRow({ pos: currentItem.pos, track: currentItem.track })}</ul>
            </section>
          ) : null}
          {upcoming.length > 0 ? (
            <section aria-label={t("queue.nextUpSection")}>
              <p className="t-caption px-2 pb-1 font-semibold uppercase tracking-[0.12em]">
                {t("queue.nextUpHeading")}
              </p>
              <ul className="flex flex-col gap-0.5">
                {upcoming.map(({ pos, track }) => renderRow({ pos, track }))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
        {/* The menu layer, last so it paints above the list. Empty and
            click-through: it exists so a row menu has somewhere to render
            that the list's `overflow-y-auto` cannot cut off. Deliberately
            NOT `aria-hidden`: the surfaces inside it are the panel's own
            menus, and hiding the container would hide every menu item from
            assistive technology along with it. */}
        <div
          ref={setMenuLayer}
          data-queue-menu-layer
          className="pointer-events-none absolute inset-0 z-dropdown"
        />
      </div>
      </QueueMenuLayerContext.Provider>
    </>
  );
}
