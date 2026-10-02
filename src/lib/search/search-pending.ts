"use client";

import { create } from "zustand";

/**
 * ONE piece of state for "a submitted search is still in flight".
 *
 * WHY THIS EXISTS AT ALL, because every obvious alternative was measured against
 * a real browser holding the RSC response open, and each one failed:
 *
 *   - `useTransition`'s `isPending` does NOT work. `AppRouterInstance.push`
 *     returns `void` and starts its own internal transition, so wrapping it in
 *     `startTransition` leaves the outer transition finishing in the same tick.
 *     No locked frame was ever observed.
 *   - `useLinkStatus` is the supported pending signal in this Next version, but
 *     it must be called inside a `<Link>` descendant (this is a form), and its
 *     own documentation warns that a prefetched route skips the pending phase —
 *     which `/search` is, because the nav prefetches it.
 *   - Deriving the lock from the URL does not work either. `router.push` updates
 *     the URL, and `usePathname`/`useSearchParams`, OPTIMISTICALLY: with the
 *     response held open for fifteen seconds, both hooks already read the target
 *     and `location.href` already read `/search?q=…`. "The URL says so" is not
 *     evidence that results are in.
 *   - Nor can the URL VETO the lock. A version that released on "the URL no
 *     longer matches" fired in the very same render that armed it — the hooks
 *     had already reported the destination — and cleared the lock before a
 *     single byte of the response came back.
 *
 * What is left is the honest signal: the search is over when the page that shows
 * its results renders. That is a two-party handshake — the field opens it, the
 * results page closes it — and this module is the only place either end talks.
 *
 * WHY THERE IS STILL A TIMER. The release cannot fire for one case: the user
 * submits and then navigates AWAY before the search page arrives, so the page
 * that would have released the lock never renders. The safety timer exists only
 * for that. It is an order of magnitude longer than any real search, so it can
 * never unlock early, and it guarantees that a failed or abandoned navigation
 * cannot leave the search field permanently unusable. It is deliberately NOT
 * the mechanism.
 *
 * It is deliberately not a second copy of the search state. It holds no results,
 * no query being typed, and no error; the URL remains the single source of truth
 * for what was searched (§11).
 */
interface SearchPendingState {
  /**
   * The query of the search whose results have not arrived yet, or `null`.
   * `""` is a real value: clearing the field navigates to the bare `/search`,
   * and conflating it with "no search" would strand the lock on the idle route.
   */
  query: string | null;
  /** Open the lock. Called once, at submit. */
  begin: (query: string) => void;
  /** Close it. Called when the results page renders. */
  release: () => void;
}

/**
 * How long a lock may outlive the page that releases it.
 *
 * Long enough that no real search is cut short — the slowest provider path in
 * this app is seconds, not tens of seconds — and short enough that a user who
 * navigated away is not left staring at a dead field.
 */
export const PENDING_SAFETY_MS = 30_000;

let safetyTimer: ReturnType<typeof setTimeout> | null = null;

function clearSafetyTimer(): void {
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
}

export const useSearchPending = create<SearchPendingState>((set) => ({
  query: null,
  begin: (query) => {
    clearSafetyTimer();
    set({ query });
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      useSearchPending.setState({ query: null });
    }, PENDING_SAFETY_MS);
  },
  release: () => {
    clearSafetyTimer();
    set({ query: null });
  },
}));

/**
 * Releases the lock. Idempotent, and safe to call when nothing is pending.
 *
 * It does NOT take the query it is releasing. A version that compared queries
 * looked more careful and was measurably worse: navigating away from a pending
 * search — to a history chip, to another route — left the field locked for up
 * to the safety window on a page that was plainly showing results. The race that
 * comparison was guarding against cannot happen (the field is locked while a
 * search is pending, so no second search can begin, and React runs a mounted
 * page's effect before the user can interact with it), and the failure
 * direction here is an unlocked field rather than a stuck one.
 */
export function releaseSearchPending(): void {
  useSearchPending.getState().release();
}