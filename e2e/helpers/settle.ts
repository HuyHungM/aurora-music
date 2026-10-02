import type { Page } from "@playwright/test";

/**
 * Wait until no FINITE animation is still running.
 *
 * Geometry measured mid-animation is not the resting layout: `presence`
 * sheets enter from 12px low, dialogs scale in, and hover/press transitions
 * move surfaces. Every geometry assertion in this suite has to be taken on a
 * settled frame or it measures the transition instead of the result.
 *
 * Infinite animations (the aurora drift, glass shimmer, now-playing bars) are
 * deliberately ignored — they never finish, so waiting on them would time out
 * rather than settle.
 *
 * This was copied byte-for-byte into three specs, one of which defined it and
 * then never called it (using six fixed sleeps instead). One definition, so a
 * fix to the settle condition cannot leave two specs behind.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      // `subtree: true` is specified by the CSS Animations Level 2 and
      // implemented in Chromium; the DOM lib in this TypeScript version still
      // types `getAnimations()` as argument-less, so the option is passed
      // through a widened local rather than silenced with an `any`. The cast
      // states exactly what is true: the runtime takes an options bag this
      // type does not describe yet.
      (
        document.getAnimations as (options?: { subtree?: boolean }) => Animation[]
      )({ subtree: true }).every((a) => {
        if (a.playState !== "running") return true;
        return a.effect?.getComputedTiming().iterations === Infinity;
      }),
    undefined,
    { timeout: 10_000 },
  );
}