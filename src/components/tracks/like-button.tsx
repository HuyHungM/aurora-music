"use client";

import { useState, useTransition } from "react";
import type { Track } from "@/lib/domain";
import { HeartIcon } from "@/components/ui/icons";
import {
  likeTrackAction,
  unlikeTrackAction,
} from "@/app/actions/track";

export function LikeButton({
  track,
  initialLiked,
  size = 18,
  className,
}: {
  track: Track;
  initialLiked: boolean;
  size?: number;
  className?: string;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [isPending, startTransition] = useTransition();

  const handleLike = () => {
    const nextLiked = !liked;
    setLiked(nextLiked);
    startTransition(async () => {
      if (nextLiked) {
        const result = await likeTrackAction(track);
        if (!result.ok) {
          setLiked(false);
        }
      } else {
        const result = await unlikeTrackAction(track);
        if (!result.ok) {
          setLiked(true);
        }
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleLike}
      disabled={isPending}
      aria-pressed={liked}
      aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors ${
        liked
          ? "border-accent bg-accent/10 text-accent"
          : "border-border-strong bg-surface-3 text-text-secondary hover:border-accent/50 hover:text-accent"
      } ${className ?? ""}`}
    >
      <HeartIcon
        size={size}
        className={liked ? "fill-accent" : ""}
      />
    </button>
  );
}
