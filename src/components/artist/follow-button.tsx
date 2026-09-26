"use client";

import { useState, useTransition } from "react";
import type { Artist } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { CheckIcon, PlusIcon } from "@/components/ui/icons";
import {
  followArtistAction,
  unfollowArtistAction,
} from "@/app/actions/artist";
import { requestAuthPrompt } from "@/components/tracks/liked-tracks";
import { useLocale } from "@/components/i18n/locale-provider";

export function FollowButton({
  artist,
  initialFollowing,
  isAuthenticated = true,
}: {
  artist: Artist;
  initialFollowing: boolean;
  /**
   * When false, a failed mutation raises the shared sign-in prompt
   * instead of failing silently. Defaults to true (silent rollback)
   * to preserve standalone behavior.
   */
  isAuthenticated?: boolean;
}) {
  // Client-side navigation between two artist routes reconciles the same
  // element in the same position, so React preserves this component's state
  // and only the props change. Without the re-sync below the button kept the
  // previous artist's follow state, and a click sent the opposite action for
  // the artist now on screen (e.g. showing "Following" on an unfollowed
  // artist, then dispatching unfollow). `initialFollowing` is the only source
  // of truth here, so it must win whenever the artist changes.
  //
  // Reconciliation is deliberately keyed on the artist ALONE. Also keying it on
  // `initialFollowing` reads as more correct and was tried during the final
  // audit; it is wrong. React preserves this component's state across a server
  // re-render, so an optimistic value that is still in flight is correct and
  // must not be clobbered by a revalidation that re-read the table before the
  // write was visible. The optimistic value is a deliberate overlay on server
  // truth, not a second authority over it.
  const artistKey = `${artist.provider}:${artist.providerArtistId ?? artist.id}`;
  const [syncedArtistKey, setSyncedArtistKey] = useState(artistKey);
  const [following, setFollowing] = useState(initialFollowing);
  if (syncedArtistKey !== artistKey) {
    setSyncedArtistKey(artistKey);
    setFollowing(initialFollowing);
  }
  const [isPending, startTransition] = useTransition();
  const { t } = useLocale();

  const handleFollow = () => {
    const nextFollowing = !following;
    setFollowing(nextFollowing);
    startTransition(async () => {
      if (nextFollowing) {
        const result = await followArtistAction(artist);
        if (!result.ok) {
          setFollowing(false);
          if (!isAuthenticated) {
            requestAuthPrompt();
          }
        }
      } else {
        const result = await unfollowArtistAction(artist);
        if (!result.ok) {
          setFollowing(true);
          if (!isAuthenticated) {
            requestAuthPrompt();
          }
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
      aria-label={following ? t("artist.unfollowLabel", { name: artist.name }) : t("artist.followLabel", { name: artist.name })}
      className="gap-1.5"
    >
      {following ? (
        <>
          <CheckIcon size={16} />
          <span>{t("artist.following")}</span>
        </>
      ) : (
        <>
          <PlusIcon size={16} />
          <span>{t("artist.follow")}</span>
        </>
      )}
    </Button>
  );
}
