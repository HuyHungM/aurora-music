import Link from "next/link";
import type { Playlist } from "@/lib/domain";
import { MusicNoteIcon } from "@/components/ui/icons";

export function PlaylistCard({ playlist }: { playlist: Playlist }) {
  return (
    <Link
      href={`/library/playlists/${playlist.id}`}
      className="group flex flex-col gap-2 rounded-card border border-border-subtle bg-surface-1 p-3 transition-colors hover:border-accent/40"
    >
      <span className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-gradient-aurora/25 text-text-secondary">
        <MusicNoteIcon size={40} />
      </span>
      <span className="flex flex-col gap-0.5 px-0.5">
        <span className="truncate text-sm font-semibold text-text-primary">
          {playlist.title}
        </span>
        <span className="text-xs text-text-muted">
          {playlist.description
            ? `${playlist.description} · ${playlist.items.length} track${playlist.items.length === 1 ? "" : "s"}`
            : `${playlist.items.length} track${playlist.items.length === 1 ? "" : "s"}`}
        </span>
      </span>
    </Link>
  );
}