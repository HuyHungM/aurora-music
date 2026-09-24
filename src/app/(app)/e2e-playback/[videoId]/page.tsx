import { notFound } from "next/navigation";
import type { Track } from "@/lib/domain";
import { getE2EPlaybackFixtureAction } from "@/app/actions/e2e-fixture";
import { TrackPlayer } from "../../track/[id]/track-player";
import { E2EQueueControls } from "./e2e-queue-controls";

/**
 * Deterministic live-playback fixture route.
 *
 * Available ONLY when AURORA_E2E_LIVE_PLAYBACK=1 (otherwise 404). Renders
 * the REAL TrackPlayer + queue controls against a real YouTube id through
 * the unmodified production path (TrackPlayer -> MusicEngine ->
 * PlaybackController -> PlaybackResolver -> PlayerEngine -> audio element).
 * No fakes, no test-only bypasses, no stored URLs.
 */
export default async function E2EPlaybackFixturePage({
  params,
  searchParams,
}: {
  params: Promise<{ videoId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { videoId } = await params;
  // Deterministic route-boundary probe for E2E: throws before any provider
  // contact so the (app) error boundary can be exercised without network.
  if ((await searchParams).boom !== undefined) {
    throw new Error("E2E route boundary probe");
  }
  const fixture = await getE2EPlaybackFixtureAction(videoId);
  if (!fixture.ok) {
    notFound();
  }
  const primary: Track = fixture.track;
  const secondary: Track = {
    id: `${primary.providerTrackId}-b`,
    provider: "youtube",
    providerTrackId: primary.providerTrackId,
    title: "E2E Fixture B",
    artistId: "e2e-fixture",
    artistName: "E2E fixture",
  };

  return (
    <div className="flex flex-col gap-8">
      <TrackPlayer track={primary} initialLiked={false} />
      <E2EQueueControls tracks={[primary, secondary]} />
    </div>
  );
}
