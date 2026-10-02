import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  fetchArtistDetail,
  fetchArtistTracks,
  type CapabilityResult,
} from "@/lib/providers/server";
import { isFollowing } from "@/lib/dal/follow";
import type { Track } from "@/lib/domain";
import { getSessionUserId } from "@/lib/dal/session";
import { TrackList } from "@/components/tracks/track-list";
import { RecommendationSection } from "@/components/recommendations/recommendation-section";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { ArtistPlayButton } from "@/components/artist/artist-play-button";
import { FollowButton } from "@/components/artist/follow-button";
import { StartArtistRadioButton } from "@/components/radio/radio-controls";
import { EntityHeader } from "@/components/ui/entity-header";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Artist" };

export default async function ArtistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getRequestLocale();
  const t = getT(locale);
  const decodedId = decodeURIComponent(id);

  // Three independent reads, previously awaited one after another: the artist
  // detail, the artist's tracks, and the session. Only the session gates the
  // follow check, so running them together cuts the critical path from three
  // round trips to two. `allSettled` rather than `all` because `notFound()` is
  // called from inside the promise below, and a rejection in one branch must
  // not be able to mask the `notFound()` the page already decided on.
  const [artistOutcome, tracksOutcome, sessionUserId] = await Promise.allSettled([
    fetchArtistDetail(decodedId),
    fetchArtistTracks(decodedId),
    getSessionUserId(),
  ]);

  const artistResult = artistOutcome.status === "fulfilled" ? artistOutcome.value : null;
  if (
    !artistResult ||
    artistResult.kind === "unsupported" ||
    artistResult.kind === "failed"
  ) {
    notFound();
  }

  if (artistResult.kind === "success") {
    const { data: artist } = artistResult;
    // A rejected branch reads as the same `failed` shape the server helpers
    // already return, so every downstream `kind` check below is unchanged.
    const tracksResult: CapabilityResult<Track[]> =
      tracksOutcome.status === "fulfilled"
        ? tracksOutcome.value
        : { kind: "failed" };
    const artistName = artist.name;

    let following = false;
    const userId = sessionUserId.status === "fulfilled" ? sessionUserId.value : null;
    if (artist.providerArtistId && userId) {
      following = await isFollowing(userId, {
        provider: artist.provider,
        providerArtistId: artist.providerArtistId,
      });
    }

    return (
      <div className="flex flex-col gap-8">
        <EntityHeader
          eyebrow={t("artist.eyebrow")}
          title={artist.name}
          artwork={artist.image}
          artworkAlt={artist.name}
          meta={
            artist.genres && artist.genres.length > 0
              ? artist.genres.slice(0, 3).join(" · ")
              : undefined
          }
          description={artist.bio}
          actions={
            <>
              {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
                <ArtistPlayButton tracks={tracksResult.data} />
              ) : null}
              <FollowButton
                artist={artist}
                initialFollowing={following}
                isAuthenticated={userId !== null}
              />
              <StartArtistRadioButton artist={artist} />
            </>
          }
        />

        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <section aria-label={t("artist.topTracks")}>
            <SectionHeader title={t("artist.topTracks")} aside={t("artist.topTracksAside", { name: artist.name })} />
            <TrackList tracks={tracksResult.data.slice(0, 10)} showMenu={true} numbered />
          </section>
        ) : null}

        {tracksResult.kind === "success" && tracksResult.data.length === 0 ? (
          <EmptyState
            icon={<MusicNoteIcon size={24} />}
            title={t("artist.noTracksTitle")}
            description={t("artist.noTracksDescription")}
            action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.findArtists")}</ButtonLink>}
          />
        ) : null}

        {tracksResult.kind === "failed" ? (
          <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3 text-sm text-text-muted">
            <AlertCircleIcon size={16} className="shrink-0" />
            <span>{t("artist.tracksUnavailable")}</span>
          </div>
        ) : null}

        {tracksResult.kind === "unsupported" ? null : null}

        {/* Phase 47: seeded from this artist's own top track, so the section
            is "more like what this artist sounds like" rather than a
            generic list. Tracks already on the page are excluded, and an
            empty result renders nothing. */}
        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <RecommendationSection
            locale={locale}
            titleKey="artist.moreLikeThis"
            seed={{
              provider: tracksResult.data[0]!.provider,
              providerTrackId: tracksResult.data[0]!.providerTrackId ?? "",
              artistName,
            }}
            excludeKeys={tracksResult.data.map(
              (item) => `${item.provider}:${item.providerTrackId ?? item.id}`,
            )}
            limit={8}
          />
        ) : null}
      </div>
    );
  }

  notFound();
}
