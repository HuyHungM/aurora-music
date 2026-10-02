"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { releaseSearchPending } from "@/lib/search/search-pending";

/**
 * Closes the search lock once the search page has rendered.
 *
 * Rendered by `/search`, which is the only component in the app that knows a
 * request has been answered — the field that started it lives in the layout and
 * cannot observe this page arriving. That asymmetry is why this component
 * exists at all.
 *
 * UNCONDITIONAL, and deliberately so. An earlier version released only when the
 * page's query matched the pending one, on the theory that a superseded
 * navigation must not close a newer search's lock. The measured cost was worse
 * than the imaginary risk: navigating elsewhere while a search was in flight
 * left the field locked for up to thirty seconds, on a page that was plainly
 * showing results. The race it was guarding against cannot happen anyway — the
 * field is locked while a search is pending, so no second search can start, and
 * React runs a mounted page's effect before the user can interact with it. And
 * the failure direction of getting this wrong is an unlocked field, never a
 * stuck one.
 *
 * The effect depends on the COMMITTED search params, not on mount. That
 * distinction is the fix for a real bug this file once had: with `[]` deps the
 * effect ran on the idle page's first mount and never again, because React
 * preserves the instance across the `/search` → `/search?q=…` navigation and a
 * mount-only effect does not re-fire for a new result set. Keying on what the
 * router has actually committed means every answered request releases, and a
 * unit test that renders this fresh for each case cannot mask a regression —
 * see the "re-fires" test in `search-locking.test.tsx`.
 *
 * An effect rather than a release during render, because the page must be
 * committed before the lock lifts: releasing mid-render would unlock the field
 * for the frame where results exist but have not painted.
 *
 * Renders nothing. Adding a node to the page would change the layout that
 * `loading.tsx` is carefully matching.
 */
export function SearchPendingRelease() {
  const committed = useSearchParams().toString();
  useEffect(() => {
    releaseSearchPending();
  }, [committed]);
  return null;
}