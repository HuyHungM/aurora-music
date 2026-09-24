import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/dal/session";
import { getLibraryOverview } from "@/lib/dal/library";
import { TrackList } from "@/components/tracks/track-list";
import { PlaylistSection } from "@/components/library/playlist-section";
import { LibraryPlayButton } from "@/components/library/library-play-button";
import { EmptyState } from "@/components/ui/empty-state";
import { LibrarySignedOutCta } from "@/components/auth/controls";
import { HeartIcon, ClockIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  const user = await getCurrentUser();

  if (!user) {
    return <LibrarySignedOutCta />;
  }

  const library = await getLibraryOverview(user.id, {
    likedLimit: 50,
    recentLimit: 20,
  });

  const likedTracks = library.liked.map((entry) => entry.track);
  const recentTracks = library.recent.map((entry) => entry.track);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          Your Library
        </h1>
        <p className="text-sm text-text-muted">Likes, playlists, and listening history.</p>
      </div>

      <PlaylistSection playlists={library.playlists} />

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-text-primary">Liked music</h2>
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <span>{library.liked.length} shown</span>
            {likedTracks.length > 0 ? (
              <LibraryPlayButton tracks={likedTracks} label="liked music" />
            ) : null}
          </span>
        </div>
        {library.liked.length > 0 ? (
          <TrackList tracks={likedTracks} />
        ) : (
          <EmptyState
            icon={<HeartIcon size={28} />}
            title="Nothing liked yet"
            description="Songs you like will be collected here."
          />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-text-primary">Recently played</h2>
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <span>your listening history</span>
            {recentTracks.length > 0 ? (
              <LibraryPlayButton tracks={recentTracks} label="recently played" />
            ) : null}
          </span>
        </div>
        {library.recent.length > 0 ? (
          <TrackList tracks={recentTracks} />
        ) : (
          <EmptyState
            icon={<ClockIcon size={28} />}
            title="Nothing played yet"
            description="Tracks you listen to will show up here once playback is enabled."
          />
        )}
      </section>
    </div>
  );
}
