import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  fetchTrackDetail,
  fetchRecommendations,
} from "@/lib/providers/server";
import { isTrackLiked } from "@/lib/dal/like";
import { getSessionUserId } from "@/lib/dal/session";
import { TrackList } from "@/components/tracks/track-list";
import { SectionHeader } from "@/components/home/section-header";
import { TrackPlayer } from "./track-player";

export const metadata: Metadata = { title: "Track" };

export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

    let recommendations: typeof track[] = [];
    let recsFailed = false;
    if (track.providerTrackId) {
      const recsResult = await fetchRecommendations(track.providerTrackId);
      if (recsResult.kind === "success") {
        recommendations = recsResult.data.filter(
          (r) => r.providerTrackId !== track.providerTrackId,
        );
      } else if (recsResult.kind === "failed") {
        recsFailed = true;
      }
    }

    return (
      <div className="flex flex-col gap-8">
        <TrackPlayer track={track} initialLiked={liked} />

        {recommendations.length > 0 ? (
          <section aria-label="Recommended tracks">
            <SectionHeader title="Recommended" />
            <TrackList tracks={recommendations} />
          </section>
        ) : recsFailed ? (
          <section aria-label="Recommended tracks">
            <SectionHeader title="Recommended" />
            <p className="text-sm text-text-muted">Recommendations unavailable.</p>
          </section>
        ) : null}
      </div>
    );
  }

  notFound();
}
