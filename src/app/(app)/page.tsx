import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/dal/session";
import { getLibraryOverview } from "@/lib/dal/library";
import { fetchHomeSections } from "@/lib/providers/server";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistCard } from "@/components/artist/artist-card";
import { AlbumCard } from "@/components/album/album-card";
import { PlaylistCard } from "@/components/library/playlist-card";
import { HeroSection } from "@/components/home/hero-section";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { HeartIcon, ClockIcon, LibraryIcon, MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Home" };

function SectionFailed({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/60 px-4 py-3 text-sm text-text-muted">
      <AlertCircleIcon size={16} className="shrink-0" />
      <span>{label} unavailable — try again later.</span>
    </div>
  );
}

export default async function HomePage() {
  const user = await getCurrentUser();

  const library = user
    ? await getLibraryOverview(user.id, { likedLimit: 5, recentLimit: 8 })
    : null;

  const recentTracks = library?.recent.map((r) => r.track) ?? [];
  const likedTracks = library?.liked.map((l) => l.track) ?? [];

  const sections = await fetchHomeSections(recentTracks, likedTracks);

  const heroTrack = sections.featured[0] ?? sections.popular[0] ?? null;

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          {user?.name ? `Welcome back, ${user.name.split(" ")[0]}` : "Welcome to Aurora"}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          Discover open music, save favorites, and build your own library. Tracks below
          are surfaced from the configured catalog provider.
        </p>
      </section>

      {heroTrack ? <HeroSection track={heroTrack} /> : null}

      {sections.popular.length > 0 ? (
        <section>
          <SectionHeader title="Popular tracks" aside="from catalog provider" />
          <TrackList tracks={sections.popular} showMenu={true} />
        </section>
      ) : sections.popularStatus === "failed" ? (
        <section>
          <SectionHeader title="Popular tracks" aside="from catalog provider" />
          <SectionFailed label="Popular tracks" />
        </section>
      ) : null}

      {sections.featured.length > 1 ? (
        <section>
          <SectionHeader title="Featured tracks" aside="from catalog provider" />
          <TrackList tracks={sections.featured.slice(1, 7)} showMenu={true} />
        </section>
      ) : sections.featuredStatus === "failed" ? (
        <section>
          <SectionHeader title="Featured tracks" aside="from catalog provider" />
          <SectionFailed label="Featured tracks" />
        </section>
      ) : null}

      {sections.recommendations.length > 0 ? (
        <section>
          <SectionHeader title="Recommended for you" aside="based on listening" />
          <TrackList tracks={sections.recommendations} showMenu={true} />
        </section>
      ) : sections.recommendationsStatus === "failed" ? (
        <section>
          <SectionHeader title="Recommended for you" aside="based on listening" />
          <SectionFailed label="Recommendations" />
        </section>
      ) : null}

      {sections.featuredAlbums.length > 0 ? (
        <section>
          <SectionHeader title="Albums from popular music" />
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sections.featuredAlbums.slice(0, 5).map((album) => (
              <li key={`${album.provider}:${album.id}`}>
                <AlbumCard album={album} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.featuredArtists.length > 0 ? (
        <section>
          <SectionHeader title="Artists from popular music" />
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sections.featuredArtists.slice(0, 5).map((artist) => (
              <li key={`${artist.provider}:${artist.id}`}>
                <ArtistCard artist={artist} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.popular.length === 0 &&
        sections.featured.length === 0 &&
        sections.recommendations.length === 0 &&
        sections.featuredAlbums.length === 0 &&
        sections.featuredArtists.length === 0 &&
        sections.popularStatus !== "failed" &&
        sections.featuredStatus !== "failed" &&
        sections.recommendationsStatus !== "failed" ? (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title="Catalog is quiet right now"
          description="No tracks could be loaded from the catalog provider. Configure a provider (such as Jamendo) or try again later."
        />
      ) : null}

      {library ? (
        <>
          <section>
            <SectionHeader title="Recently played" aside="your listening history" />
            {library.recent.length > 0 ? (
              <TrackList tracks={library.recent.map((entry) => entry.track)} showMenu={true} />
            ) : (
              <EmptyState
                icon={<ClockIcon size={28} />}
                title="Nothing played yet"
                description="Tracks you listen to will show up here once playback is enabled."
              />
            )}
          </section>

          <section>
            <SectionHeader title="Liked music" aside="your favorites" />
            {library.liked.length > 0 ? (
              <TrackList tracks={library.liked.map((entry) => entry.track)} showMenu={true} />
            ) : (
              <EmptyState
                icon={<HeartIcon size={28} />}
                title="No likes yet"
                description="Songs you like will be collected here."
              />
            )}
          </section>

          <section>
            <SectionHeader title="Your playlists" aside="created by you" />
            {library.playlists.length > 0 ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {library.playlists.map((playlist) => (
                  <li key={playlist.id}>
                    <PlaylistCard playlist={playlist} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<LibraryIcon size={28} />}
                title="No playlists yet"
                description="Playlist creation and editing arrive in a later phase."
              />
            )}
          </section>
        </>
      ) : (
        <EmptyState
          icon={<LibraryIcon size={28} />}
          title="Your library is a sign-in away"
          description="Sign in to see your recently played tracks, likes, and playlists here."
        />
      )}
    </div>
  );
}
