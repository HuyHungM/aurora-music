/**
 * Hover/focus intent gate for playback prefetching, owned by the MusicEngine
 * facade (components must not import playback internals — see the UI engine
 * boundary test).
 *
 * A track row hover is a hint, not a commitment: firing a server resolution
 * for every row the pointer crosses would turn a scroll into a request
 * storm, and re-warming a track warmed a minute ago is pure waste. This gate
 * answers "is this intent worth an upstream call?" with two cheap rules:
 *
 * 1. REMEMBERED KEYS. A key warmed once is not warmed again until its
 *    cooldown lapses (mirroring the server resolution TTL, so a re-hover
 *    after expiry re-warms while a re-hover inside the window is free).
 * 2. MINIMUM INTERVAL. Intents arriving faster than the interval are
 *    dropped, which is what turns a pointer sweep across twenty rows into a
 *    couple of resolutions instead of twenty.
 *
 * Deliberately promise-free: prefetch itself is fire-and-forget (the
 * controller's slot validates at consume time), so there is no completion to
 * count and no cancellation to propagate. Abandoned intent simply never fills
 * anything, and a filled slot for a track never loaded is validated or
 * overwritten, never played.
 *
 * Module-local memory, bounded (MAX_REMEMBERED_KEYS) and session-scoped like
 * every other client cache in this product. No timers, no listeners.
 */

export const INTENT_MIN_INTERVAL_MS = 250;
/** Mirrors the server resolution TTL: re-hover past this re-warms. */
export const INTENT_REWARM_COOLDOWN_MS = 180_000;
export const INTENT_MAX_REMEMBERED_KEYS = 200;

const warmedAt = new Map<string, number>();
let lastAcceptedAt = 0;

/**
 * Claims one intent prefetch for `key`, or refuses it. Pure admission
 * control: returns true exactly when the caller should fire the prefetch.
 */
export function claimIntentPrefetch(key: string, now: number = Date.now()): boolean {
  const last = warmedAt.get(key);
  if (last !== undefined && now - last < INTENT_REWARM_COOLDOWN_MS) {
    return false;
  }
  if (now - lastAcceptedAt < INTENT_MIN_INTERVAL_MS) {
    return false;
  }
  lastAcceptedAt = now;
  warmedAt.set(key, now);
  while (warmedAt.size > INTENT_MAX_REMEMBERED_KEYS) {
    const oldest = warmedAt.keys().next();
    if (oldest.done) {
      break;
    }
    warmedAt.delete(oldest.value);
  }
  return true;
}

/** Test hook: clears remembered keys and the throttle timestamp. */
export function resetIntentPrefetchForTests(): void {
  warmedAt.clear();
  lastAcceptedAt = 0;
}
