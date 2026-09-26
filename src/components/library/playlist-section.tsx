"use client";

import { useState } from "react";
import type { Playlist } from "@/lib/domain";
import { PlaylistCard } from "@/components/library/playlist-card";
import { CreatePlaylistDialog } from "@/components/playlist/create-playlist-dialog";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlusIcon, MusicNoteIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";

export function PlaylistSection({ playlists }: { playlists: Playlist[] }) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { t, locale } = useLocale();

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-text-primary">{t("library.playlistSection")}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{t("library.playlistTotal", { count: playlists.length })}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateDialog(true)}
            aria-label={t("library.createPlaylist")}
            className="gap-1"
          >
            <PlusIcon size={16} />
            <span className="hidden sm:inline">{t("common.create")}</span>
          </Button>
        </div>
      </div>
      {playlists.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <PlaylistCard playlist={playlist} locale={locale} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={t("empty.playlistsTitle")}
          description={t("empty.playlistsDescription")}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              className="mt-2"
            >
              <PlusIcon size={16} />
              <span>{t("library.createPlaylist")}</span>
            </Button>
          }
        />
      )}

      <CreatePlaylistDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
      />
    </section>
  );
}
