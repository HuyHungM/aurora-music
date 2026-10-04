"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { Artist } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { CheckIcon, PlusIcon } from "@/components/ui/icons";
import {
  followArtistAction,
  unfollowArtistAction,
} from "@/app/actions/artist";
import { requestAuthPrompt } from "@/components/tracks/liked-tracks";
import { useLocale } from "@/components/i18n/locale-provider";
import { followNotifications } from "@/components/ui/notify-events";

export function FollowButton({
  artist,
  initialFollowing,
  isAuthenticated,
}: {
  artist: Artist;
  initialFollowing: boolean;
  /**
   * Whether a signed-in session exists. REQUIRED, with no default, on purpose:
   * when false, a failed mutation raises the shared sign-in prompt instead of
   * failing silently. The previous `= true` default meant a call site that
   * forgot the prop silently assumed "signed in" and swallowed the prompt for
   * anonymous users — a missing prop must fail at compile time, not at runtime
   * in front of a logged-out user.
   */
  isAuthenticated: boolean;
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
  const follow = followNotifications(t);

  // Which artist is on screen RIGHT NOW, readable from a continuation that
  // captured its own `artistKey` at submit time. Without it, following artist A
  // and navigating to artist B while A's mutation is in flight let A's
  // resolution write A's outcome onto B's button and toast A's name.
  const artistKeyRef = useRef(artistKey);
  useEffect(() => {
    artistKeyRef.current = artistKey;
  }, [artistKey]);

  const handleFollow = () => {
    // The PREVIOUS value, not a hardcoded opposite. The rollback restores what
    // was actually on screen; `setFollowing(false)`/`setFollowing(true)` were
    // only correct because the two branches happened to pair up, and they
    // clobbered the reconciled state above whenever the artist changed
    // mid-flight.
    const previous = following;
    const nextFollowing = !previous;
    const submittedFor = artistKey;
    const submittedName = artist.name;
    setFollowing(nextFollowing);

    startTransition(async () => {
      // ONE failure path for every way this can go wrong.
      //
      // `followArtistAction`/`unfollowArtistAction` catch internally and
      // return `{ ok: false }`, but a REJECTED action — transport drop,
      // navigation abort — never reaches that branch at all. Before this
      // `try`/`catch` the optimistic flip was permanent on rejection: the
      // button claimed a state the database did not have, with no toast and no
      // prompt. `liked-tracks.tsx` has had this catch all along; follow never
      // got the fix.
      const fail = () => {
        setFollowing(previous);
        if (!isAuthenticated) {
          requestAuthPrompt();
        } else {
          follow.failed();
        }
      };

      try {
        const result = nextFollowing
          ? await followArtistAction(artist)
          : await unfollowArtistAction(artist);

        // A newer artist owns the button now; this continuation is stale.
        if (submittedFor !== artistKeyRef.current) return;

        if (!result.ok) {
          fail();
          return;
        }
        if (nextFollowing) {
          follow.followed(submittedName);
        } else {
          follow.unfollowed(submittedName);
        }
      } catch {
        if (submittedFor !== artistKeyRef.current) return;
        fail();
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
