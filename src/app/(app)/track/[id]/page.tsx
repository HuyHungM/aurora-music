import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchTrackDetail } from "@/lib/providers/server";
import { isTrackLiked } from "@/lib/dal/like";
import { getSessionUserId } from "@/lib/dal/session";
import { RecommendationSection } from "@/components/recommendations/recommendation-section";
import { getRequestLocale } from "@/lib/i18n/server";
import { TrackPlayer } from "./track-player";

export const metadata: Metadata = { title: "Track" };

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getRequestLocale();
  const decodedId = decodeURIComponent(id);

  const trackResult = await fetchTrackDetail(decodedId);

  if (trackResult.kind === "unsupported" || trackResult.kind === "failed") {
    notFound();
  }

  if (trackResult.kind === "success") {
    const { data: track } = trackResult;

    let liked = false;
    if (track.providerTrackId) {
      const userId = await getSessionUserId();
      if (userId) {
        liked = await isTrackLiked(userId, {
          provider: track.provider,
          providerTrackId: track.providerTrackId,
        });
      }
    }

    return (
      <div className="flex flex-col gap-8">
        <TrackPlayer track={track} initialLiked={liked} />

        {/* Phase 47: replaced the raw provider "related tracks" call with the
            real Aurora pipeline. The provider call returned whatever one
            provider happened to think was related, with no de-duplication
            against this page, no artist diversity, and no shared ranking
            with radio. This section is deterministic, excludes the track
            being viewed, and returns nothing at all rather than an error
            placeholder when there is genuinely nothing to suggest. */}
        {track.providerTrackId ? (
          <RecommendationSection
            locale={locale}
            titleKey="track.recommended"
            seed={{
              provider: track.provider,
              providerTrackId: track.providerTrackId,
              artistName: track.artistName,
            }}
            excludeKeys={[`${track.provider}:${track.providerTrackId}`]}
            limit={8}
          />
        ) : null}
      </div>
    );
  }

  notFound();
}
