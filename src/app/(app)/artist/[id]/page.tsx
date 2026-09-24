import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchArtistDetail, fetchArtistTracks } from "@/lib/providers/server";
import { isFollowing } from "@/lib/dal/follow";
import { getSessionUserId } from "@/lib/dal/session";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistPlayButton } from "@/components/artist/artist-play-button";
import { FollowButton } from "@/components/artist/follow-button";
import { EmptyState } from "@/components/ui/empty-state";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Artist" };

export default async function ArtistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  const artistResult = await fetchArtistDetail(decodedId);

  if (artistResult.kind === "unsupported" || artistResult.kind === "failed") {
    notFound();
  }

  if (artistResult.kind === "success") {
    const { data: artist } = artistResult;
    const tracksResult = await fetchArtistTracks(decodedId);

    let following = false;
    if (artist.providerArtistId) {
      const userId = await getSessionUserId();
      if (userId) {
        following = await isFollowing(userId, {
          provider: artist.provider,
          providerArtistId: artist.providerArtistId,
        });
      }
    }

    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          {artist.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={artist.image}
              alt={artist.name}
              className="h-48 w-full shrink-0 rounded-xl object-cover sm:w-48"
            />
          ) : (
            <div className="grid h-48 w-full shrink-0 place-items-center rounded-xl bg-gradient-aurora/25 text-text-secondary sm:h-48 sm:w-48">
              <MusicNoteIcon size={64} />
            </div>
          )}
          <div className="flex flex-1 min-w-0 flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-accent">
              Artist
            </span>
            <h1 className="truncate text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              {artist.name}
            </h1>
            {artist.genres && artist.genres.length > 0 ? (
              <p className="flex flex-wrap gap-1 text-sm text-text-muted">
                {artist.genres.slice(0, 5).map((genre, i) => (
                  <span key={genre}>
                    {i > 0 && " \u00B7 "}
                    <span className="truncate">{genre}</span>
                  </span>
                ))}
                {artist.genres.length > 5 && (
                  <span className="text-text-muted">+{artist.genres.length - 5} more</span>
                )}
              </p>
            ) : null}
            {artist.bio ? (
              <p className="max-w-lg text-sm leading-relaxed text-text-muted">
                {artist.bio}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 mt-2">
              {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
                <ArtistPlayButton tracks={tracksResult.data} />
              ) : null}
              <FollowButton artist={artist} initialFollowing={following} />
            </div>
          </div>
        </div>

        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <section aria-label="Artist tracks">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
              Tracks
            </h2>
            <TrackList tracks={tracksResult.data} showMenu={true} />
          </section>
        ) : null}

        {tracksResult.kind === "success" && tracksResult.data.length === 0 ? (
          <EmptyState
            icon={<MusicNoteIcon size={28} />}
            title="No tracks available"
            description="No tracks could be loaded for this artist."
          />
        ) : null}

        {tracksResult.kind === "failed" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/60 px-4 py-3 text-sm text-text-muted">
            <AlertCircleIcon size={16} className="shrink-0" />
            <span>Tracks unavailable for this artist.</span>
          </div>
        ) : null}

        {tracksResult.kind === "unsupported" ? null : null}
      </div>
    );
  }

  notFound();
}
