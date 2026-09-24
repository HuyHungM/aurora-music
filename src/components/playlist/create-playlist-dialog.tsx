"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogTitle, DialogClose, DialogActions } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createPlaylistAction } from "@/app/actions/playlist";

function CreatePlaylistForm({
  onClose,
}: {
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Playlist name is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await createPlaylistAction({
      title: trimmedTitle,
      description: description.trim() || undefined,
    });

    setIsSubmitting(false);

    if (result.ok && result.playlistId) {
      onClose();
      router.push(`/library/playlists/${result.playlistId}`);
    } else {
      setError(result.error ?? "Failed to create playlist");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="playlist-title"
          className="text-sm font-medium text-text-primary"
        >
          Name
        </label>
        <input
          ref={titleInputRef}
          id="playlist-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="My playlist"
          maxLength={200}
          className="h-10 rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          aria-describedby={error ? "title-error" : undefined}
          aria-invalid={error ? true : undefined}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="playlist-description"
          className="text-sm font-medium text-text-primary"
        >
          Description <span className="text-text-muted">(optional)</span>
        </label>
        <textarea
          id="playlist-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a description..."
          rows={3}
          maxLength={500}
          className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {error ? (
        <p
          id="title-error"
          role="alert"
          className="text-sm text-red-400"
        >
          {error}
        </p>
      ) : null}

      <DialogActions>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={isSubmitting || !title.trim()}
        >
          {isSubmitting ? "Creating..." : "Create"}
        </Button>
      </DialogActions>
    </form>
  );
}

export function CreatePlaylistDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} label="Create playlist">
      <div className="relative">
        <DialogTitle>Create playlist</DialogTitle>
        <DialogClose onClick={onClose} />
      </div>
      <div className="mt-4">
        {open ? <CreatePlaylistForm onClose={onClose} /> : null}
      </div>
    </Dialog>
  );
}
