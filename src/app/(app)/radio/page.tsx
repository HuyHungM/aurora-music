import type { Metadata } from "next";
import type { Track } from "@/lib/domain";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { getShellProviders } from "@/lib/providers/server";
import { getSessionUserId } from "@/lib/dal/session";
import { listFollowedArtists } from "@/lib/dal/follow";
import { TrackList } from "@/components/tracks/track-list";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RadioIcon, MusicNoteIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";
import {
  ActiveStationCard,
  RecentStations,
  StartArtistRadioButton,
  StartDiscoveryRadioButton,
} from "@/components/radio/radio-controls";

export const metadata: Metadata = { title: "Radio" };

export default async function RadioPage() {
  const locale = await getRequestLocale();
  const t = getT(locale);
  // Popular catalog comes from whichever registered provider actually
  // offers it (today: Deezer) — capability-driven, never hardcoded.
  const providers = getShellProviders();
  const popularProvider = providers.find((provider) =>
    provider.capabilities.has("tracks.popular"),
  );
  let popular: Track[] = [];
  if (popularProvider) {
    try {
      const result = await popularProvider.getPopularTracks({ limit: 8 });
      popular = result.items;
    } catch {
      popular = [];
    }
  }

  const userId = await getSessionUserId().catch(() => null);
  const follows = userId ? await listFollowedArtists(userId, { limit: 6 }).catch(() => []) : [];

  return (
    <div className="flex flex-col gap-6 sm:gap-10">
      <section className="flex flex-col items-start gap-3">
        <p className="t-eyebrow">{t("radio.eyebrow")}</p>
        <h1 className="t-page-title flex items-center gap-2 sm:text-3xl">
          <RadioIcon size={26} /> {t("radio.title")}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          {t("radio.tagline")}
        </p>
        <StartDiscoveryRadioButton />
      </section>

      <ActiveStationCard />

      {follows.length > 0 ? (
        <section aria-label={t("radio.fromLibraryArtists")}>
          <SectionHeader title={t("radio.fromLibraryArtists")} aside={t("radio.fromLibraryAside")} />
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {follows.map(({ artist }) => (
              <li
                key={`${artist.provider}:${artist.providerArtistId ?? artist.id}`}
                className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="t-card-title truncate">{artist.name}</span>
                  <span className="t-caption">{t("radio.artistRadio")}</span>
                </span>
                <StartArtistRadioButton artist={artist} size="sm" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={t("radio.recentStations")}>
        <SectionHeader title={t("radio.recentStations")} aside={t("radio.recentAside")} />
        <RecentStations />
      </section>

      <section aria-label={t("radio.explore")}>
        <SectionHeader title={t("radio.explore")} aside={t("radio.exploreAside")} />
        {popular.length > 0 ? (
          <div className="rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            <TrackList tracks={popular} showMenu={true} numbered />
          </div>
        ) : (
          <EmptyState
            icon={<MusicNoteIcon size={24} />}
            title={t("radio.exploreEmptyTitle")}
            description={t("radio.exploreEmptyDescription")}
            action={<ButtonLink href="/search" variant="secondary" size="sm">{t("nav.browse")}</ButtonLink>}
          />
        )}
      </section>
    </div>
  );
}
