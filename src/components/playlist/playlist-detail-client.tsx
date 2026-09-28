"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Playlist, Track } from "@/lib/domain";
import { removeTrackFromPlaylistAction } from "@/app/actions/playlist";
import { PlaylistPlayButton } from "@/components/playlist/playlist-play-button";
import { PlaylistActions, PlaylistTrackActions } from "@/components/playlist/playlist-actions";
import { PlaylistArtworkEditor } from "@/components/playlist/playlist-artwork-editor";
import { PlaylistShareControl } from "@/components/playlist/playlist-share-control";
import { TrackRow } from "@/components/tracks/track-row";
import { catalogTrackKey } from "@/components/tracks/track-list";
import { EntityHeader } from "@/components/ui/entity-header";
import { EmptyState } from "@/components/ui/empty-state";
import { useLocale } from "@/components/i18n/locale-provider";
import { formatDate, plural } from "@/lib/i18n/translate";
import { MusicNoteIcon } from "@/components/ui/icons";
import type { TrackRef } from "@/lib/domain";
import { ButtonLink } from "@/components/ui/button";

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
  const { t, locale } = useLocale();
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
      <EntityHeader
        eyebrow={t("playlist.eyebrow")}
        title={currentPlaylist.title}
        artwork={currentPlaylist.artwork}
        artworkAlt={currentPlaylist.title}
        meta={
          <>
            {currentPlaylist.createdAt
              ? t("playlistDetail.createdOn", { date: formatDate(locale, currentPlaylist.createdAt) })
              : t("playlistDetail.createdRecently")}{" "}
            · {plural(locale, currentTracks.length, {
              one: t("playlistDetail.tracksCountOne", { count: currentTracks.length }),
              other: t("playlistDetail.tracksCount", { count: currentTracks.length }),
            })}
          </>
        }
        description={currentPlaylist.description}
        actions={
          <>
            {currentTracks.length > 0 ? (
              <PlaylistPlayButton tracks={currentTracks} />
            ) : null}
            {isOwner ? (
              <>
                <PlaylistArtworkEditor
                  playlist={currentPlaylist}
                  tracks={currentTracks}
                  onArtworkUpdated={handlePlaylistUpdated}
                />
                <PlaylistShareControl
                  playlist={currentPlaylist}
                  onVisibilityChanged={handlePlaylistUpdated}
                />
              </>
            ) : null}
            {isOwner ? (
              <PlaylistActions
                playlist={currentPlaylist}
                onPlaylistUpdated={handlePlaylistUpdated}
              />
            ) : null}
          </>
        }
      />

      {currentTracks.length > 0 ? (
        <section aria-label={t("playlist.tracksSection")}>
          <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <div className="flex flex-col gap-0.5">
              {currentTracks.map((track, index) => (
                // Occurrence identity: playlist membership rows are keyed by
                // playlist-item id, so the same track could appear in
                // multiple positions without colliding.
                <div
                  key={
                    currentPlaylist.items[index]?.id ??
                    `${catalogTrackKey(track)}#${index + 1}`
                  }
                  className="flex items-center gap-1"
                >
                  {isOwner ? (
                    <PlaylistTrackActions
                      playlistId={playlist.id}
                      tracks={currentTracks}
                      trackIndex={index}
                      onReorder={handleReorder}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <TrackRow
                      track={track}
                      collectionTracks={currentTracks}
                      collectionIndex={index}
                      showMenu={true}
                      showAddToPlaylist={true}
                      position={index + 1}
                      onRemoveFromPlaylist={
                        isOwner ? () => handleRemoveTrack(track) : undefined
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={t("playlist.emptyTitle")}
          description={t("playlist.emptyDescription")}
          action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.discoverMusic")}</ButtonLink>}
        />
      )}
    </div>
  );
}
