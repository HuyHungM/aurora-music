import Link from "next/link";
import type { Album } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { Artwork } from "@/components/ui/artwork";

export function AlbumCard({ album, locale = DEFAULT_LOCALE }: { album: Album; locale?: Locale }) {
  const t = getT(locale);
  const href = `/album/${encodeURIComponent(album.providerAlbumId ?? album.id)}`;
  return (
    <Link
      href={href}
      className="aurora-rise aurora-glass-edge group flex min-w-0 flex-col gap-2.5 rounded-xl border border-border-subtle bg-surface-1/60 p-2 transition-colors hover:border-accent/40 hover:bg-surface-1"
    >
      <span className="relative block overflow-hidden rounded-lg ring-1 ring-white/[0.06]">
        <Artwork
          src={album.artwork}
          alt={album.title}
          size="medium"
          rounded="rounded-lg"
          className="aspect-square h-auto w-full"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100"
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="t-card-title truncate">{album.title}</span>
        <span className="t-metadata truncate">{t("albumCard.kindAlbum")} · {album.artistName}</span>
      </span>
    </Link>
  );
}
