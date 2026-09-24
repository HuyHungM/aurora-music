"use client";

import type { Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { Button } from "@/components/ui/button";
import { PlayIcon } from "@/components/ui/icons";

export function ArtistPlayButton({ tracks }: { tracks: Track[] }) {
  const engine = useMusicEngine();

  const handleClick = () => {
    engine?.playCollection(tracks, 0);
  };

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClick}
      aria-label="Play artist"
      className="gap-1.5"
    >
      <PlayIcon size={16} />
      <span>Play</span>
    </Button>
  );
}
