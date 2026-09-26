"use client";

import type { Track } from "@/lib/domain";
import { useLocale } from "@/components/i18n/locale-provider";
import { CollectionPlayButton } from "@/components/ui/collection-play-button";

export function AlbumPlayButton({ tracks }: { tracks: Track[] }) {
  const { t } = useLocale();
  return <CollectionPlayButton tracks={tracks} label={t("album.playAlbum")} />;
}
