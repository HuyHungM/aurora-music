"use client";

import { useState, useTransition } from "react";
import type { Track } from "@/lib/domain";
import { HeartIcon } from "@/components/ui/icons";
import {
  likeTrackAction,
  unlikeTrackAction,
} from "@/app/actions/track";
import { useLikedTrack, requestAuthPrompt } from "./liked-tracks";
import { useLocale } from "@/components/i18n/locale-provider";
import { likeNotifications } from "@/components/ui/notify-events";

export function LikeButton({
  track,
  initialLiked,
  isAuthenticated,
  size = 18,
  className,
}: {
  track: Track;
  initialLiked: boolean;
  /**
   * Whether a signed-in session exists. Governs ONLY the standalone path
   * (rendered without a `LikedTracksProvider`): when false, a failed mutation
   * raises the shared sign-in prompt instead of failing silently.
   *
   * Ignored when a provider is present — the shared `toggle` already carries
   * the provider's own `isAuthenticated` in its closure, so the prop cannot
   * contradict it. Omitted standalone keeps the previous silent-rollback
   * behavior, which is what the standalone unit-test path relies on; every
   * production call site passes it explicitly.
   */
  isAuthenticated?: boolean;
  size?: number;
  className?: string;
}) {
  // Shared liked mirror when mounted inside the app shell (rows, player,
  // track page stay synchronized); self-contained optimistic state when
  // rendered standalone (unit tests, isolated surfaces).
  const shared = useLikedTrack(track);
  const { t } = useLocale();
  const like = likeNotifications(t);
  const [localLiked, setLocalLiked] = useState(initialLiked);
  const [isPending, startTransition] = useTransition();

  const liked = shared ? shared.liked : localLiked;
  const pending = shared ? shared.pending : isPending;

  const handleLike = () => {
    if (shared) {
      shared.toggle();
      return;
    }
    // The PREVIOUS value, captured at submit, so the rollback restores what was
    // actually on screen rather than assuming the two branches pair up.
    const previousLiked = localLiked;
    const nextLiked = !previousLiked;
    setLocalLiked(nextLiked);
    startTransition(async () => {
      // ONE failure path, covering both `{ ok: false }` and a REJECTED action.
      // The sibling shared path (`liked-tracks.tsx`) has always had this
      // `catch`; the standalone branch did not, so a transport drop or a
      // navigation abort left the optimistic flip permanent — the button
      // pressed in, no row moved, no toast, no explanation.
      const fail = () => {
        setLocalLiked(previousLiked);
        // The shared path prompts through the provider's own auth flag; the
        // standalone path has only this prop. Without it an anonymous tap
        // fails and rolls back with no explanation.
        if (isAuthenticated === false) {
          requestAuthPrompt();
        } else {
          like.failed();
        }
      };

      try {
        const result = nextLiked
          ? await likeTrackAction(track)
          : await unlikeTrackAction(track);
        if (!result.ok) {
          fail();
          return;
        }
        if (nextLiked) {
          like.liked(track);
        } else {
          like.unliked(track);
        }
      } catch {
        fail();
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleLike}
      disabled={pending}
      aria-pressed={liked}
      aria-label={liked ? t("track.unlikeLabel", { title: track.title }) : t("track.likeLabel", { title: track.title })}
      // `aurora-touch` (Phase 54). Measured 40x40 on every phone and tablet
      // width: `h-10 w-10` is a desktop density for a control that is the
      // only like affordance in a row, and 40px is under the 44px floor. The
      // floor is opt-in per call site rather than a blanket `button` rule, so
      // a 4px growth in the row width is a decision made here: the title is
      // already `truncate`, so it yields, and the like state stays legible.
      className={`aurora-touch grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50 ${
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
