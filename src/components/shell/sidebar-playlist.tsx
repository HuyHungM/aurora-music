"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MusicNoteIcon } from "@/components/ui/icons";

/**
 * The minimal shape the sidebar needs from a playlist.
 *
 * Deliberately not the full `Playlist` domain object: it carries `items`
 * (every track in every playlist), and this component is a client component,
 * so passing the domain object would serialize every membership of every
 * playlist into the RSC payload of EVERY page. `id` and `title` are all the
 * rail renders, so they are all that crosses the boundary.
 *
 * No artwork thumbnail for the same reason and one more: `Artwork` loads
 * `unoptimized`, so a 20px rail chip would download the full-resolution cover
 * once per playlist. A list of icons costs one glyph, not N images.
 */
export interface SidebarPlaylistSummary {
  id: string;
  title: string;
}

/**
 * One real playlist in the navigation rail (Stitch sidebar). A `Link`, not a
 * button: a playlist is a deep-linkable route and must survive a new tab, a
 * copy and the back button. `aria-current` marks where you are, because a
 * rail full of links that never indicates the active one is a rail people
 * stop trusting.
 */
export function SidebarPlaylistLink({
  playlist,
}: {
  playlist: SidebarPlaylistSummary;
}) {
  const pathname = usePathname();
  const href = `/library/playlists/${playlist.id}`;
  const active = pathname === href;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`aurora-touch group flex select-none items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-accent/12 font-medium text-accent"
          : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      }`}
    >
      <MusicNoteIcon
        size={16}
        className="shrink-0 opacity-70"
        aria-hidden="true"
      />
      <span className="truncate">{playlist.title}</span>
    </Link>
  );
}
