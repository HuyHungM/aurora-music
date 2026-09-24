import Link from "next/link";
import type { Artist } from "@/lib/domain";
import { TrackArt } from "@/components/tracks/track-art";

export function ArtistCard({ artist }: { artist: Artist }) {
  const href = `/artist/${encodeURIComponent(artist.providerArtistId ?? artist.id)}`;
  return (
    <Link
      href={href}
      className="group flex flex-col items-center gap-2 rounded-lg p-3 transition-colors hover:bg-surface-2/60 w-36"
    >
      <TrackArt
        src={artist.image}
        alt={artist.name}
        size={80}
        className="rounded-card"
      />
      <span className="text-center text-sm font-medium text-text-primary truncate w-full">
        {artist.name}
      </span>
      {artist.genres && artist.genres.length > 0 ? (
        <span className="text-center text-xs text-text-muted truncate w-full">
          {artist.genres[0]}
        </span>
      ) : null}
    </Link>
  );
}
