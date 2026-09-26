import { afterEach, describe, expect, it, vi } from "vitest";
import { createInfiniteListeningCoordinator } from "@/lib/listening/coordinator";
import {
  getKeepListeningCoordinator,
  setKeepListeningCoordinator,
  subscribeKeepListeningCoordinator,
} from "@/lib/listening/instance";

/**
 * The mounted-coordinator holder's notification contract.
 *
 * This module is the only thing a `useSyncExternalStore` subscriber can bind
 * to for autoplay state, so its listener set has one job: fire whenever the
 * value `getKeepListeningCoordinator()?.getState()` returns is about to change
 * — not only when a coordinator appears or disappears.
 *
 * It used to keep a second, independent listener set that fired on presence
 * only, so a subscriber bound here was never woken by a state change. The
 * autoplay control then rendered a stale snapshot: it happened to look correct
 * on a first load, because unrelated player-store updates re-rendered it often
 * enough to pick the new value up by accident, and it went stale the moment
 * those stopped. The tests below pin the behaviour the icon depends on, using
 * a real coordinator rather than a double, because the bug lived in how the
 * two objects are wired together.
 */

function coordinator() {
  return createInfiniteListeningCoordinator({
    now: () => 1_000,
    // Never called: nothing in this file puts tracks in a queue, so the
    // coordinator never reaches the request path. Typed as the real contract
    // so a change to it cannot be absorbed by a loose `as`.
    request: vi.fn(async () => ({ ok: true as const, tracks: [], categories: [] })),
    isExclusiveContinuationActive: () => false,
  });
}

afterEach(() => {
  setKeepListeningCoordinator(null);
});

describe("the mounted-coordinator holder", () => {
  it("wakes subscribers when a coordinator appears", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKeepListeningCoordinator(listener);

    const created = coordinator();
    setKeepListeningCoordinator(created);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getKeepListeningCoordinator()).toBe(created);
    unsubscribe();
  });

  // The regression. `enabled` is what the icon renders, and the preference
  // reaches the coordinator through `hydrate()` long after mount — with no
  // presence change to announce it.
  it("wakes subscribers when the coordinator's state changes", () => {
    const created = coordinator();
    setKeepListeningCoordinator(created);
    const listener = vi.fn();
    const unsubscribe = subscribeKeepListeningCoordinator(listener);

    created.hydrate(false, true);

    expect(listener).toHaveBeenCalled();
    expect(getKeepListeningCoordinator()!.getState().authenticated).toBe(true);
    unsubscribe();
  });

  it("wakes subscribers when autoplay is toggled", () => {
    const created = coordinator();
    setKeepListeningCoordinator(created);
    const listener = vi.fn();
    const unsubscribe = subscribeKeepListeningCoordinator(listener);

    created.setEnabled(true);

    expect(listener).toHaveBeenCalled();
    expect(getKeepListeningCoordinator()!.getState().enabled).toBe(true);
    unsubscribe();
  });

  // Without this, replacing the coordinator would leave the old one wired to
  // the listener set forever: every state change on a discarded coordinator
  // would re-render the UI reading a different object.
  it("stops relaying a coordinator that has been replaced", () => {
    const first = coordinator();
    setKeepListeningCoordinator(first);
    const second = coordinator();
    setKeepListeningCoordinator(second);
    const listener = vi.fn();
    const unsubscribe = subscribeKeepListeningCoordinator(listener);

    first.hydrate(true, true);
    expect(listener).not.toHaveBeenCalled();

    second.hydrate(true, true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("stops relaying when the coordinator is cleared", () => {
    const created = coordinator();
    setKeepListeningCoordinator(created);
    setKeepListeningCoordinator(null);
    const listener = vi.fn();
    const unsubscribe = subscribeKeepListeningCoordinator(listener);

    created.hydrate(true, true);

    expect(listener).not.toHaveBeenCalled();
    expect(getKeepListeningCoordinator()).toBeNull();
    unsubscribe();
  });

  it("stops calling a subscriber once it unsubscribes", () => {
    const created = coordinator();
    setKeepListeningCoordinator(created);
    const listener = vi.fn();

    const unsubscribe = subscribeKeepListeningCoordinator(listener);
    created.setEnabled(true);
    const afterFirst = listener.mock.calls.length;

    unsubscribe();
    created.setEnabled(false);
    created.hydrate(false, true);

    expect(listener).toHaveBeenCalledTimes(afterFirst);
  });
});
