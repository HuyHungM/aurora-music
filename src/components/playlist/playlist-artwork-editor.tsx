"use client";

import { useCallback, useMemo, useState } from "react";
import { updatePlaylistAction } from "@/app/actions/playlist";
import { Dialog, DialogTitle, DialogClose, DialogActions } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Artwork } from "@/components/ui/artwork";
import { ImageIcon, TrashIcon } from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import type { Playlist, Track } from "@/lib/domain";

/**
 * Custom playlist artwork (Phase 47).
 *
 * Storage model: Aurora has NO object storage and no upload pipeline, so
 * artwork is a URL in the pre-existing `Playlist.artwork` column. This
 * component therefore offers the two things that model can honestly
 * support, and nothing more:
 *
 *   1. pick from artwork Aurora already has (the playlist's own track
 *      covers) — always safe, no new external host;
 *   2. paste an image URL, validated again on the server.
 *
 * Introducing a public file-upload endpoint would mean a new storage layer,
 * new abuse controls (type/size/dimension limits, malware scanning, quota)
 * and a new public asset surface. That is a much larger, riskier change than
 * this feature warrants, and the task explicitly says not to introduce one
 * where the repository has no storage layer.
 *
 * Removing custom artwork writes `artwork: null`, which makes every surface
 * fall back to the default playlist artwork. Track contents are never
 * touched by an artwork change.
 */
export function PlaylistArtworkEditor({
  playlist,
  tracks,
  onArtworkUpdated,
}: {
  playlist: Playlist;
  tracks: Track[];
  onArtworkUpdated?: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [url, setUrl] = useState(playlist.artwork ?? "");

  // Artwork Aurora already holds for this playlist's own tracks, in playlist
  // order, de-duplicated. Deterministic: no shuffling, no random picks.
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const track of tracks) {
      const src = track.artworkUrl;
      if (src && !seen.has(src)) {
        seen.add(src);
        out.push(src);
      }
      if (out.length >= 12) {
        break;
      }
    }
    return out;
  }, [tracks]);

  const trimmed = url.trim();
  const isDefault = trimmed.length === 0;
  // Client-side mirror of the server schema. The server validates again;
  // this only avoids a pointless round trip and gives immediate feedback.
  const urlLooksValid = useMemo(() => {
    if (isDefault) {
      return true;
    }
    if (trimmed.length > 2048) {
      return false;
    }
    try {
      const parsed = new URL(trimmed);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname.length > 0
      );
    } catch {
      return false;
    }
  }, [trimmed, isDefault]);

  const persist = useCallback(
    async (next: string | null) => {
      setIsSubmitting(true);
      setError(null);
      const result = await updatePlaylistAction(playlist.id, { artwork: next });
      setIsSubmitting(false);
      if (!result.ok) {
        setError(t("playlistArtwork.saveError"));
        return;
      }
      setSaved(true);
      onArtworkUpdated?.();
    },
    [playlist.id, onArtworkUpdated, t],
  );

  const close = useCallback(() => {
    setOpen(false);
    setSaved(false);
    setError(null);
    setUrl(playlist.artwork ?? "");
  }, [playlist.artwork]);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t("playlistArtwork.changeArtwork")}
        className="gap-1.5"
      >
        <ImageIcon size={16} />
        <span className="hidden sm:inline">{t("playlistArtwork.changeArtwork")}</span>
      </Button>

      <Dialog open={open} onClose={close} label={t("playlistArtwork.editTitle")}>
        <div className="relative">
          <DialogTitle>{t("playlistArtwork.editTitle")}</DialogTitle>
          <DialogClose onClick={close} />
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {/* Preview: exactly what the header/card will render, including
              the default-artwork fallback. */}
          <div className="flex items-center gap-3">
            <span className="t-eyebrow">{t("playlistArtwork.preview")}</span>
            <Artwork
              // Only ever hand the image component a URL that is already a
              // URL. While the field is mid-typing the value is a fragment
              // like "htt" or "https://img.ex", and `next/image` throws on an
              // unparseable `src` — which would take the whole dialog down on
              // the first keystroke. An unparseable value previews as the
              // default artwork instead.
              src={urlLooksValid && !isDefault ? trimmed : null}
              alt={playlist.title}
              size="medium"
              className="rounded-lg"
            />
            <span className="text-xs text-text-muted">
              {isDefault ? t("playlistArtwork.usingDefault") : t("playlistArtwork.usingCustom")}
            </span>
          </div>

          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-text-primary">
                {t("playlistArtwork.pickFromTracks")}
              </span>
              <ul className="flex flex-wrap gap-2">
                {suggestions.map((src) => (
                  <li key={src}>
                    <button
                      type="button"
                      onClick={() => setUrl(src)}
                      aria-label={t("playlistArtwork.pickFromTracks")}
                      aria-pressed={trimmed === src}
                      className={`overflow-hidden rounded-lg border transition-colors ${
                        trimmed === src
                          ? "border-accent"
                          : "border-border-subtle hover:border-accent/50"
                      }`}
                    >
                      <Artwork src={src} alt="" size="thumbnail" rounded="rounded-lg" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="playlist-artwork-url"
              className="text-sm font-medium text-text-primary"
            >
              {t("playlistArtwork.urlLabel")}
            </label>
            <input
              id="playlist-artwork-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setSaved(false);
              }}
              placeholder={t("playlistArtwork.urlPlaceholder")}
              aria-describedby="playlist-artwork-hint"
              aria-invalid={!urlLooksValid ? true : undefined}
              className="h-10 rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p id="playlist-artwork-hint" className="text-xs text-text-muted">
              {urlLooksValid ? t("playlistArtwork.urlHint") : t("playlistArtwork.urlInvalid")}
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => void persist(isDefault ? null : trimmed)}
              disabled={isSubmitting || !urlLooksValid}
            >
              {isSubmitting ? t("playlist.saving") : t("common.save")}
            </Button>
            {playlist.artwork ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setUrl("");
                  void persist(null);
                }}
                disabled={isSubmitting}
                className="gap-1.5"
              >
                <TrashIcon size={14} />
                <span>{t("playlistArtwork.remove")}</span>
              </Button>
            ) : null}
          </div>

          <p aria-live="polite" className="sr-only">
            {saved ? t("playlistArtwork.saved") : ""}
          </p>

          <DialogActions>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </>
  );
}
