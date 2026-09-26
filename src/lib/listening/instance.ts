import type { InfiniteListeningCoordinator } from "./coordinator";

/**
 * Single mounted continuation coordinator holder (mirrors the MusicEngine
 * and radio-session lifecycle pattern): one coordinator per page load,
 * memory-only, so a reload always starts from a clean context and the
 * persisted queue is restored as-is with no regeneration.
 *
 * ## Why this module relays the coordinator's own notifications
 *
 * `InfiniteListeningCoordinator` keeps its own listener set and emits on every
 * state change. This module used to keep a *second*, independent set that only
 * fired when the coordinator was set or cleared — so a `useSyncExternalStore`
 * subscriber bound here was woken when a coordinator appeared, but never when
 * that coordinator's state changed.
 *
 * The UI therefore read a stale snapshot: it showed whatever `getState()`
 * happened to return at its last render, for any render caused by something
 * else, and nothing at all after a quiet state change. In practice the control
 * still looked right on a first load, because unrelated player-store updates
 * re-rendered it often enough to pick the new value up by accident — and it
 * went stale the moment those stopped, which is why a reload with no restored
 * queue left the control reading a pre-hydration snapshot forever.
 *
 * One listener set, woken by both: presence changes here, and every state
 * change inside the coordinator. A snapshot read through
 * `getKeepListeningCoordinator()?.getState()` is then genuinely reactive, which
 * is the whole contract the autoplay control depends on — its icon has to show
 * what the coordinator is actually doing, including the transient `generating`
 * state that no other store event would ever surface.
 */

let current: InfiniteListeningCoordinator | null = null;
/** Releases the previous coordinator's relay, so it cannot outlive it. */
let detachStateRelay: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function setKeepListeningCoordinator(
  coordinator: InfiniteListeningCoordinator | null,
): void {
  detachStateRelay?.();
  detachStateRelay = null;
  current = coordinator;
  if (coordinator) {
    detachStateRelay = coordinator.subscribe(emit);
  }
  emit();
}

export function getKeepListeningCoordinator(): InfiniteListeningCoordinator | null {
  return current;
}

export function subscribeKeepListeningCoordinator(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
