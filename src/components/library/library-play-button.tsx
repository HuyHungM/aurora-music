"use client";

import type { Track } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { useLocale } from "@/components/i18n/locale-provider";
import { CollectionPlayButton } from "@/components/ui/collection-play-button";
import { Button } from "@/components/ui/button";
import { ShuffleIcon } from "@/components/ui/icons";

export function LibraryPlayButton({
  tracks,
  labelKey,
  shuffle = false,
}: {
  tracks: Track[];
  /** Translation key for the Play/Shuffle accessible names. */
  labelKey: string;
  /** Shuffle-play: start the collection with shuffle enabled. */
  shuffle?: boolean;
}) {
  const engine = useMusicEngine();
  const isShuffled = useMusicEngineState((s) => s.shuffle);
  const { t } = useLocale();
  const playLabel = t(labelKey);
  const shuffleLabel = t("collectionPlay.shuffle");

  if (!shuffle) {
    return <CollectionPlayButton tracks={tracks} label={playLabel} />;
  }

  const handleShufflePlay = () => {
    if (tracks.length === 0) {
      return;
    }
    engine?.playCollection(tracks, 0);
    if (!isShuffled) {
      engine?.shuffle();
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleShufflePlay}
      aria-label={shuffleLabel}
      className="aurora-press gap-1.5"
    >
      <ShuffleIcon size={16} />
      <span>{t("collectionPlay.shuffle")}</span>
    </Button>
  );
}
