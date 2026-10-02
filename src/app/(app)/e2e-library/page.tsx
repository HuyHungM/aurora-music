import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/dal/session";
import { isTrackLiked } from "@/lib/dal/like";
import { mapTrackRow } from "@/lib/dal/mappers";
import { LikeButton } from "@/components/tracks/like-button";
import { FollowButton } from "@/components/artist/follow-button";
import { TrackRow } from "@/components/tracks/track-row";
import { isFollowing } from "@/lib/dal/follow";
import { E2E_AUTH_FLAG } from "@/../e2e/auth/constants";

export const metadata: Metadata = { title: "E2E fixture library" };

/**
 * Deterministic fixture surface for authenticated persistence journeys
 * (Phase 30). Renders REAL production components — LikeButton and
 * TrackRow with its track-action/add-to-playlist menus — against the
 * seeded `e2e-` catalog rows, so browser tests exercise the genuine
 * server-action → requireUser → DAL → Prisma path without any live
 * provider.
 *
 * Test-only by construction: without AURORA_E2E_AUTH=1 this renders
 * the standard not-found boundary (same pattern as /e2e-playback).
 * It is unreachable from any production navigation.
 */
export default async function E2EFixtureLibraryPage() {
  if (process.env[E2E_AUTH_FLAG] !== "1") {
    notFound();
  }

  const rows = await prisma.track.findMany({
    where: { providerTrackId: { startsWith: "e2e-" } },
    include: { artist: true, album: true },
    orderBy: { providerTrackId: "asc" },
  });
  const tracks = rows.map(mapTrackRow);

  const userId = await getSessionUserId();
  const liked = new Map<string, boolean>();
  if (userId) {
    for (const track of tracks) {
      liked.set(
        track.id,
        await isTrackLiked(userId, {
          provider: track.provider,
          providerTrackId: track.id,
        }),
      );
    }
  }

  const fixtureArtist =
    tracks.length > 0
      ? {
          id: tracks[0].artistId,
          provider: tracks[0].provider,
          providerArtistId: tracks[0].artistId,
          name: tracks[0].artistName,
        }
      : null;
  const artistFollowing =
    userId && fixtureArtist
      ? await isFollowing(userId, {
          provider: fixtureArtist.provider,
          providerArtistId: fixtureArtist.providerArtistId,
        })
      : false;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          E2E fixture library
        </h1>
        <p className="text-sm text-text-muted">
          Deterministic catalog for authenticated persistence tests.
        </p>
      </div>

      {fixtureArtist ? (
        <div className="flex items-center gap-3 rounded-card border border-border-subtle bg-surface-1 p-4">
          <FollowButton
            artist={fixtureArtist}
            initialFollowing={artistFollowing}
            isAuthenticated={userId !== null}
          />
          <span className="text-sm text-text-muted">
            {fixtureArtist.name} — {artistFollowing ? "Following" : "Not following"}
          </span>
        </div>
      ) : null}

      {tracks.length === 0 ? (
        <p className="text-sm text-text-muted">
          No fixture tracks seeded. Run the authenticated E2E setup first.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {tracks.map((track) => (
            <li
              key={`${track.provider}:${track.id}`}
              className="flex flex-col gap-3 rounded-card border border-border-subtle bg-surface-1 p-4"
            >
              <div className="flex items-center gap-3">
                <LikeButton
                  track={track}
                  initialLiked={liked.get(track.id) ?? false}
                  isAuthenticated={userId !== null}
                />
                <span className="text-sm text-text-muted">
                  {liked.get(track.id) ? "Liked" : "Not liked"}
                </span>
              </div>
              <TrackRow
                track={track}
                collectionTracks={tracks}
                showMenu={true}
                showAddToPlaylist={true}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
