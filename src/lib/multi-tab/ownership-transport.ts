"use client";

/**
 * BroadcastChannel transport for playback ownership (Phase 52, RULE 18).
 *
 * The only job of this file is to move `OwnershipMessage`s between tabs. All
 * the decisions live in the pure machine, which is why this one is short.
 *
 * `BroadcastChannel` is the right primitive here and it is well supported
 * (Chrome, Edge, Firefox, and Safari 15.4+). When it is missing - an old
 * embedded webview, a locked-down corporate browser - the correct behaviour is
 * to do nothing at all, not to fall back to a cross-tab storage event: that
 * fallback would need a shared key and would make the ownership decision depend
 * on storage quota and eviction, which is a much larger failure surface than
 * "multi-tab coordination is off in this browser".
 *
 * The rule that matters for RULE 21: a backgrounded tab is not dead. Chrome
 * throttles timers in hidden tabs and can freeze them outright, so the lease in
 * the machine is deliberately longer than the heartbeat interval and the
 * heartbeat stops when the tab is hidden rather than firing into a frozen
 * event loop.
 */

import {
  OWNERSHIP_CHANNEL,
  OWNERSHIP_HEARTBEAT_MS,
  isOwnershipMessage,
  type OwnershipMessage,
  type PlaybackOwnership,
  type OwnershipSnapshot,
} from "@/lib/multi-tab/playback-ownership";

export interface OwnershipTransport {
  /**
   * Send a message to the other tabs. Safe before `start()` and after stop();
   * a no-op when cross-tab coordination is unavailable.
   *
   * Exposed so the owner of this transport - the React host - can announce its
   * own claims and releases without the transport also having to know when
   * local playback started.
   */
  broadcast(message: OwnershipMessage | null): void;
  /** Begin listening. Returns a stop function. */
  start(): () => void;
  /** Whether cross-tab coordination is actually available here. */
  readonly supported: boolean;
}

export function isBroadcastChannelAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.BroadcastChannel === "function"
  );
}

function post(channel: BroadcastChannel | null, message: OwnershipMessage | null): void {
  if (!channel || !message) {
    return;
  }
  try {
    channel.postMessage(message);
  } catch {
    // A closed channel throws on post. Losing one claim message is survivable;
    // throwing into the player is not.
  }
}

export function createOwnershipTransport(
  ownership: PlaybackOwnership,
  options: {
    channelName?: string;
    onChange?: (snapshot: OwnershipSnapshot) => void;
    now?: () => number;
  } = {},
): OwnershipTransport {
  const now = options.now ?? (() => Date.now());
  const name = options.channelName ?? OWNERSHIP_CHANNEL;
  // Hoisted so `broadcast` works before `start()` and so the stop path can
  // still send a release after the listeners are gone.
  let channel: BroadcastChannel | null = null;

  return {
    supported: isBroadcastChannelAvailable(),

    broadcast(message) {
      post(channel, message);
    },


    start() {
      if (!isBroadcastChannelAvailable()) {
        // Still nothing to wire: a single tab behaves identically, so the
        // unsupported path is a no-op rather than a different code path.
        return () => {};
      }

      channel = new window.BroadcastChannel(name);
      const active = channel;
      let stopped = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const handleMessage = (event: MessageEvent) => {
        if (stopped || !isOwnershipMessage(event.data)) {
          return;
        }
        const replies = ownership.receive(event.data, now());
        post(active, replies[0] ?? null);
        options.onChange?.(ownership.getSnapshot());
      };

      active.addEventListener("message", handleMessage);

      // Announce ourselves, then ask who owns playback. A tab that opens while
      // another is already playing learns about it here rather than waiting for
      // that tab's next heartbeat.
      post(active, ownership.query());

      timer = setInterval(() => {
        // Expire a dead owner first, so a heartbeat is never sent for a claim
        // this tab has already written off.
        const expired = ownership.tick(now());
        post(active, expired);
        post(active, ownership.heartbeat(now()));
      }, OWNERSHIP_HEARTBEAT_MS);

      const handleVisibility = () => {
        if (document.visibilityState === "visible") {
          // Coming back from hidden: the lease may have lapsed while timers
          // were throttled, so re-announce and re-ask.
          post(active, ownership.query());
          post(active, ownership.heartbeat(now()));
        }
      };
      document.addEventListener("visibilitychange", handleVisibility);

      const release = () => {
        if (stopped) {
          return;
        }
        post(active, ownership.release());
      };
      window.addEventListener("pagehide", release);

      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        // Release before closing, so other tabs hand playback back immediately
        // instead of waiting out the lease.
        ownership.release();
        post(active, { type: "release", tabId: ownership.tabId });
        window.removeEventListener("pagehide", release);
        document.removeEventListener("visibilitychange", handleVisibility);
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        active.removeEventListener("message", handleMessage);
        if (channel === active) {
          channel = null;
        }
        try {
          active.close();
        } catch {
          // Already closed.
        }
        options.onChange?.(ownership.getSnapshot());
      };
    },
  };
}
