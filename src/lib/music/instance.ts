import type { MusicEngine } from "./music-engine";

/**
 * Lifecycle-scoped MusicEngine holder, mirroring the `setPlaybackController`
 * pattern in the player store. PlayerHost sets the mounted facade and
 * clears it on unmount; tests instantiate isolated facades directly via
 * `createMusicEngine` or publish one here for component tests.
 *
 * The holder is subscribable so React bindings re-render when the mounted
 * instance appears (host effect runs after first render), changes, or is
 * cleared — without remounting the component tree.
 */
let musicEngine: MusicEngine | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function setMusicEngine(engine: MusicEngine | null): void {
  musicEngine = engine;
  notify();
}

export function getMusicEngine(): MusicEngine | null {
  return musicEngine;
}

export function subscribeMusicEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
