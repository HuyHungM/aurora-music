import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/dal/session";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { getLibraryOverview } from "@/lib/dal/library";
import { fetchHomeSections } from "@/lib/providers/server";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistCard } from "@/components/artist/artist-card";
import { AlbumCard } from "@/components/album/album-card";
import { PlaylistCard } from "@/components/library/playlist-card";
import { RecommendationSection } from "@/components/recommendations/recommendation-section";
import { HeroSection } from "@/components/home/hero-section";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import {
  HeartIcon,
  ClockIcon,
  LibraryIcon,
  MusicNoteIcon,
  SparkleIcon,
  UserIcon,
  ListMusicIcon,
  AlertCircleIcon,
} from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const locale = await getRequestLocale();
  const t = getT(locale);
  const user = await getCurrentUser();

  const sectionFailed = (label: string) => (
    <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3 text-sm text-text-muted">
      <AlertCircleIcon size={16} className="shrink-0" />
      <span>{t("sectionFailed.unavailable", { label })}</span>
    </div>
  );

  const greeting = (name?: string | null): string => {
    const hour = new Date().getHours();
    if (!name) {
      return t("home.welcome");
    }
    const first = name.split(" ")[0] ?? name;
    if (hour < 12) {
      return t("home.greetingMorning", { name: first });
    }
    if (hour < 18) {
      return t("home.greetingAfternoon", { name: first });
    }
    return t("home.greetingEvening", { name: first });
  };

  const library = user
    ? await getLibraryOverview(user.id, { likedLimit: 5, recentLimit: 8 })
    : null;

  const recentTracks = library?.recent.map((r) => r.track) ?? [];
  const likedTracks = library?.liked.map((l) => l.track) ?? [];

  const sections = await fetchHomeSections(recentTracks, likedTracks);

  const heroTrack = sections.featured[0] ?? sections.popular[0] ?? null;
  const hasCatalog =
    sections.popular.length > 0 ||
    sections.featured.length > 0 ||
    sections.recommendations.length > 0 ||
    sections.featuredAlbums.length > 0 ||
    sections.featuredArtists.length > 0;

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      {/* Context: who is listening and what comes next. */}
      <section className="flex flex-col gap-1.5">
        <p className="t-eyebrow">{t("home.eyebrow")}</p>
        <h1 className="t-page-title sm:text-3xl">{greeting(user?.name)}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          {t("home.tagline")}
        </p>
      </section>

      {heroTrack ? <HeroSection track={heroTrack} /> : null}

      {/* Continue listening: the fastest path to music. */}
      {library && library.recent.length > 0 ? (
        <section aria-label={t("home.continueListening")}>
          <SectionHeader
            title={t("home.continueListening")}
            aside={t("home.continueAside")}
            icon={<ClockIcon size={16} />}
          />
          <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <TrackList
              tracks={library.recent.map((entry) => entry.track)}
              showMenu={true}
              variant="history"
              getKey={(_track, index) => library.recent[index]?.id ?? `recent-${index}`}
            />
          </div>
        </section>
      ) : null}

      {/* Phase 47: the home recommendation block is now the real Aurora
          pipeline instead of the provider-derived list. The provider call
          had no de-duplication, no artist diversity, and no personalization;
          this one reads the listener's own signals and excludes every track
          already shown above, so nothing on the page repeats. Signed-out
          visitors get the non-personalized discovery fallback, and an empty
          result renders nothing rather than an error placeholder. */}
      <RecommendationSection
        locale={locale}
        excludeKeys={sections.popular
          .concat(sections.featured)
          .map((track) => `${track.provider}:${track.providerTrackId ?? track.id}`)}
        limit={12}
      />

      {sections.popular.length > 0 ? (
        <section aria-label={t("home.popular")}>
          <SectionHeader title={t("home.popular")} aside={t("home.popularAside")} icon={<SparkleIcon size={16} />} />
          <TrackList tracks={sections.popular.slice(0, 8)} showMenu={true} numbered />
        </section>
      ) : sections.popularStatus === "failed" ? (
        <section>
          <SectionHeader title={t("home.popular")} aside={t("home.popularAside")} icon={<SparkleIcon size={16} />} />
          {sectionFailed(t("home.popular"))}
        </section>
      ) : null}

      {sections.featured.length > 1 ? (
        <section aria-label={t("home.featured")}>
          <SectionHeader title={t("home.featured")} aside={t("home.featuredAside")} icon={<SparkleIcon size={16} />} />
          <TrackList tracks={sections.featured.slice(1, 7)} showMenu={true} />
        </section>
      ) : sections.featuredStatus === "failed" ? (
        <section>
          <SectionHeader title={t("home.featured")} aside={t("home.featuredAside")} icon={<SparkleIcon size={16} />} />
          {sectionFailed(t("home.featured"))}
        </section>
      ) : null}

      {sections.featuredAlbums.length > 0 ? (
        <section aria-label={t("home.discoverAlbums")}>
          <SectionHeader title={t("home.discoverAlbums")} aside={t("home.discoverAlbumsAside")} icon={<MusicNoteIcon size={16} />} />
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sections.featuredAlbums.slice(0, 5).map((album) => (
              <li key={`${album.provider}:${album.providerAlbumId ?? album.id}`} className="min-w-0">
                <AlbumCard album={album} locale={locale} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.featuredArtists.length > 0 ? (
        <section aria-label={t("home.discoverArtists")}>
          <SectionHeader title={t("home.discoverArtists")} aside={t("home.discoverArtistsAside")} icon={<UserIcon size={16} />} />
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sections.featuredArtists.slice(0, 5).map((artist) => (
              <li key={`${artist.provider}:${artist.providerArtistId ?? artist.id}`} className="min-w-0">
                <ArtistCard artist={artist} locale={locale} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!hasCatalog &&
      sections.popularStatus !== "failed" &&
      sections.featuredStatus !== "failed" &&
      sections.recommendationsStatus !== "failed" ? (
        <EmptyState
          icon={<MusicNoteIcon size={24} />}
          title={t("home.catalogQuietTitle")}
          description={t("home.catalogQuietDescription")}
          action={<ButtonLink href="/search" variant="secondary" size="sm">{t("nav.browse")}</ButtonLink>}
          headingLevel={2}
        />
      ) : null}

      {library ? (
        <>
          <section aria-label={t("home.likedMusic")}>
            <SectionHeader title={t("home.likedMusic")} aside={t("home.likedAside")} icon={<HeartIcon size={16} />} />
            {library.liked.length > 0 ? (
              <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
                <TrackList
                  tracks={library.liked.map((entry) => entry.track)}
                  showMenu={true}
                  getKey={(track, index) =>
                    library.liked[index]?.id ??
                    `${track.provider}:${track.id}#${index}`
                  }
                />
              </div>
            ) : (
              <EmptyState
                icon={<HeartIcon size={24} />}
                title={t("home.noLikesTitle")}
                description={t("home.noLikesDescription")}
                action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.discoverMusic")}</ButtonLink>}
              />
            )}
          </section>

          <section aria-label={t("home.yourPlaylists")}>
            <SectionHeader title={t("home.yourPlaylists")} aside={t("home.yourPlaylistsAside")} icon={<ListMusicIcon size={16} />} />
            {library.playlists.length > 0 ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {library.playlists.map((playlist) => (
                  <li key={playlist.id} className="min-w-0">
                    <PlaylistCard playlist={playlist} locale={locale} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<LibraryIcon size={24} />}
                title={t("home.noPlaylistsTitle")}
                description={t("home.noPlaylistsDescription")}
                action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.discoverMusic")}</ButtonLink>}
              />
            )}
          </section>

          {library.recent.length === 0 ? (
            <EmptyState
              icon={<ClockIcon size={24} />}
              title={t("home.nothingPlayedTitle")}
              description={t("home.nothingPlayedDescription")}
              action={<ButtonLink href="/radio" variant="secondary" size="sm">{t("artist.startRadio")}</ButtonLink>}
              headingLevel={2}
            />
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={<LibraryIcon size={24} />}
          title={t("home.signInTitle")}
          description={t("home.signInDescription")}
          action={<ButtonLink href="/search" variant="secondary" size="sm">{t("nav.browse")}</ButtonLink>}
          headingLevel={2}
        />
      )}
    </div>
  );
}
