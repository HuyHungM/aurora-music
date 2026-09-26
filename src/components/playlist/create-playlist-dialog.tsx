"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogTitle, DialogClose, DialogActions } from "@/components/ui/dialog";
import { useLocale } from "@/components/i18n/locale-provider";
import { Button } from "@/components/ui/button";
import { createPlaylistAction } from "@/app/actions/playlist";

function CreatePlaylistForm({
  onClose,
  onCreated,
  navigateOnCreate,
}: {
  onClose: () => void;
  onCreated?: (playlistId: string) => void;
  navigateOnCreate: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { t } = useLocale();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t("playlist.nameRequired"));
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
      const createdId = result.playlistId;
      // Creation stays inside the current context (e.g. the
      // add-to-playlist picker auto-adds the track); only the
      // standalone dialog navigates to the new playlist.
      if (onCreated) {
        onCreated(createdId);
      } else {
        onClose();
      }
      if (!onCreated && navigateOnCreate) {
        router.push(`/library/playlists/${createdId}`);
      }
    } else {
      setError(t("playlist.createError"));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="playlist-title"
          className="text-sm font-medium text-text-primary"
        >
          {t("playlist.nameLabel")}
        </label>
        <input
          ref={titleInputRef}
          id="playlist-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("playlist.namePlaceholder")}
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
          {t("playlist.descriptionLabel")} <span className="text-text-muted">{t("playlist.descriptionOptional")}</span>
        </label>
        <textarea
          id="playlist-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("playlist.descriptionPlaceholder")}
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
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={isSubmitting || !title.trim()}
        >
          {isSubmitting ? t("playlist.creating") : t("common.create")}
        </Button>
      </DialogActions>
    </form>
  );
}

export function CreatePlaylistDialog({
  open,
  onClose,
  onCreated,
  navigateOnCreate = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the new playlist id instead of closing+navigating. */
  onCreated?: (playlistId: string) => void;
  /** Push to the new playlist page after creation (standalone use). */
  navigateOnCreate?: boolean;
}) {
  const { t: dialogT } = useLocale();
  return (
    <Dialog open={open} onClose={onClose} label={dialogT("library.createPlaylist")}>
      <div className="relative">
        <DialogTitle>{dialogT("library.createPlaylist")}</DialogTitle>
        <DialogClose onClick={onClose} />
      </div>
      <div className="mt-4">
        {open ? (
          <CreatePlaylistForm
            onClose={onClose}
            onCreated={onCreated}
            navigateOnCreate={navigateOnCreate}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
