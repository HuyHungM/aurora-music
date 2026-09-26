import Link from "next/link";
import type { Artist } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { Artwork } from "@/components/ui/artwork";

export function ArtistCard({ artist, locale = DEFAULT_LOCALE }: { artist: Artist; locale?: Locale }) {
  const t = getT(locale);
  const href = `/artist/${encodeURIComponent(artist.providerArtistId ?? artist.id)}`;
  return (
    <Link
      href={href}
      className="aurora-rise group flex min-w-0 flex-col items-center gap-2.5 rounded-xl border border-transparent p-2 text-center transition-colors hover:border-border-subtle hover:bg-surface-1"
    >
      <Artwork
        src={artist.image}
        alt={artist.name}
        size="medium"
        rounded="rounded-full"
        className="aspect-square h-auto w-full max-w-28"
      />
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="t-card-title truncate">{artist.name}</span>
        <span className="t-metadata truncate">
          {t("artistCard.kindArtist")}{artist.genres?.[0] ? ` · ${artist.genres[0]}` : ""}
        </span>
      </span>
    </Link>
  );
}
