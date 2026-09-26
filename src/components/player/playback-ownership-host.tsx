"use client";

/**
 * Multi-tab playback ownership, bound to the existing player (Phase 52,
 * RULE 18-21).
 *
 * This component owns no playback state of its own. It observes the one
 * existing player store and calls the one existing `pause()`/`play()`, so
 * there is still exactly one playback authority and exactly one queue authority
 * (RULE 4). What it adds is a rule for *which tab* is allowed to be audible,
 * not a second player.
 *
 * The rule, in full:
 * - Playback starting in a tab claims ownership and tells the others.
 * - A tab that hears a newer claim pauses itself. Audio therefore never
 *   overlaps by more than one message round trip, and the paused tab says why
 *   instead of going mysteriously quiet.
 * - Stopping releases the claim, so closing a tab hands playback back at once
 *   rather than after a lease timeout.
 * - A tab whose owner stopped heartbeating writes the claim off and may claim
 *   for itself, which is the crash case.
 *
 * What it deliberately does not do: synchronise queues between tabs. RULE 19
 * asks for one consistent policy, and the honest one here is isolation. Two
 * tabs are two independent listening sessions; merging their queues would make
 * "add to queue" mean something different depending on which tab you were
 * looking at, and would fight the per-tab session persistence that already
 * exists. Ownership is shared; content is not.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { usePlayerStore } from "@/lib/player/store";
import { logger } from "@/lib/diagnostics/logger";
import { useLocale } from "@/components/i18n/locale-provider";
import {
  createPlaybackOwnership,
  type OwnershipSnapshot,
} from "@/lib/multi-tab/playback-ownership";
import { createOwnershipTransport } from "@/lib/multi-tab/ownership-transport";
import { setPlaybackOwnership } from "@/lib/multi-tab/instance";

/**
 * Rendered on the server and for the first client render. A single tab is
 * always uncontended, so there is never a notice to show before the machine
 * exists - which also keeps hydration clean.
 */
const IDLE_SNAPSHOT: OwnershipSnapshot = {
  role: "idle",
  ownerTabId: null,
  ownerEpoch: 0,
  ownerAlive: false,
};

export function PlaybackOwnershipHost() {
  const { t } = useLocale();

  // The machine and its transport are created in lazy state initializers, NOT
  // in the mount effect. Both need `window`, so the server render must produce
  // `null`; and a StrictMode double-render would build - and throw away - a
  // second pair, which is harmless here precisely because
  // `createOwnershipTransport` opens its `BroadcastChannel` inside `start()`,
  // not at construction. Nothing is allocated until the effect below commits,
  // and only the surviving instance is ever started.
  //
  // The effect is left with the two things that genuinely belong in one: start
  // the transport, and stop it on unmount. Creating state inside an effect
  // instead would cost an extra render pass on every mount and would trip the
  // cascading-render lint rule.
  const [ownership] = useState<ReturnType<typeof createPlaybackOwnership> | null>(
    () => (typeof window === "undefined" ? null : createPlaybackOwnership()),
  );
  const [transport] = useState<ReturnType<
    typeof createOwnershipTransport
  > | null>(() =>
    typeof window === "undefined" || ownership === null
      ? null
      : createOwnershipTransport(ownership),
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      ownership ? ownership.subscribe(onStoreChange) : () => {},
    [ownership],
  );
  const getSnapshot = useCallback(
    () => ownership?.getSnapshot() ?? IDLE_SNAPSHOT,
    [ownership],
  );
  const getServerSnapshot = useCallback(() => IDLE_SNAPSHOT, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!ownership || !transport) {
      return;
    }
    // Publish the machine so the persistence controller can ask the same
    // authority which tab is the live listening session. Held for exactly
    // the mounted lifetime, alongside `transport.start()`.
    setPlaybackOwnership(ownership);
    const stop = transport.start();
    logger.debug("Multi-tab playback ownership started", {
      event: "playback_ownership_started",
      supported: transport.supported,
    });
    return () => {
      setPlaybackOwnership(null);
      stop();
      logger.debug("Multi-tab playback ownership stopped", {
        event: "playback_ownership_stopped",
      });
    };
  }, [ownership, transport]);

  // Claim on the paused -> playing edge only. Claiming on every store change
  // would re-claim on every render tick and starve the heartbeat.
  useEffect(() => {
    if (!ownership || !transport) {
      return;
    }
    // Seeded from the live value, not `false`: a session restored already
    // playing must claim on mount, or this tab would be audible while another
    // tab believed it owned playback.
    let wasPlaying = usePlayerStore.getState().isPlaying;
    if (wasPlaying) {
      transport.broadcast(ownership.claim());
    }
    return usePlayerStore.subscribe((state) => {
      if (state.isPlaying === wasPlaying) {
        return;
      }
      wasPlaying = state.isPlaying;
      if (state.isPlaying) {
        transport.broadcast(ownership.claim());
      } else {
        transport.broadcast(ownership.release());
      }
    });
  }, [ownership, transport]);

  // Yield when another tab takes over. This is the only place the host touches
  // playback, and it does so through the store's own `pause()`.
  useEffect(() => {
    if (!ownership) {
      return;
    }
    return ownership.subscribe(() => {
      const view = ownership.getSnapshot();
      if (view.role === "contender" && usePlayerStore.getState().isPlaying) {
        logger.info("Playback yielded to another tab", {
          event: "playback_ownership_yielded",
        });
        usePlayerStore.getState().pause();
      }
    });
  }, [ownership]);

  const takeOver = useCallback(() => {
    if (!ownership || !transport) {
      return;
    }
    transport.broadcast(ownership.takeover());
    void usePlayerStore.getState().play();
  }, [ownership, transport]);

  // Only a live, foreign claim is worth telling the user about. A lapsed lease
  // clears itself on the next tick, and the owner's own claim is not news.
  if (snapshot.role !== "contender" || !snapshot.ownerAlive) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-toast mx-auto flex w-max max-w-[90%] items-center gap-2 rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs text-text-secondary shadow-lg"
    >
      <span className="truncate">{t("multiTab.playingElsewhere")}</span>
      <button
        type="button"
        onClick={takeOver}
        className="shrink-0 font-medium text-text-primary underline underline-offset-2 select-none"
      >
        {t("multiTab.takeOver")}
      </button>
    </div>
  );
}
