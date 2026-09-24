"use client";

import { useRef, useSyncExternalStore } from "react";
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
  return useSyncExternalStore(
    (notify) => (engine ? engine.subscribe(() => notify()) : () => undefined),
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
