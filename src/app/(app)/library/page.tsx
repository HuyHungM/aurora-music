import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/dal/session";
import { getRequestLocale } from "@/lib/i18n/server";
import { formatNumber, getT, plural } from "@/lib/i18n/translate";
import { getLibraryOverview } from "@/lib/dal/library";
import { listFollowedArtists } from "@/lib/dal/follow";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistCard } from "@/components/artist/artist-card";
import { PlaylistSection } from "@/components/library/playlist-section";
import { LibraryPlayButton } from "@/components/library/library-play-button";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LibrarySignedOutCta } from "@/components/auth/controls";
import { HeartIcon, ClockIcon, UserIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  const locale = await getRequestLocale();
  const t = getT(locale);
  const user = await getCurrentUser();

  if (!user) {
    return <LibrarySignedOutCta locale={locale} />;
  }

  const [library, follows] = await Promise.all([
    getLibraryOverview(user.id, {
      likedLimit: 50,
      recentLimit: 20,
    }),
    listFollowedArtists(user.id, { limit: 50 }),
  ]);

  const likedTracks = library.liked.map((entry) => entry.track);
  const recentTracks = library.recent.map((entry) => entry.track);
  const total =
    library.playlists.length +
    library.liked.length +
    library.recent.length +
    follows.length;

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      {/* Personal header: the library belongs to someone. */}
      <section className="flex flex-col gap-1.5">
        <p className="t-eyebrow">{t("library.eyebrow")}</p>
        <h1 className="t-page-title sm:text-3xl">{t("library.title")}</h1>
        <p className="text-sm text-text-muted">
          {total === 0
            ? t("library.emptySummary")
            : [
                plural(locale, library.playlists.length, {
                  one: t("library.summaryPlaylistsOne", {
                    count: formatNumber(locale, library.playlists.length),
                  }),
                  other: t("library.summaryPlaylistsOther", {
                    count: formatNumber(locale, library.playlists.length),
                  }),
                }),
                t("library.summaryLiked", {
                  count: formatNumber(locale, library.liked.length),
                }),
                t("library.summaryRecent", {
                  count: formatNumber(locale, library.recent.length),
                }),
                t("library.summaryFollowing", {
                  count: formatNumber(locale, follows.length),
                }),
              ].join(" · ")}
        </p>
      </section>

      {/* Segmented in-page navigation: playlists, liked, history, following. */}
      <nav aria-label={t("library.sections")} className="flex flex-wrap gap-2">
        {[
          { href: "#playlists", label: t("library.playlists") },
          { href: "#liked", label: t("library.liked") },
          { href: "#history", label: t("library.history") },
          { href: "#following", label: t("library.following") },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="aurora-press aurora-touch rounded-full border border-border-subtle bg-surface-1 px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div id="playlists" className="scroll-mt-24">
        <PlaylistSection playlists={library.playlists} />
      </div>

      <section id="liked" aria-label={t("library.likedMusic")} className="scroll-mt-24">
        <SectionHeader
          title={t("library.likedMusic")}
          aside={t("library.likedSaved", { count: formatNumber(locale, library.liked.length) })}
          icon={<HeartIcon size={16} />}
          action={
            likedTracks.length > 0 ? (
              <span className="flex items-center gap-2">
                <LibraryPlayButton tracks={likedTracks} labelKey="library.playLiked" />
                <LibraryPlayButton tracks={likedTracks} labelKey="library.playLiked" shuffle />
              </span>
            ) : undefined
          }
        />
        {library.liked.length > 0 ? (
          <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <TrackList
              tracks={likedTracks}
              showMenu={true}
              getKey={(_track, index) => library.liked[index]?.id ?? `like-${index}`}
            />
          </div>
        ) : (
          <EmptyState
            icon={<HeartIcon size={24} />}
            title={t("library.likedEmptyTitle")}
            description={t("library.likedEmptyDescription")}
            action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.discoverMusic")}</ButtonLink>}
          />
        )}
      </section>

      <section id="history" aria-label={t("library.recentlyPlayed")} className="scroll-mt-24">
        <SectionHeader
          title={t("library.recentlyPlayed")}
          aside={t("library.recentlyPlayedAside")}
          icon={<ClockIcon size={16} />}
          action={
            recentTracks.length > 0 ? (
              <LibraryPlayButton tracks={recentTracks} labelKey="library.playRecent" />
            ) : undefined
          }
        />
        {library.recent.length > 0 ? (
          <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <TrackList
              tracks={recentTracks}
              showMenu={true}
              variant="history"
              getKey={(_track, index) => library.recent[index]?.id ?? `recent-${index}`}
            />
          </div>
        ) : (
          <EmptyState
            icon={<ClockIcon size={24} />}
            title={t("library.historyEmptyTitle")}
            description={t("library.historyEmptyDescription")}
            action={<ButtonLink href="/radio" variant="secondary" size="sm">{t("artist.startRadio")}</ButtonLink>}
          />
        )}
      </section>

      <section id="following" aria-label={t("library.followingArtists")} className="scroll-mt-24">
        <SectionHeader
          title={t("library.followingArtists")}
          aside={t("library.followingCount", { count: formatNumber(locale, follows.length) })}
          icon={<UserIcon size={16} />}
        />
        {follows.length > 0 ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {follows.map(({ artist }) => (
              <li
                key={`${artist.provider}:${artist.providerArtistId ?? artist.id}`}
                className="min-w-0"
              >
                <ArtistCard artist={artist} locale={locale} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<UserIcon size={24} />}
            title={t("library.followingEmptyTitle")}
            description={t("library.followingEmptyDescription")}
            action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.findArtists")}</ButtonLink>}
          />
        )}
      </section>
    </div>
  );
}
