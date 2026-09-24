"use client";

import { useState, useEffect, useRef } from "react";
import type { Track, Playlist } from "@/lib/domain";
import { listUserPlaylistsAction, addTrackToPlaylistAction } from "@/app/actions/playlist";
import { CreatePlaylistDialog } from "@/components/playlist/create-playlist-dialog";
import { CheckIcon, PlusIcon } from "@/components/ui/icons";

export function AddToPlaylistMenu({
  track,
  onClose,
}: {
  track: Track;
  onClose: () => void;
}) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const result = await listUserPlaylistsAction();
      if (!cancelled) {
        if (result.ok && result.playlists) {
          setPlaylists(result.playlists);
        } else {
          setError(result.error ?? "Failed to load playlists");
        }
        setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loading) {
      // Items (or the trailing Create action when the list is empty)
      // arrive asynchronously; move focus in once they render.
      itemsRef.current[0]?.focus();
    }
  }, [loading, playlists.length]);

  const handleAddToPlaylist = async (playlistId: string) => {
    const result = await addTrackToPlaylistAction(playlistId, track);
    if (result.ok) {
      setSuccessId(playlistId);
      setTimeout(() => onClose(), 800);
    } else {
      setError(result.error ?? "Failed to add track");
    }
  };

  const handleCreateNew = () => {
    setShowCreateDialog(true);
  };

  const handleCreateDialogClose = () => {
    setShowCreateDialog(false);
    let cancelled = false;
    async function reload() {
      setLoading(true);
      setError(null);
      const result = await listUserPlaylistsAction();
      if (!cancelled) {
        if (result.ok && result.playlists) {
          setPlaylists(result.playlists);
        } else {
          setError(result.error ?? "Failed to load playlists");
        }
        setLoading(false);
      }
    }
    void reload();
    return () => { cancelled = true; };
  };

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Add to playlist"
        className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-lg"
      >
        <div className="px-3 py-2 text-xs font-medium text-text-muted border-b border-border-subtle">
          Add to playlist
        </div>

        {loading ? (
          <div className="px-3 py-4 text-center text-sm text-text-muted">Loading playlists...</div>
        ) : error ? (
          <div role="alert" className="px-3 py-4 text-center text-sm text-red-400">{error}</div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {playlists.map((playlist, i) => (
              <button
                key={playlist.id}
                ref={(el) => {
                  if (el) itemsRef.current[i] = el;
                }}
                type="button"
                role="menuitem"
                onClick={() => handleAddToPlaylist(playlist.id)}
                disabled={successId === playlist.id}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none disabled:opacity-50"
              >
                {successId === playlist.id ? (
                  <CheckIcon size={16} className="text-accent shrink-0" />
                ) : (
                  <span className="h-4 w-4 shrink-0" />
                )}
                <span className="truncate">{playlist.title}</span>
                <span className="ml-auto text-xs text-text-muted shrink-0">
                  {playlist.items.length} tracks
                </span>
              </button>
            ))}

            <button
              ref={(el) => {
                if (el) itemsRef.current[playlists.length] = el;
              }}
              type="button"
              role="menuitem"
              onClick={handleCreateNew}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
            >
              <PlusIcon size={16} className="text-text-muted shrink-0" />
              <span>Create new playlist</span>
            </button>

            {playlists.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-muted">
                No playlists yet. Create one to add tracks.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {showCreateDialog ? (
        <CreatePlaylistDialog open={showCreateDialog} onClose={handleCreateDialogClose} />
      ) : null}
    </>
  );
}
