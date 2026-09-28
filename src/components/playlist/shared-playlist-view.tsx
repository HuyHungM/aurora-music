import type { SharedPlaylist, Track } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";
import { getT, plural } from "@/lib/i18n/translate";
import { EntityHeader } from "@/components/ui/entity-header";
import { EmptyState } from "@/components/ui/empty-state";
import { TrackList } from "@/components/tracks/track-list";
import { PlaylistPlayButton } from "@/components/playlist/playlist-play-button";
import { MusicNoteIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

/**
 * Read-only public view of a shared playlist (Phase 47).
 *
 * §12 permissions for a shared viewer: view, play, queue, like, and add to
 * their OWN playlists. Everything that mutates the owner's playlist —
 * rename, delete, artwork, track list, sharing settings — is simply absent.
 * The absence is a convenience, not the control: the server actions those
 * controls would call require a session and re-check ownership, so a
 * crafted request against someone else's playlist is rejected regardless.
 *
 * No private account data is shown. The owner appears only as a display
 * name supplied by the server.
 */
export function SharedPlaylistView({
  playlist,
  tracks,
  locale,
}: {
  playlist: SharedPlaylist;
  tracks: Track[];
  locale: Locale;
}) {
  const t = getT(locale);
  return (
    <div className="flex flex-col gap-8">
      <EntityHeader
        eyebrow={t("sharedPlaylist.eyebrow")}
        title={playlist.title}
        artwork={playlist.artwork}
        artworkAlt={playlist.title}
        meta={
          <>
            {t("sharedPlaylist.byAuthor", { name: playlist.ownerDisplayName })}{" "}
            · {plural(locale, tracks.length, {
              one: t("playlistDetail.tracksCountOne"),
              other: t("playlistDetail.tracksCount", { count: tracks.length }),
            })}
          </>
        }
        description={playlist.description}
        actions={
          tracks.length > 0 ? <PlaylistPlayButton tracks={tracks} /> : undefined
        }
      />

      {tracks.length > 0 ? (
        <section aria-label={t("sharedPlaylist.tracksSection")}>
          {/* Like / add-to-own-playlist remain available to the viewer via
              the track row menu; nothing here mutates the shared playlist. */}
          <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <TrackList tracks={tracks} showMenu={true} />
          </div>
        </section>
      ) : (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={t("sharedPlaylist.emptyTitle")}
          description={t("sharedPlaylist.emptyDescription")}
          action={<ButtonLink href="/search" variant="secondary" size="sm">{t("nav.browse")}</ButtonLink>}
        />
      )}
    </div>
  );
}
