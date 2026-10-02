import { notFound } from "next/navigation";
import type { Track } from "@/lib/domain";
import { getE2EPlaybackFixtureAction } from "@/app/actions/e2e-fixture";
import { FIXTURE_B } from "@/lib/e2e/fixture-ids";
import { TrackPlayer } from "../../track/[id]/track-player";
import { E2EQueueControls } from "./e2e-queue-controls";
import { E2EMediaProbe } from "./e2e-media-probe";

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
  // A SECOND, DISTINCT recording.
  //
  // This used to reuse `primary.providerTrackId` under a different title,
  // which is a lie the product is right to reject: `replaceQueue` runs
  // `dedupeCanonicalTracks`, whose canonical key is `provider:providerTrackId`
  // (`lib/domain/track-dedupe.ts`), so two entries sharing one provider id are
  // the same song and collapse to one. Every queue-length assertion in the
  // live suite was therefore unreachable - the scenarios asserting "2 tracks"
  // could never pass, and three tests failed on every opt-in run.
  //
  // The secondary needs a real id of its own so it is genuinely a different
  // song, resolves independently, and survives the dedupe the way two real
  // tracks do. It is the same fixture track the primary resolves from, with a
  // distinct id, exactly as a second catalogue row would be.
  const secondary: Track = {
    ...primary,
    id: `${primary.providerTrackId}-b`,
    providerTrackId: FIXTURE_B.providerTrackId,
    title: "E2E Fixture B",
    artistId: "e2e-fixture",
    artistName: primary.artistName,
  };

  return (
    <div className="flex flex-col gap-8">
      <TrackPlayer track={primary} initialLiked={false} />
      <E2EQueueControls tracks={[primary, secondary]} />
      {/* Read-only media-state probe, so playback assertions read the real
          audio element instead of the controls. See `e2e-media-probe.tsx`. */}
      <E2EMediaProbe />
    </div>
  );
}
