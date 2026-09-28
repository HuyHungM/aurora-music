import Link from "next/link";
import type { Playlist } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT, plural } from "@/lib/i18n/translate";
import { Artwork } from "@/components/ui/artwork";

export function PlaylistCard({ playlist, locale = DEFAULT_LOCALE }: { playlist: Playlist; locale?: Locale }) {
  const t = getT(locale);
  const count = playlist.items.length;
  return (
    <Link
      href={`/library/playlists/${playlist.id}`}
      className="aurora-rise aurora-glass-edge group flex min-w-0 flex-col gap-2.5 rounded-xl border border-border-subtle bg-surface-1 p-2 transition-colors hover:border-accent/40"
    >
      <span className="relative block overflow-hidden rounded-lg ring-1 ring-white/[0.06]">
        <Artwork
          src={playlist.artwork}
          alt={playlist.title}
          size="medium"
          rounded="rounded-lg"
          className="aspect-square h-auto w-full"
        />
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 pb-2 pt-6 text-left text-[11px] font-medium text-white"
        >
          {plural(locale, count, {
            one: t("playlistCard.tracksCountOne", { count }),
            other: t("playlistCard.tracksCount", { count }),
          })}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5 pb-1">
        <span className="t-card-title truncate">{playlist.title}</span>
        <span className="t-metadata truncate">
          {t("playlistCard.kindPlaylist")}{playlist.description ? ` · ${playlist.description}` : ""}
        </span>
      </span>
    </Link>
  );
}
