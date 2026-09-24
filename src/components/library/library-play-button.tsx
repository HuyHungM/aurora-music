"use client";

import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { Button } from "@/components/ui/button";
import { PlayIcon } from "@/components/ui/icons";

export function LibraryPlayButton({
  tracks,
  label,
}: {
  tracks: Track[];
  label: string;
}) {
  const engine = useMusicEngine();

  const handleClick = () => {
    if (tracks.length === 0) return;
    engine?.playCollection(tracks, 0);
  };

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClick}
      aria-label={`Play ${label}`}
      className="gap-1.5"
    >
      <PlayIcon size={16} />
      <span>Play</span>
    </Button>
  );
}
