import { PlayerEngine } from "./engine";

/**
 * The single app-wide audio engine. Created lazily on the client so server
 * renders stay dependency-free; tests mock this module directly.
 */
let singleton: PlayerEngine | null = null;

export function getDefaultEngine(): PlayerEngine | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!singleton) {
    singleton = new PlayerEngine(new Audio());
  }
  return singleton;
}