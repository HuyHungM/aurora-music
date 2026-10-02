"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { getMusicEngine, subscribeMusicEngine } from "./instance";
import { EMPTY_ENGINE_STATE } from "./music-engine";
import type { MusicEngine, MusicEngineState } from "./music-engine";

/**
 * React bindings for the lifecycle-owned MusicEngine facade.
 *
 * - `useMusicEngine()` returns the mounted instance or null (SSR-safe: no
 *   engine is created during server render or outside PlayerHost). It
 *   re-renders when the mounted instance changes (host mount/unmount).
 * - `useMusicEngineState(selector)` subscribes via `useSyncExternalStore`
 *   and re-renders only when the selected slice changes by reference. The
 *   facade memoizes snapshots and stabilizes identity references for
 *   exactly this purpose; selectors should still prefer primitives.
 *   With no mounted engine, components render from the static empty
 *   snapshot and never subscribe.
 */
export function useMusicEngine(): MusicEngine | null {
  return useSyncExternalStore(
    subscribeMusicEngine,
    getMusicEngine,
    getMusicEngine,
  );
}

export function useMusicEngineState<T>(
  selector: (state: MusicEngineState) => T,
): T {
  const engine = useMusicEngine();
  const cacheRef = useRef<{ value: T } | null>(null);
  // `subscribe` MUST be referentially stable. It was an inline arrow, so its
  // identity changed every render, and React's subscription effect depends on
  // it: every render of every subscriber tore down its engine listener and
  // attached a new one. On a player page that is dozens of listener
  // churn round-trips per render, on top of the per-notification read.
  //
  // `getSnapshot` is deliberately left inline so it always closes over the
  // CURRENT render's selector. Stabilizing it needs a "latest selector" ref,
  // and assigning a ref during render is what the repo's React rules forbid -
  // correctly, since a stale selector would read a stale value. Every
  // production selector is a pure function of state, so the remaining cost of
  // an unstable `getSnapshot` is one extra snapshot read per render, and that
  // read is cheap now that the snapshot builder no longer maps the queue.
  const subscribe = useCallback(
    (notify: () => void) => (engine ? engine.subscribe(notify) : () => undefined),
    [engine],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      const snapshot = engine ? engine.getState() : EMPTY_ENGINE_STATE;
      const next = selector(snapshot);
      if (cacheRef.current === null || !Object.is(next, cacheRef.current.value)) {
        cacheRef.current = { value: next };
      }
      return (cacheRef.current as { value: T }).value;
    },
    () => selector(EMPTY_ENGINE_STATE),
  );
}
