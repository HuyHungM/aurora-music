/**
 * Single playback owner across browser tabs (Phase 52, RULE 18).
 *
 * The problem: Aurora mounts one audio engine per tab. Open the app in three
 * tabs, press play in each, and you get three overlapping audio streams with
 * three different queues - and, because each tab also persists the session,
 * whichever tab wrote last decides what the next page load restores. That is
 * the "uncontrolled simultaneous playback" this module removes.
 *
 * The approach is a lease, not a lock service:
 *
 * - A tab that starts playing claims ownership and broadcasts the claim.
 * - The current owner yields immediately when it hears a newer claim, so audio
 *   never overlaps for more than one message round trip.
 * - The owner heartbeats. A tab that has not heard a heartbeat within the lease
 *   treats the owner as gone - which is the crash case, and the reason a lease
 *   is used instead of a boolean flag: a tab that is killed cannot clear a flag
 *   it no longer exists to clear.
 * - A tab that wants the audio back can take over explicitly. This is a user
 *   action, so it is unconditional; the previous owner yields and says so in the
 *   UI rather than being left to guess why it went quiet.
 *
 * The one hard requirement is that two tabs never disagree about who owns
 * playback, because if they do, both keep playing. So every claim carries a
 * totally ordered identity - `(epoch, tabId)` - and both tabs independently
 * compute the same winner from the same two values. There is no coordinator, no
 * round trip, and no window in which a message is in flight and the answer
 * depends on arrival order.
 *
 * This module is deliberately pure: no timers, no DOM, no BroadcastChannel, no
 * React. The transport is `channel.ts` and the React binding is
 * `use-playback-ownership.ts`. That split is what makes the interesting part -
 * who wins - testable as pure functions.
 *
 * What this is NOT: it is not distributed audio, and it does not move playback
 * between tabs. A tab that loses ownership pauses; it does not start streaming
 * somewhere else. RULE 25's "last-active client / manual takeover" policy is
 * honoured by making the most recently active tab the owner, not by
 * implementing Spotify Connect.
 */

export const OWNERSHIP_CHANNEL = "aurora:playback-ownership";

/**
 * How long a claim survives without a heartbeat.
 *
 * Long enough that a backgrounded tab which is merely throttled - Chrome
 * freezes timers in a hidden tab, and a heartbeat can be delayed by seconds -
 * is not falsely declared dead. Short enough that closing a tab hands playback
 * back within a couple of seconds rather than leaving the user with silence.
 */
export const OWNERSHIP_LEASE_MS = 5_000;

/** Heartbeat cadence. Comfortably inside the lease so one lost beat is survivable. */
export const OWNERSHIP_HEARTBEAT_MS = 1_500;

export type OwnershipRole = "idle" | "owner" | "contender";
export interface OwnershipSnapshot {
  readonly role: OwnershipRole;
  /** The tab currently believed to own playback, or null. */
  readonly ownerTabId: string | null;
  /** Epoch of the current claim. Higher wins. */
  readonly ownerEpoch: number;
  /**
   * False once the lease has expired and no owner is believed to be alive.
   * Paired with `role: "contender"` this is the whole of "someone else has it".
   */
  readonly ownerAlive: boolean;
}

/**
 * Whether a *live foreign* tab currently owns playback — the single fact
 * that decides whether this tab's queue is the live listening session.
 *
 * This is deliberately not "am I the owner". Requiring ownership would
 * silence persistence in every tab the moment playback paused, because a
 * paused tab has released its claim and there is no owner to be. The
 * condition that actually matters is narrower: another tab is audibly
 * playing right now, so this tab has already yielded (the host pauses a
 * contender) and its queue is a background session, not the live one.
 *
 * Both halves are load-bearing. `role === "contender"` excludes this tab's
 * own claim, and `ownerAlive` excludes a rival whose lease has lapsed — a
 * crashed or closed tab must stop suppressing writes immediately, or a
 * dead tab would freeze persistence for the whole session.
 */
export function isForeignLiveOwner(snapshot: OwnershipSnapshot): boolean {
  return snapshot.role === "contender" && snapshot.ownerAlive;
}

export type OwnershipMessage =
  | { readonly type: "claim"; readonly tabId: string; readonly epoch: number }
  | { readonly type: "heartbeat"; readonly tabId: string; readonly epoch: number }
  | { readonly type: "release"; readonly tabId: string }
  | { readonly type: "takeover"; readonly tabId: string; readonly epoch: number }
  | { readonly type: "query"; readonly tabId: string }
  | { readonly type: "state"; readonly tabId: string; readonly epoch: number };

/**
 * Protocol validation, and deliberately strict.
 *
 * Every field is checked, not just `type`. A `BroadcastChannel` is reachable by
 * any script on the same origin, so this is the project's only real trust
 * boundary in the browser. Validating only the discriminant would let a peer
 * post `{ type: "claim", tabId: "x", epoch: "9" }`; `Math.max(0, "9")` would then
 * produce `NaN`, and every subsequent claim would compare against `NaN` and
 * resolve to "no opinion" - a split brain produced by a type coercion.
 *
 * `release` and `query` carry no epoch, and the epoch-carrying messages must
 * carry a finite one. A `NaN` or `Infinity` epoch would poison the total order
 * just as effectively as a string.
 */
export function isOwnershipMessage(value: unknown): value is OwnershipMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { type?: unknown; tabId?: unknown; epoch?: unknown };
  if (typeof candidate.type !== "string") {
    return false;
  }
  if (typeof candidate.tabId !== "string" || candidate.tabId.length === 0) {
    return false;
  }
  if (candidate.type === "release" || candidate.type === "query") {
    return true;
  }
  if (
    candidate.type === "claim" ||
    candidate.type === "heartbeat" ||
    candidate.type === "takeover" ||
    candidate.type === "state"
  ) {
    return (
      typeof candidate.epoch === "number" &&
      Number.isFinite(candidate.epoch) &&
      Number.isInteger(candidate.epoch) &&
      candidate.epoch >= 0
    );
  }
  return false;
}

/**
 * Total order on claims. Higher epoch wins; equal epochs are broken by
 * lexicographically smaller tab id, so two tabs that claim in the same
 * millisecond still agree. Both sides compute this from the same inputs, which
 * is what makes a split brain impossible.
 */
export function claimWins(
  candidate: { tabId: string; epoch: number },
  incumbent: { tabId: string; epoch: number },
): boolean {
  if (candidate.epoch !== incumbent.epoch) {
    return candidate.epoch > incumbent.epoch;
  }
  return candidate.tabId < incumbent.tabId;
}

export interface PlaybackOwnership {
  readonly tabId: string;
  /** Current view, for `useSyncExternalStore`. */
  getSnapshot(): OwnershipSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Local playback started: claim, or bump the epoch if already the owner.
   * Always emits, so its type is a claim rather than the whole union - callers
   * read `.epoch` off it directly.
   */
  claim(nowMs?: number): Extract<OwnershipMessage, { type: "claim" }>;
  /** Owner heartbeat. `null` when this tab is not the owner. */
  heartbeat(nowMs?: number): Extract<OwnershipMessage, { type: "heartbeat" }> | null;
  /** Local playback stopped, or the tab is going away. */
  release(): Extract<OwnershipMessage, { type: "release" }> | null;
  /** Explicit user takeover. Unconditional; the incumbent yields. */
  takeover(nowMs?: number): Extract<OwnershipMessage, { type: "takeover" }>;
  /** A newly opened tab asking who owns playback. */
  query(): Extract<OwnershipMessage, { type: "query" }>;
  /** Handle an inbound message. Returns messages to broadcast, if any. */
  receive(message: unknown, nowMs?: number): OwnershipMessage[];
  /**
   * Re-evaluate the lease. Clears a belief locally and never needs to broadcast:
   * "the owner I was tracking is gone" is a private conclusion, and publishing
   * it would let a tab that had not heard the owner declare it dead.
   */
  tick(nowMs?: number): null;
  /** Test seam: the highest epoch this tab has issued. */
  issuedEpoch(): number;
}

export interface OwnershipOptions {
  /** Injected for tests; defaults to a fresh random id. */
  readonly tabId?: string;
  readonly now?: () => number;
  readonly leaseMs?: number;
  /** Seed a believed owner, e.g. handed over from a previous page view. */
  readonly initialOwner?: { tabId: string; epoch: number } | null;
}

function newTabId(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === "function") {
    return webcrypto.randomUUID();
  }
  // Unreachable in any browser Aurora supports, but a tab id that collides is
  // still better than a throw during module init.
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function createPlaybackOwnership(
  options: OwnershipOptions = {},
): PlaybackOwnership {
  const tabId = options.tabId ?? newTabId();
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? OWNERSHIP_LEASE_MS;

  let ownerTabId: string | null = options.initialOwner?.tabId ?? null;
  let ownerEpoch: number = options.initialOwner?.epoch ?? 0;
  let lastOwnerSeenAtMs: number | null = options.initialOwner ? now() : null;
  let role: OwnershipRole = "idle";
  let highestEpoch = 0;
  const listeners = new Set<() => void>();

  const snapshot: OwnershipSnapshot = {
    role,
    ownerTabId,
    ownerEpoch,
    ownerAlive: false,
  };

  function ownerAliveAt(timestamp: number): boolean {
    if (ownerTabId === null || lastOwnerSeenAtMs === null) {
      return false;
    }
    if (ownerTabId === tabId) {
      // Our own claim cannot expire while we are alive to heartbeat it.
      return true;
    }
    return timestamp - lastOwnerSeenAtMs < leaseMs;
  }

  function compute(): OwnershipSnapshot {
    const alive = ownerTabId === null ? false : ownerAliveAt(now());
    return {
      role,
      ownerTabId: alive ? ownerTabId : null,
      ownerEpoch,
      ownerAlive: alive,
    };
  }

  function notify(): void {
    Object.assign(snapshot, compute());
    for (const listener of listeners) {
      listener();
    }
  }

  function setOwner(nextTabId: string, nextEpoch: number, atMs: number): void {
    ownerTabId = nextTabId;
    ownerEpoch = nextEpoch;
    lastOwnerSeenAtMs = atMs;
    role = nextTabId === tabId ? "owner" : "contender";
  }

  function nextEpoch(): number {
    highestEpoch += 1;
    return highestEpoch;
  }

  /**
   * Forget the current owner.
   *
   * Every caller goes through here, including a release received from a rival
   * tab, so `role` always returns to "idle" together with the claim. Clearing
   * only when the local role happened to be "owner" would leave the state
   * `role: "contender"` with `ownerTabId: null` - a claim this tab believes in
   * and a role implying a rival that does not exist.
   */
  function clearOwner(): void {
    ownerTabId = null;
    lastOwnerSeenAtMs = null;
    role = "idle";
  }

  return {
    tabId,

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    claim(nowMs) {
      const at = nowMs ?? now();
      const epoch = nextEpoch();
      // Re-claiming always wins over an incumbent claim, including our own
      // previous claim, because a fresh local play is fresh user intent.
      setOwner(tabId, epoch, at);
      notify();
      return { type: "claim", tabId, epoch };
    },

    heartbeat(nowMs) {
      if (role !== "owner" || ownerTabId !== tabId) {
        return null;
      }
      // Deliberately does not notify. Refreshing the lease changes nothing a
      // subscriber can observe - the snapshot stays field-for-field identical
      // and is mutated in place, so a notify here would only wake every
      // `useSyncExternalStore` consumer 40 times a minute for no reason.
      lastOwnerSeenAtMs = nowMs ?? now();
      return { type: "heartbeat", tabId, epoch: ownerEpoch };
    },

    release() {
      if (ownerTabId !== tabId) {
        return null;
      }
      // A release carries no epoch on purpose. Sending one would let a late
      // release lower a shared counter and let a stale heartbeat resurrect an
      // old claim; "the tab with this id is no longer playing" is the whole
      // fact, and it is enough to free the claim.
      clearOwner();
      notify();
      return { type: "release", tabId } satisfies OwnershipMessage;
    },

    takeover(nowMs) {
      const at = nowMs ?? now();
      const epoch = nextEpoch();
      setOwner(tabId, epoch, at);
      notify();
      return { type: "takeover", tabId, epoch };
    },

    query() {
      return { type: "query", tabId };
    },

    receive(message, nowMs) {
      if (!isOwnershipMessage(message)) {
        return [];
      }
      // Our own broadcast comes back to us on some platforms; ignoring it is
      // what keeps a claim from being processed as if it were a rival's.
      if (message.tabId === tabId) {
        return [];
      }
      const at = nowMs ?? now();

      switch (message.type) {
        case "query": {
          // Answer with a state message only if we are the owner. A contender
          // stays silent: two tabs both answering "not me" is indistinguishable
          // from no answer, which is the correct outcome.
          if (role === "owner" && ownerTabId === tabId) {
            return [{ type: "state", tabId, epoch: ownerEpoch }];
          }
          return [];
        }
        case "state": {
          if (ownerTabId !== null) {
            lastOwnerSeenAtMs = at;
            notify();
            return [];
          }
          if (claimWins({ tabId: message.tabId, epoch: message.epoch }, { tabId, epoch: highestEpoch })) {
            setOwner(message.tabId, message.epoch, at);
            notify();
          }
          return [];
        }
        case "claim":
        case "takeover": {
          highestEpoch = Math.max(highestEpoch, message.epoch);
          // A takeover is a deliberate user action: it replaces the incumbent
          // unconditionally. A plain claim only wins if it outranks what we
          // already hold, so two tabs pressing play at once resolve to the same
          // winner instead of both proceeding.
          const uncontested = message.type === "takeover";
          if (uncontested || ownerTabId === null) {
            setOwner(message.tabId, message.epoch, at);
            notify();
            return [];
          }
          if (claimWins({ tabId: message.tabId, epoch: message.epoch }, { tabId: ownerTabId, epoch: ownerEpoch })) {
            setOwner(message.tabId, message.epoch, at);
            notify();
          }
          return [];
        }
        case "heartbeat": {
          // Refreshes the lease and re-derives the snapshot. Identity is stable
          // and the fields are unchanged while the owner is alive, so this
          // notify costs React nothing; it keeps `ownerAlive` honest for the
          // render that eventually happens.
          if (ownerTabId === message.tabId && ownerEpoch === message.epoch) {
            lastOwnerSeenAtMs = at;
            notify();
          }
          return [];
        }
        case "release": {
          if (ownerTabId === message.tabId) {
            clearOwner();
            notify();
          }
          return [];
        }
        default:
          return [];
      }
    },

    tick(nowMs) {
      const at = nowMs ?? now();
      if (ownerTabId === null || ownerTabId === tabId) {
        return null;
      }
      if (ownerAliveAt(at)) {
        return null;
      }
      // The owner is gone. Clear the belief so a later claim - this tab's or
      // another tab's - starts from a clean state instead of having to outrank
      // a dead claim forever.
      clearOwner();
      notify();
      return null;
    },

    issuedEpoch() {
      return highestEpoch;
    },
  };
}
