import { describe, expect, it } from "vitest";

import {
  OWNERSHIP_LEASE_MS,
  claimWins,
  createPlaybackOwnership,
  isForeignLiveOwner,
  isOwnershipMessage,
  type OwnershipMessage,
  type PlaybackOwnership,
} from "@/lib/multi-tab/playback-ownership";

/**
 * Multi-tab playback ownership (Phase 52, RULE 18).
 *
 * The tests that matter here are the adversarial ones: two tabs claiming at the
 * same instant, a stale heartbeat arriving after a newer claim, an owner that
 * dies without releasing, and a release racing a claim. A lease that only works
 * in the happy path is worse than no lease, because it looks like it works.
 */

function makeTab(tabId: string, clock: { now: number }): PlaybackOwnership {
  return createPlaybackOwnership({
    tabId,
    now: () => clock.now,
    leaseMs: OWNERSHIP_LEASE_MS,
  });
}

describe("claimWins", () => {
  it("prefers the higher epoch regardless of tab id", () => {
    expect(
      claimWins({ tabId: "zzz", epoch: 2 }, { tabId: "aaa", epoch: 1 }),
    ).toBe(true);
    expect(
      claimWins({ tabId: "aaa", epoch: 1 }, { tabId: "zzz", epoch: 2 }),
    ).toBe(false);
  });

  it("breaks an epoch tie deterministically on tab id", () => {
    // Both directions must agree, or two tabs would both believe they won.
    const left = { tabId: "aaa", epoch: 7 };
    const right = { tabId: "bbb", epoch: 7 };
    expect(claimWins(left, right)).toBe(true);
    expect(claimWins(right, left)).toBe(false);
  });
});

describe("isOwnershipMessage", () => {
  it("accepts the six protocol messages", () => {
    const messages: OwnershipMessage[] = [
      { type: "claim", tabId: "a", epoch: 1 },
      { type: "heartbeat", tabId: "a", epoch: 1 },
      { type: "release", tabId: "a" },
      { type: "takeover", tabId: "a", epoch: 2 },
      { type: "query", tabId: "a" },
      { type: "state", tabId: "a", epoch: 1 },
    ];
    for (const message of messages) {
      expect(isOwnershipMessage(message)).toBe(true);
    }
  });

  it("rejects anything a hostile or buggy peer could post", () => {
    for (const value of [
      null,
      undefined,
      "claim",
      42,
      [],
      {},
      { type: "claim" },
      { type: "claim", tabId: 1 },
      { type: "claim", tabId: "" },
      { type: "sudo", tabId: "a" },
      // The regression this catches: an unvalidated `epoch` reaches
      // `Math.max`, produces NaN, and every later claim then compares against
      // NaN - resolving to "no opinion" and letting both tabs keep playing.
      { type: "claim", tabId: "a", epoch: "1" },
      { type: "claim", tabId: "a", epoch: Number.NaN },
      { type: "claim", tabId: "a", epoch: Number.POSITIVE_INFINITY },
      { type: "claim", tabId: "a", epoch: 1.5 },
      { type: "claim", tabId: "a", epoch: -1 },
      { type: "heartbeat", tabId: "a" },
      { type: "state", tabId: "a", epoch: null },
    ]) {
      expect(isOwnershipMessage(value)).toBe(false);
    }
  });
});

describe("playback ownership", () => {
  it("claims on local play and reports itself as owner", () => {
    const clock = { now: 1_000 };
    const tab = makeTab("tab-a", clock);
    const message = tab.claim();
    expect(message).toEqual({ type: "claim", tabId: "tab-a", epoch: 1 });
    expect(tab.getSnapshot()).toMatchObject({
      role: "owner",
      ownerTabId: "tab-a",
      ownerAlive: true,
    });
  });

  it("ignores its own broadcast coming back to it", () => {
    const clock = { now: 1_000 };
    const tab = makeTab("tab-a", clock);
    tab.claim();
    const replies = tab.receive({ type: "claim", tabId: "tab-a", epoch: 99 });
    expect(replies).toEqual([]);
    expect(tab.getSnapshot().ownerTabId).toBe("tab-a");
  });

  it("a newer claim makes the current owner yield", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    a.claim();
    expect(a.getSnapshot().role).toBe("owner");

    b.receive(a.claim(1_000), 1_000);
    expect(b.getSnapshot()).toMatchObject({ role: "contender", ownerTabId: "tab-a" });

    // B plays, and A hears it. The notice is status-while-true, not a one-shot
    // edge: while another tab holds the claim, this tab is not the one playing,
    // and saying so once and then going quiet would be a lie.
    const bClaim = b.claim(1_100);
    a.receive(bClaim, 1_100);
    expect(a.getSnapshot()).toMatchObject({
      role: "contender",
      ownerTabId: "tab-b",
      ownerAlive: true,
    });

    // A heartbeat keeps the same view stable rather than changing it.
    a.receive({ type: "heartbeat", tabId: "tab-b", epoch: bClaim.epoch }, 1_200);
    expect(a.getSnapshot()).toMatchObject({
      role: "contender",
      ownerTabId: "tab-b",
    });
  });

  it("returns to idle when the rival's claim is released", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    const bClaim = b.claim(1_000);
    a.receive(bClaim, 1_000);
    expect(a.getSnapshot().role).toBe("contender");

    // Release once on B and carry the emitted message over, exactly as the
    // transport does. B has nothing left to release afterwards.
    const released = b.release();
    expect(released).toEqual({ type: "release", tabId: "tab-b" });
    expect(b.release()).toBeNull();

    a.receive(released, 1_010);
    // Not "contender with no owner": that state claims a rival exists.
    expect(a.getSnapshot()).toMatchObject({
      role: "idle",
      ownerTabId: null,
      ownerAlive: false,
    });
  });

  it("resolves two simultaneous claims to the same winner", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    // Both press play in the same millisecond. Epoch 1 on each.
    const claimA = a.claim(1_000);
    const claimB = b.claim(1_000);
    a.receive(claimB, 1_000);
    b.receive(claimA, 1_000);

    const ownerA = a.getSnapshot().ownerTabId;
    const ownerB = b.getSnapshot().ownerTabId;
    expect(ownerA).toBe("tab-a");
    expect(ownerB).toBe("tab-a");
    expect(a.getSnapshot().role).toBe("owner");
    expect(b.getSnapshot().role).toBe("contender");
  });

  it("a takeover beats a higher-epoch claim from the incumbent", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    for (let i = 0; i < 5; i += 1) {
      a.claim(1_000 + i);
    }
    const incumbent = a.claim(1_010);
    expect(incumbent.epoch).toBe(6);

    b.receive(incumbent, 1_010);
    expect(b.getSnapshot().role).toBe("contender");

    // The user clicks "Play here" in B. That is deliberate intent, so it wins
    // even against a numerically higher claim epoch.
    const takeover = b.takeover(1_020);
    a.receive(takeover, 1_020);
    expect(a.getSnapshot()).toMatchObject({ role: "contender", ownerTabId: "tab-b" });
    expect(b.getSnapshot()).toMatchObject({ role: "owner", ownerTabId: "tab-b" });
  });

  it("a release frees the claim immediately on the other tab", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    const claim = a.claim(1_000);
    b.receive(claim, 1_000);
    expect(b.getSnapshot().ownerAlive).toBe(true);

    b.receive(a.release(), 1_010);
    expect(b.getSnapshot()).toMatchObject({
      ownerTabId: null,
      role: "idle",
      ownerAlive: false,
    });
  });

  it("writes off an owner that stops heartbeating", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    const claim = a.claim(1_000);
    b.receive(claim, 1_000);
    expect(b.getSnapshot().ownerAlive).toBe(true);

    // Tab A is killed: no release, no heartbeat. Just time passing.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS;
    expect(b.tick()).toBeNull();
    expect(b.getSnapshot().ownerTabId).toBeNull();
    expect(b.getSnapshot().ownerAlive).toBe(false);

    // B can now claim for itself, and nothing forces it to outrank the dead one.
    b.claim();
    expect(b.getSnapshot()).toMatchObject({ role: "owner", ownerTabId: "tab-b" });
  });

  it("keeps a live owner alive across lost heartbeats inside the lease", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);
    const claim = a.claim(1_000);
    b.receive(claim, 1_000);

    // A hidden tab's timers are throttled; the lease must absorb that.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS - 1;
    b.tick();
    expect(b.getSnapshot().ownerTabId).toBe("tab-a");

    // A single heartbeat well inside the lease refreshes the window.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS;
    b.receive({ type: "heartbeat", tabId: "tab-a", epoch: claim.epoch }, clock.now);
    clock.now += OWNERSHIP_LEASE_MS - 1;
    b.tick();
    expect(b.getSnapshot().ownerTabId).toBe("tab-a");
  });

  it("ignores a heartbeat from a superseded claim", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);
    const stale = a.claim(1_000);
    a.claim(1_010);
    const current = a.getSnapshot().ownerEpoch;
    b.receive({ type: "state", tabId: "tab-a", epoch: current }, 1_000);

    // A delayed heartbeat from the superseded claim must not refresh anything.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS - 100;
    b.receive({ type: "heartbeat", tabId: "tab-a", epoch: stale.epoch }, clock.now);
    clock.now = 1_000 + OWNERSHIP_LEASE_MS;
    b.tick();
    expect(b.getSnapshot().ownerTabId).toBeNull();
  });

  it("answers a query only from the owner", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    // A contender stays silent: two "not me" replies are indistinguishable
    // from no reply, which is the correct outcome for "nobody owns playback".
    expect(b.receive({ type: "query", tabId: "c" }, 1_000)).toEqual([]);

    a.claim();
    expect(a.receive({ type: "query", tabId: "b" }, 1_000)).toEqual([
      { type: "state", tabId: "tab-a", epoch: 1 },
    ]);
  });

  it("never lets a release from a non-owner clear the claim", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);
    a.claim();
    b.receive(a.claim(1_000), 1_000);
    b.receive({ type: "release", tabId: "tab-zzz" }, 1_000);
    expect(b.getSnapshot().ownerTabId).toBe("tab-a");
  });

  it("notifies subscribers only on an observable change, and unsubscribes cleanly", () => {
    const clock = { now: 1_000 };
    const tab = makeTab("tab-a", clock);
    let calls = 0;
    const unsubscribe = tab.subscribe(() => {
      calls += 1;
    });

    tab.claim();
    expect(calls).toBe(1);

    // A heartbeat changes no observable field, so it must not wake subscribers
    // 40 times a minute for nothing.
    expect(tab.heartbeat()).not.toBeNull();
    expect(calls).toBe(1);

    // Yielding to a rival is observable, and so is being released from a claim.
    tab.receive({ type: "takeover", tabId: "tab-b", epoch: 9 }, 1_010);
    expect(calls).toBe(2);
    expect(tab.getSnapshot().role).toBe("contender");

    tab.receive({ type: "release", tabId: "tab-b" }, 1_020);
    expect(calls).toBe(3);
    expect(tab.getSnapshot().role).toBe("idle");

    unsubscribe();
    tab.claim();
    expect(calls).toBe(3);
  });

  it("a heartbeat from a contender is not a claim", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);
    a.claim();
    b.receive(a.claim(1_000), 1_000);
    expect(b.heartbeat()).toBeNull();
    expect(b.getSnapshot().role).toBe("contender");
  });

  it("stays uncontended across three tabs", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);
    const c = makeTab("tab-c", clock);

    const claim = a.claim(1_000);
    b.receive(claim, 1_000);
    c.receive(claim, 1_000);

    // B takes over; both A and C must agree B is the owner.
    const takeover = b.takeover(1_010);
    a.receive(takeover, 1_010);
    c.receive(takeover, 1_010);
    expect(a.getSnapshot().ownerTabId).toBe("tab-b");
    expect(c.getSnapshot().ownerTabId).toBe("tab-b");
    expect(a.getSnapshot().role).toBe("contender");
    expect(c.getSnapshot().role).toBe("contender");
  });
});

describe("isForeignLiveOwner", () => {
  it("is false when nothing is playing anywhere", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    expect(isForeignLiveOwner(a.getSnapshot())).toBe(false);
  });

  it("is false in the tab that owns playback", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    const claim = a.claim(1_000);
    b.receive(claim, 1_000);

    // The owner is not a foreign owner: it is the live session.
    expect(isForeignLiveOwner(a.getSnapshot())).toBe(false);
    // The tab that yielded is.
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(true);
  });

  it("stops suppressing writes once the owner releases", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    b.receive(a.claim(1_000), 1_000);
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(true);

    b.receive(a.release(), 1_010);
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(false);
  });

  it("stops suppressing writes when the owner dies without releasing", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    b.receive(a.claim(1_000), 1_000);
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(true);

    // A closed tab never releases. Once the lease lapses, b must resume
    // writing, or a crashed tab would freeze the session for good.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS + 1;
    b.tick(clock.now);
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(false);
  });

  it("reads the machine's last derived liveness, which tick() refreshes", () => {
    const clock = { now: 1_000 };
    const a = makeTab("tab-a", clock);
    const b = makeTab("tab-b", clock);

    b.receive(a.claim(1_000), 1_000);
    expect(b.getSnapshot().ownerAlive).toBe(true);

    // `getSnapshot()` returns the machine's cached view; liveness is
    // re-derived by `notify()`/`tick()`, not on every read. Pinned here so
    // nobody later assumes a read refreshes it: the transport ticks every
    // OWNERSHIP_HEARTBEAT_MS, which is what keeps a dead owner from
    // suppressing writes for longer than one heartbeat.
    clock.now = 1_000 + OWNERSHIP_LEASE_MS + 1;
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(true);

    b.tick(clock.now);
    expect(isForeignLiveOwner(b.getSnapshot())).toBe(false);
  });
});
