"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Playlist, Track } from "@/lib/domain";
import {
  updatePlaylistAction,
  deletePlaylistAction,
  reorderPlaylistAction,
} from "@/app/actions/playlist";
import { Dialog, DialogTitle, DialogClose, DialogActions } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PencilIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon } from "@/components/ui/icons";
import type { TrackRef } from "@/lib/domain";

function RenameForm({
  playlist,
  onClose,
}: {
  playlist: Playlist;
  onClose: (updated?: boolean) => void;
}) {
  const [title, setTitle] = useState(playlist.title);
  const [description, setDescription] = useState(playlist.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Playlist name is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await updatePlaylistAction(playlist.id, {
      title: trimmedTitle,
      description: description.trim() || null,
    });

    setIsSubmitting(false);

    if (result.ok) {
      onClose(true);
    } else {
      setError(result.error ?? "Failed to update playlist");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="rename-title"
          className="text-sm font-medium text-text-primary"
        >
          Name
        </label>
        <input
          ref={titleInputRef}
          id="rename-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Playlist name"
          maxLength={200}
          className="h-10 rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          aria-describedby={error ? "rename-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="rename-description"
          className="text-sm font-medium text-text-primary"
        >
          Description <span className="text-text-muted">(optional)</span>
        </label>
        <textarea
          id="rename-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a description..."
          rows={3}
          maxLength={500}
          className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {error ? (
        <p id="rename-error" role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}

      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onClose()} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting || !title.trim()}>
          {isSubmitting ? "Saving..." : "Save"}
        </Button>
      </DialogActions>
    </form>
  );
}

function DeleteConfirmDialog({
  playlist,
  open,
  onClose,
}: {
  playlist: Playlist;
  open: boolean;
  onClose: (deleted?: boolean) => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setIsSubmitting(true);
    setError(null);

    const result = await deletePlaylistAction(playlist.id);

    setIsSubmitting(false);

    if (result.ok) {
      onClose(true);
    } else {
      setError(result.error ?? "Failed to delete playlist");
    }
  };

  return (
    <Dialog open={open} onClose={() => onClose()} label="Delete playlist">
      <div className="relative">
        <DialogTitle>Delete playlist</DialogTitle>
        <DialogClose onClick={() => onClose()} />
      </div>

      <div className="mt-4">
        <p className="text-sm text-text-muted">
          Are you sure you want to delete &quot;{playlist.title}&quot;? This action cannot be undone.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        ) : null}

        <DialogActions>
          <Button type="button" variant="ghost" onClick={() => onClose()} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleDelete}
            disabled={isSubmitting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {isSubmitting ? "Deleting..." : "Delete"}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

export function PlaylistActions({
  playlist,
  onPlaylistUpdated,
}: {
  playlist: Playlist;
  onPlaylistUpdated?: () => void;
}) {
  const router = useRouter();
  const [showRename, setShowRename] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [renameKey, setRenameKey] = useState(0);

  const handleRenameClose = (updated?: boolean) => {
    setShowRename(false);
    if (updated) {
      onPlaylistUpdated?.();
    }
  };

  const handleDeleteClose = (deleted?: boolean) => {
    setShowDelete(false);
    if (deleted) {
      router.push("/library");
    }
  };

  const handleOpenRename = () => {
    setRenameKey((k) => k + 1);
    setShowRename(true);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpenRename}
          aria-label="Rename playlist"
          className="gap-1.5"
        >
          <PencilIcon size={16} />
          <span className="hidden sm:inline">Rename</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDelete(true)}
          aria-label="Delete playlist"
          className="gap-1.5 text-red-400 hover:text-red-300 hover:bg-red-400/10"
        >
          <TrashIcon size={16} />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>

      <Dialog open={showRename} onClose={() => setShowRename(false)} label="Rename playlist">
        <div className="relative">
          <DialogTitle>Rename playlist</DialogTitle>
          <DialogClose onClick={() => setShowRename(false)} />
        </div>
        <div className="mt-4">
          {showRename ? (
            <RenameForm key={renameKey} playlist={playlist} onClose={handleRenameClose} />
          ) : null}
        </div>
      </Dialog>
      <DeleteConfirmDialog playlist={playlist} open={showDelete} onClose={handleDeleteClose} />
    </>
  );
}

export function PlaylistTrackActions({
  playlistId,
  tracks,
  trackIndex,
  onReorder,
}: {
  playlistId: string;
  tracks: Track[];
  trackIndex: number;
  onReorder?: () => void;
}) {
  const [isReordering, setIsReordering] = useState(false);

  const handleMoveUp = async () => {
    if (trackIndex <= 0) return;
    setIsReordering(true);

    const orderedRefs: TrackRef[] = tracks.map((t, i) => {
      const sourceIndex = i === trackIndex ? trackIndex - 1 : i === trackIndex - 1 ? trackIndex : i;
      const sourceTrack = tracks[sourceIndex];
      return {
        provider: sourceTrack.provider as string,
        providerTrackId: sourceTrack.providerTrackId ?? sourceTrack.id,
      };
    });

    const result = await reorderPlaylistAction(playlistId, orderedRefs);
    setIsReordering(false);

    if (result.ok) {
      onReorder?.();
    }
  };

  const handleMoveDown = async () => {
    if (trackIndex >= tracks.length - 1) return;
    setIsReordering(true);

    const orderedRefs: TrackRef[] = tracks.map((t, i) => {
      const sourceIndex = i === trackIndex ? trackIndex + 1 : i === trackIndex + 1 ? trackIndex : i;
      const sourceTrack = tracks[sourceIndex];
      return {
        provider: sourceTrack.provider as string,
        providerTrackId: sourceTrack.providerTrackId ?? sourceTrack.id,
      };
    });

    const result = await reorderPlaylistAction(playlistId, orderedRefs);
    setIsReordering(false);

    if (result.ok) {
      onReorder?.();
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Move track up"
        onClick={handleMoveUp}
        disabled={trackIndex <= 0 || isReordering}
        className="grid h-8 w-8 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ArrowUpIcon size={16} />
      </button>
      <button
        type="button"
        aria-label="Move track down"
        onClick={handleMoveDown}
        disabled={trackIndex >= tracks.length - 1 || isReordering}
        className="grid h-8 w-8 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ArrowDownIcon size={16} />
      </button>
    </div>
  );
}
