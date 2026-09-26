"use client";

import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { collectionPlayability } from "@/lib/player/track-capabilities";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayIcon } from "@/components/ui/icons";

/**
 * Single collection-play implementation (Phase 36 consolidation,
 * Phase 37 capability gating). Album / artist / playlist / library
 * buttons keep their module paths and aria-labels but share this
 * behavior and visual language.
 *
 * A collection exposes Play when ANY member can attempt playback
 * (capability model, not provider identity). An all-catalog-only
 * collection renders an honest disabled state instead of a Play
 * button guaranteed to fail.
 */
export function CollectionPlayButton({
  tracks,
  label,
}: {
  tracks: Track[];
  label: string;
}) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const playability = collectionPlayability(tracks);

  const handleClick = () => {
    if (tracks.length === 0) return;
    engine?.playCollection(tracks, 0);
  };

  if (playability === "catalog-only") {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled
        aria-label={t("collectionPlay.unavailableCollection")}
        title={t("track.playbackUnavailable")}
        className="gap-1.5"
      >
        <PlayIcon size={16} />
        <span>{t("collectionPlay.unavailable")}</span>
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClick}
      aria-label={label}
      className="aurora-press gap-1.5"
    >
      <PlayIcon size={16} />
      <span>{t("collectionPlay.play")}</span>
    </Button>
  );
}
