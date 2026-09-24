"use client";

import { useState, useTransition } from "react";
import type { Artist } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { CheckIcon, PlusIcon } from "@/components/ui/icons";
import {
  followArtistAction,
  unfollowArtistAction,
} from "@/app/actions/artist";

export function FollowButton({
  artist,
  initialFollowing,
}: {
  artist: Artist;
  initialFollowing: boolean;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [isPending, startTransition] = useTransition();

  const handleFollow = () => {
    const nextFollowing = !following;
    setFollowing(nextFollowing);
    startTransition(async () => {
      if (nextFollowing) {
        const result = await followArtistAction(artist);
        if (!result.ok) {
          setFollowing(false);
        }
      } else {
        const result = await unfollowArtistAction(artist);
        if (!result.ok) {
          setFollowing(true);
        }
      }
    });
  };

  return (
    <Button
      variant={following ? "secondary" : "primary"}
      size="sm"
      onClick={handleFollow}
      disabled={isPending}
      aria-pressed={following}
      aria-label={following ? `Unfollow ${artist.name}` : `Follow ${artist.name}`}
      className="gap-1.5"
    >
      {following ? (
        <>
          <CheckIcon size={16} />
          <span>Following</span>
        </>
      ) : (
        <>
          <PlusIcon size={16} />
          <span>Follow</span>
        </>
      )}
    </Button>
  );
}
