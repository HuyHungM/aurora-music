import Link from "next/link";
import type { Album } from "@/lib/domain";
import { TrackArt } from "@/components/tracks/track-art";

export function AlbumCard({ album }: { album: Album }) {
  const href = `/album/${encodeURIComponent(album.providerAlbumId ?? album.id)}`;
  return (
    <Link
      href={href}
      className="group flex flex-col items-center gap-2 rounded-lg p-3 transition-colors hover:bg-surface-2/60 w-36"
    >
      <TrackArt
        src={album.artwork}
        alt={album.title}
        size={80}
        className="rounded-card"
      />
      <span className="text-center text-sm font-medium text-text-primary truncate w-full">
        {album.title}
      </span>
      <span className="text-center text-xs text-text-muted truncate w-full">
        {album.artistName}
      </span>
    </Link>
  );
}
