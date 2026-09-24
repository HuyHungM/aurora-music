"use client";

import { useState } from "react";
import type { Playlist } from "@/lib/domain";
import { PlaylistCard } from "@/components/library/playlist-card";
import { CreatePlaylistDialog } from "@/components/playlist/create-playlist-dialog";
import { Button } from "@/components/ui/button";
import { PlusIcon, MusicNoteIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";

export function PlaylistSection({ playlists }: { playlists: Playlist[] }) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-text-primary">Playlists</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{playlists.length} total</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreateDialog(true)}
            aria-label="Create playlist"
            className="gap-1"
          >
            <PlusIcon size={16} />
            <span className="hidden sm:inline">Create</span>
          </Button>
        </div>
      </div>
      {playlists.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <PlaylistCard playlist={playlist} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title="No playlists yet"
          description="Create a playlist to start organizing your music."
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              className="mt-2"
            >
              <PlusIcon size={16} />
              <span>Create playlist</span>
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
