"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Playlist, Track } from "@/lib/domain";
import { removeTrackFromPlaylistAction } from "@/app/actions/playlist";
import { PlaylistPlayButton } from "@/components/playlist/playlist-play-button";
import { PlaylistActions, PlaylistTrackActions } from "@/components/playlist/playlist-actions";
import { TrackRow } from "@/components/tracks/track-row";
import { EmptyState } from "@/components/ui/empty-state";
import { MusicNoteIcon } from "@/components/ui/icons";
import type { TrackRef } from "@/lib/domain";

export function PlaylistDetailClient({
  playlist,
  tracks,
  isOwner,
}: {
  playlist: Playlist;
  tracks: Track[];
  isOwner: boolean;
}) {
  const router = useRouter();
  // Server props are the source of truth: router.refresh() re-renders
  // with fresh props (no remount), so reorder/rename results flow
  // straight through. Removals stay optimistic via a local id set —
  // no refresh is triggered on remove, so nothing clobbers them.
  // (Phase 30 acceptance: the UI must reflect a completed reorder.)
  const [removedTrackIds, setRemovedTrackIds] = useState<Set<string>>(
    () => new Set(),
  );
  const currentTracks = tracks.filter((track) => !removedTrackIds.has(track.id));
  const currentPlaylist = {
    ...playlist,
    items: playlist.items.filter(
      (item) =>
        !removedTrackIds.has(
          tracks.find((track) => track.providerTrackId === item.trackId)?.id ??
            item.trackId,
        ),
    ),
  };

  const handleRemoveTrack = useCallback(
    async (track: Track) => {
      const trackRef: TrackRef = {
        provider: track.provider as string,
        providerTrackId: track.providerTrackId ?? track.id,
      };
      const result = await removeTrackFromPlaylistAction(playlist.id, trackRef);

      if (result.ok) {
        setRemovedTrackIds((prev) => new Set(prev).add(track.id));
      }
    },
    [playlist.id],
  );

  const handleReorder = useCallback(() => {
    router.refresh();
  }, [router]);

  const handlePlaylistUpdated = useCallback(() => {
    router.refresh();
  }, [router]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-text-muted">Playlist</p>
        <h1 className="truncate text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          {currentPlaylist.title}
        </h1>
        {currentPlaylist.description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-text-muted line-clamp-3">
            {currentPlaylist.description}
          </p>
        ) : null}
        <p className="text-xs text-text-muted">
          Created{" "}
          {currentPlaylist.createdAt
            ? new Date(currentPlaylist.createdAt).toLocaleDateString()
            : "recently"}{" "}
          · {currentTracks.length} track{currentTracks.length === 1 ? "" : "s"}
        </p>
        <div className="mt-2 flex items-center gap-3">
          {currentTracks.length > 0 ? (
            <PlaylistPlayButton tracks={currentTracks} />
          ) : null}
          {isOwner ? (
            <PlaylistActions
              playlist={currentPlaylist}
              onPlaylistUpdated={handlePlaylistUpdated}
            />
          ) : null}
        </div>
      </div>

      {currentTracks.length > 0 ? (
        <div className="flex flex-col gap-1">
          {currentTracks.map((track, index) => (
            <div key={track.id} className="flex items-center gap-1">
              {isOwner ? (
                <PlaylistTrackActions
                  playlistId={playlist.id}
                  tracks={currentTracks}
                  trackIndex={index}
                  onReorder={handleReorder}
                />
              ) : (
                <span className="w-8 shrink-0 text-center text-xs text-text-muted">
                  {index + 1}
                </span>
              )}
              <div className="flex-1">
                <TrackRow
                  track={track}
                  collectionTracks={currentTracks}
                  collectionIndex={index}
                  showMenu={true}
                  showAddToPlaylist={false}
                  onRemoveFromPlaylist={
                    isOwner
                      ? () => handleRemoveTrack(track)
                      : undefined
                  }
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title="This playlist is empty"
          description="Search for music and add tracks to get started."
        />
      )}
    </div>
  );
}
