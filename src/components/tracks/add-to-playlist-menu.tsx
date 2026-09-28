"use client";

import { Suspense, lazy, useState, useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Track, Playlist } from "@/lib/domain";
import { requestAuthPrompt } from "@/components/tracks/liked-tracks";
import { useLocale } from "@/components/i18n/locale-provider";
import { CheckIcon, PlusIcon, SearchIcon } from "@/components/ui/icons";

// Lazy boundaries (same pattern as the like toggle): merely rendering
// the picker never pulls the playlist server-action module graph, so
// every consumer (rows, player, queue) stays hermetic in tests and the
// browser only fetches it when the user actually organizes music.
async function playlistActions() {
  return import("@/app/actions/playlist");
}

const CreatePlaylistDialog = lazy(() =>
  import("@/components/playlist/create-playlist-dialog").then((module) => ({
    default: module.CreatePlaylistDialog,
  })),
);

/** Playlist search appears only when the list is long enough to need it. */
const PLAYLIST_SEARCH_THRESHOLD = 6;

function isAlreadyMember(playlist: Playlist, track: Track): boolean {
  const trackId = track.providerTrackId ?? track.id;
  return playlist.items.some(
    (item) => item.provider === track.provider && item.trackId === trackId,
  );
}

export function AddToPlaylistMenu({
  track,
  onClose,
  openUp = false,
  presenceProps,
  placement,
  surfaceRef,
}: {
  track: Track;
  onClose: () => void;
  /** Mirror the parent menu direction so the picker never sits off-screen. */
  openUp?: boolean;
  /**
   * Presence lifecycle, owned by the host (Phase 48). The picker is one of
   * two mutually exclusive children in the same slot, so it inherits the
   * host's single exit timer rather than starting a second one. When omitted
   * the picker still works, it simply has no enter/exit motion — which is
   * what any test that renders it directly will see.
   */
  presenceProps?: { "data-presence": "entering" | "entered" | "exiting"; inert: boolean };
  /**
   * Explicit offsets, supplied by a host that places the surface itself.
   *
   * The default is the `absolute right-0 top-full` shorthand, which is only
   * correct when the picker's own trigger is its positioning context. The
   * queue renders this picker inside the panel's menu layer - its rows live
   * in a scroll container, and a surface that stays inside one gets cut off
   * by it - so the panel measures the trigger and hands the offsets over
   * instead. See `queue-panel.tsx`.
   */
  placement?: CSSProperties;
  /**
   * The surface element, for a host that has to measure it. The picker is
   * the tallest thing that can appear in a menu slot - a header, a search
   * box and a scrolling list - so a host that positions the surface itself
   * cannot assume the room the shorter row menu needed. Omitted by hosts
   * that anchor the picker to its own trigger, where CSS decides.
   */
  surfaceRef?: RefObject<HTMLDivElement | null>;
}) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Benign membership notice (e.g. authoritative duplicate), announced politely. */
  const [notice, setNotice] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Synchronous in-flight guard: state updates don't flush between
  // same-tick double clicks/taps, so the ref (not the state) owns the
  // double-submit decision. The backend unique constraint stays
  // authoritative regardless.
  const pendingRef = useRef<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { t } = useLocale();
  const itemsRef = useRef<HTMLButtonElement[]>([]);
  // Owns the post-success auto-close timer so it can be cancelled on
  // unmount. Previously the handle was dropped, so unmounting inside the
  // 800 ms window (Escape, backdrop, parent close) still fired `onClose`
  // against a parent whose menu the user may have already re-opened.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const scheduleClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 800);
  };

  const focusItem = (index: number) => {
    const items = itemsRef.current;
    if (items.length === 0) return;
    const next = index < 0 ? items.length - 1 : index >= items.length ? 0 : index;
    items[next]?.focus();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The create dialog manages its own Escape; don't yank the
        // picker out from under it.
        if (showCreateDialog) {
          return;
        }
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
  }, [onClose, showCreateDialog]);

  // Phase 49. A server action's *body* try/catches and resolves `{ok:false}`,
  // but the transport rejects on a network drop or navigation abort. Nothing
  // guarded that, so the reject skipped `setLoading(false)` and the render
  // showed "Loading playlists…" forever - and because `loading` is tested
  // before `error`, the Retry button could never render, leaving the user no
  // escape without a full reload.
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { listUserPlaylistsAction } = await playlistActions();
      const result = await listUserPlaylistsAction();
      if (!aliveRef.current) return;
      if (result.ok && result.playlists) {
        setPlaylists(result.playlists);
      } else {
        setError(t("playlist.loadPlaylistsError"));
      }
    } catch {
      if (aliveRef.current) {
        setError(t("playlist.loadPlaylistsError"));
      }
    } finally {
      if (aliveRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const { listUserPlaylistsAction } = await playlistActions();
        const result = await listUserPlaylistsAction();
        if (cancelled) return;
        if (result.ok && result.playlists) {
          setPlaylists(result.playlists);
        } else {
          setError(t("playlist.loadPlaylistsError"));
        }
      } catch {
        if (!cancelled) {
          setError(t("playlist.loadPlaylistsError"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    if (!loading) {
      // Items (or the trailing Create action when the list is empty)
      // arrive asynchronously; move focus in once they render.
      itemsRef.current[0]?.focus();
    }
  }, [loading, playlists.length]);

  // Phase 49. `pendingRef`/`setPendingId(null)` sat after the awaits, so a
  // transport rejection left the row permanently `disabled` with no error
  // shown. try/finally makes the in-flight guard always release.
  const handleAddToPlaylist = async (playlistId: string) => {
    if (pendingRef.current !== null) {
      return;
    }
    pendingRef.current = playlistId;
    setPendingId(playlistId);
    setError(null);
    setNotice(null);
    try {
      const { addTrackToPlaylistAction } = await playlistActions();
      const result = await addTrackToPlaylistAction(playlistId, track);
      if (!aliveRef.current) return;
      if (result.ok) {
        setSuccessId(playlistId);
        scheduleClose();
      } else if (result.conflict) {
        // Authoritative duplicate: announce it once AND refresh
        // membership so the row flips to its honest "already added"
        // state. Never destructive, never a red error.
        setError(null);
        setNotice(t("playlist.duplicateConflict"));
        await load();
      } else {
        // Server strings stay server-side; the UI shows the curated text.
        setError(t("playlist.addTrackError"));
      }
    } catch {
      if (aliveRef.current) {
        setError(t("playlist.addTrackError"));
      }
    } finally {
      pendingRef.current = null;
      if (aliveRef.current) {
        setPendingId(null);
      }
    }
  };

  const handleCreateNew = () => {
    setShowCreateDialog(true);
  };

  // Create → auto-add flow: the track joins the new playlist without
  // leaving context. Partial failure is reported honestly — never
  // presented as success.
  const handleCreated = async (playlistId: string) => {
    setShowCreateDialog(false);
    setPendingId(playlistId);
    try {
      const { addTrackToPlaylistAction } = await playlistActions();
      const result = await addTrackToPlaylistAction(playlistId, track);
      if (!aliveRef.current) return;
      if (result.ok) {
        await load();
        setSuccessId(playlistId);
        scheduleClose();
      } else {
        await load();
        setError(
          result.conflict
            ? t("playlist.createAddPartialCreated")
            : t("playlist.createAddPartialFailed"),
        );
      }
    } catch {
      if (aliveRef.current) {
        setError(t("playlist.createAddPartialFailed"));
      }
    } finally {
      if (aliveRef.current) {
        setPendingId(null);
      }
    }
  };

  const handleCreateDialogClose = () => {
    setShowCreateDialog(false);
    void load();
  };

  const query = filter.trim().toLowerCase();
  const visiblePlaylists =
    query.length === 0
      ? playlists
      : playlists.filter((playlist) =>
          playlist.title.toLowerCase().includes(query),
        );

  return (
    <>
      <div
        ref={surfaceRef}
        role="menu"
        aria-label={t("playlist.addToPlaylistTitle")}
        {...presenceProps}
        className={`${openUp ? "presence-menu-up" : "presence-menu"} aurora-glass-float absolute z-dropdown w-60 overflow-hidden rounded-lg border border-border-subtle ${
          // `right-0` is load-bearing and was lost from the no-`placement`
          // branch. This picker is 240px wide and every trigger that opens it
          // from a row sits at the RIGHT edge of that row, so the default
          // static-position left edge (x = trigger left) pushed it 138-162px
          // past the viewport on both phone and desktop - "Add to playlist"
          // opened half off-screen. The docstring above already names
          // `absolute right-0 top-full` as the contract; this restores it.
          // The queue passes explicit `placement`, so it is untouched.
          placement ? "" : `right-0 ${openUp ? "bottom-full mb-1" : "top-full mt-1"}`
        }`}
        style={placement}
      >
        <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-text-muted">
          {t("playlist.addToPlaylist")}
        </div>

        {notice && !loading && !error ? (
          <p role="status" className="border-b border-border-subtle px-3 py-2 text-xs text-text-secondary">
            {notice}
          </p>
        ) : null}

        {playlists.length > PLAYLIST_SEARCH_THRESHOLD && !loading && !error ? (
          <div className="relative border-b border-border-subtle">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
              <SearchIcon size={14} />
            </span>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("playlist.searchPlaylists")}
              aria-label={t("playlist.searchPlaylistsLabel")}
              className="h-10 w-full bg-transparent pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
          </div>
        ) : null}

        {loading ? (
          <div className="px-3 py-4 text-center text-sm text-text-muted" role="status">
            {t("playlist.loadingPlaylists")}
          </div>
        ) : error ? (
          <div className="flex flex-col gap-2 px-3 py-4 text-center">
            <p role="alert" className="text-sm text-red-400">{error}</p>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-full border border-border-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent/50"
              >
                {t("common.retry")}
              </button>
              <button
                type="button"
                onClick={requestAuthPrompt}
                className="rounded-full border border-border-strong px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent/50"
              >
                {t("auth.signIn")}
              </button>
            </div>
          </div>
        ) : (
          // `overscroll-contain` is load-bearing here more than anywhere else.
          // This list is capped at `max-h-60` - 240px - so for anyone with more
          // than a handful of playlists it is already scrolled to its end the
          // moment it opens, and a trackpad flick over a 240px list chains
          // straight into the page underneath. The menu would appear to shove
          // the page down while the user believed they were still inside it.
          <div className="max-h-60 overflow-y-auto overscroll-contain py-1">
            {visiblePlaylists.map((playlist) => {
              const alreadyAdded =
                successId === playlist.id || isAlreadyMember(playlist, track);
              const pending = pendingId === playlist.id;
              return (
                <button
                  key={playlist.id}
                  ref={(el) => {
                    if (el) itemsRef.current[visiblePlaylists.indexOf(playlist)] = el;
                  }}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAddToPlaylist(playlist.id)}
                  disabled={alreadyAdded || pending}
                  // The spinner below is the visible half of the pending state;
                  // this is the part assistive technology can reach. The label
                  // already changes to "adding…" on the same condition, so the
                  // two cannot disagree about whether a request is in flight.
                  aria-busy={pending || undefined}
                  aria-label={
                    alreadyAdded
                      ? t("playlist.alreadyAddedLabel", { title: playlist.title })
                      : pending
                        ? t("playlist.addingToLabel", { title: playlist.title })
                        : t("playlist.addToLabel", { title: playlist.title })
                  }
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
                >
                  {alreadyAdded ? (
                    <CheckIcon size={16} className="shrink-0 text-accent" />
                  ) : pending ? (
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-text-muted border-t-transparent"
                    />
                  ) : (
                    <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">
                    {playlist.title}
                    {alreadyAdded ? (
                      <span className="ml-2 text-xs text-text-muted">{t("playlist.alreadyAdded")}</span>
                    ) : null}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-text-muted">
                    {t("playlist.tracksCount", { count: playlist.items.length })}
                  </span>
                </button>
              );
            })}

            <button
              ref={(el) => {
                if (el) itemsRef.current[visiblePlaylists.length] = el;
              }}
              type="button"
              role="menuitem"
              onClick={handleCreateNew}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
            >
              <PlusIcon size={16} className="shrink-0 text-text-muted" />
              <span>{t("playlist.createNew")}</span>
            </button>

            {visiblePlaylists.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-muted">
                {playlists.length === 0
                  ? t("playlist.noPlaylistsHint")
                  : t("playlist.noMatchHint")}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {showCreateDialog
        ? createPortal(
            <Suspense fallback={null}>
              <CreatePlaylistDialog
                open={showCreateDialog}
                onClose={handleCreateDialogClose}
                onCreated={(playlistId) => void handleCreated(playlistId)}
                navigateOnCreate={false}
              />
            </Suspense>,
            document.body,
          )
        : null}
    </>
  );
}
