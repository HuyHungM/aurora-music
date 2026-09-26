import type { RadioSession } from "./session";

/**
 * Single mounted radio session holder (mirrors the MusicEngine
 * lifecycle pattern): one active station at a time, memory-only, so a
 * reload always drops the session while the persisted queue survives
 * as ordinary entries with no regeneration.
 */

let current: RadioSession | null = null;
const listeners = new Set<() => void>();
/**
 * Detaches the previous session's forwarding subscription.
 *
 * Without this, replacing the session would leave the old one still pushing
 * notifications into this holder, and a disposed station could keep waking
 * every subscriber.
 */
let unsubscribeSession: (() => void) | null = null;

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function setRadioSession(session: RadioSession | null): void {
  unsubscribeSession?.();
  unsubscribeSession = null;
  current = session;
  // Forward the session's own notifications. Unlike the MusicEngine holder,
  // this one is not merely a mount notification: the session keeps its state in
  // a plain variable (no external store, unlike the player's Zustand) and
  // `subscribeRadioSession` is the `useSyncExternalStore` subscribe function
  // for BOTH radio surfaces (`radio-controls.tsx`, `queue-panel.tsx`). Without
  // this bridge it fired only when the holder was written, so the station
  // reached `exhausted` correctly in the state machine while the panel sat on
  // "Finding more tracks…" forever, and `RadioSession.subscribe` had no callers
  // at all.
  if (session) {
    unsubscribeSession = session.subscribe(() => {
      emit();
    });
  }
  emit();
}

export function getRadioSession(): RadioSession | null {
  return current;
}

export function subscribeRadioSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
