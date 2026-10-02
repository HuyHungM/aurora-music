import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  fetchAlbumDetail,
  fetchAlbumTracks,
  type CapabilityResult,
} from "@/lib/providers/server";
import type { Track } from "@/lib/domain";
import { TrackList } from "@/components/tracks/track-list";
import { RecommendationSection } from "@/components/recommendations/recommendation-section";
import { getRequestLocale } from "@/lib/i18n/server";
import { formatNumber, getT, plural } from "@/lib/i18n/translate";
import { AlbumPlayButton } from "@/components/album/album-play-button";
import { EntityHeader } from "@/components/ui/entity-header";
import { SectionHeader } from "@/components/home/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Album" };

export default async function AlbumDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getRequestLocale();
  const t = getT(locale);
  const decodedId = decodeURIComponent(id);

  // Independent reads, previously awaited one after another: both only need
  // `decodedId`. `allSettled` so a rejection cannot mask the `notFound()`
  // below, and so a failed tracklist degrades to the existing `failed`
  // rendering instead of throwing the whole page away.
  const [albumOutcome, tracksOutcome] = await Promise.allSettled([
    fetchAlbumDetail(decodedId),
    fetchAlbumTracks(decodedId),
  ]);

  const albumResult = albumOutcome.status === "fulfilled" ? albumOutcome.value : null;

  if (!albumResult || albumResult.kind === "unsupported" || albumResult.kind === "failed") {
    notFound();
  }

  if (albumResult.kind === "success") {
    const { data: album } = albumResult;
    const tracksResult: CapabilityResult<Track[]> =
      tracksOutcome.status === "fulfilled"
        ? tracksOutcome.value
        : { kind: "failed" };

    return (
      <div className="flex flex-col gap-8">
        <EntityHeader
          eyebrow={t("album.eyebrow")}
          title={album.title}
          artwork={album.artwork}
          artworkAlt={album.title}
          meta={
            <>
              {album.artistName}
              {album.releaseDate ? ` · ${album.releaseDate}` : ""}
              {tracksResult.kind === "success" && tracksResult.data.length > 0
                ? ` · ${plural(locale, tracksResult.data.length, {
                    one: t("album.tracksCountOne", { count: formatNumber(locale, tracksResult.data.length) }),
                    other: t("album.tracksCount", { count: formatNumber(locale, tracksResult.data.length) }),
                  })}`
                : ""}
            </>
          }
          actions={
            tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
              <AlbumPlayButton tracks={tracksResult.data} />
            ) : undefined
          }
        />

        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <section aria-label={t("album.tracklist")}>
            <SectionHeader
              title={t("album.tracklist")}
              aside={plural(locale, tracksResult.data.length, {
                one: t("album.tracksCountOne", { count: formatNumber(locale, tracksResult.data.length) }),
                other: t("album.tracksCount", { count: formatNumber(locale, tracksResult.data.length) }),
              })}
            />
            <TrackList tracks={tracksResult.data} showMenu={true} numbered />
          </section>
        ) : null}

        {tracksResult.kind === "success" && tracksResult.data.length === 0 ? (
          <EmptyState
            icon={<MusicNoteIcon size={24} />}
            title={t("album.noTracksTitle")}
            description={t("album.noTracksDescription")}
            action={<ButtonLink href="/search" variant="secondary" size="sm">{t("library.discoverMusic")}</ButtonLink>}
          />
        ) : null}

        {tracksResult.kind === "failed" ? (
          <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3 text-sm text-text-muted">
            <AlertCircleIcon size={16} className="shrink-0" />
            <span>{t("album.tracksUnavailable")}</span>
          </div>
        ) : null}

        {tracksResult.kind === "unsupported" ? null : null}

        {/* Phase 47: seeded from the album's own first track so the section
            is "more in this vein", with every track already on the page
            excluded. An empty result renders nothing. */}
        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <RecommendationSection
            locale={locale}
            titleKey="album.youMightAlsoLike"
            seed={{
              provider: tracksResult.data[0]!.provider,
              providerTrackId: tracksResult.data[0]!.providerTrackId ?? "",
              artistName: album.artistName,
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
