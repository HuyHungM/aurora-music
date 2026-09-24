import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchAlbumDetail, fetchAlbumTracks } from "@/lib/providers/server";
import { TrackList } from "@/components/tracks/track-list";
import { AlbumPlayButton } from "@/components/album/album-play-button";
import { EmptyState } from "@/components/ui/empty-state";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Album" };

export default async function AlbumDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  const albumResult = await fetchAlbumDetail(decodedId);

  if (albumResult.kind === "unsupported" || albumResult.kind === "failed") {
    notFound();
  }

  if (albumResult.kind === "success") {
    const { data: album } = albumResult;
    const tracksResult = await fetchAlbumTracks(decodedId);

    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          {album.artwork ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={album.artwork}
              alt={album.title}
              className="h-48 w-full shrink-0 rounded-xl object-cover sm:w-48"
            />
          ) : (
            <div className="grid h-48 w-full shrink-0 place-items-center rounded-xl bg-gradient-aurora/25 text-text-secondary sm:h-48 sm:w-48">
              <MusicNoteIcon size={64} />
            </div>
          )}
          <div className="flex flex-1 min-w-0 flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-accent">
              Album
            </span>
            <h1 className="truncate text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              {album.title}
            </h1>
            <p className="text-sm text-text-muted">{album.artistName}</p>
            {album.releaseDate ? (
              <p className="text-xs text-text-muted">{album.releaseDate}</p>
            ) : null}
            {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
              <div className="mt-2">
                <AlbumPlayButton tracks={tracksResult.data} />
              </div>
            ) : null}
          </div>
        </div>

        {tracksResult.kind === "success" && tracksResult.data.length > 0 ? (
          <section aria-label="Album tracks">
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
            description="No tracks could be loaded for this album."
          />
        ) : null}

        {tracksResult.kind === "failed" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/60 px-4 py-3 text-sm text-text-muted">
            <AlertCircleIcon size={16} className="shrink-0" />
            <span>Tracks unavailable for this album.</span>
          </div>
        ) : null}

        {tracksResult.kind === "unsupported" ? null : null}
      </div>
    );
  }

  notFound();
}
