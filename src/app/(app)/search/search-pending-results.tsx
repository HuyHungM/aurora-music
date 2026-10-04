"use client";

import type { ReactNode } from "react";
import { useSearchPending } from "@/lib/search/search-pending";
import { looksLikeUrl } from "@/lib/search/input";
import { SearchResultSkeleton } from "./search-result-skeleton";

/**
 * Result-area skeleton, driven by the search lock rather than by the route's
 * `loading.tsx`.
 *
 * WHY THIS EXISTS WHEN `/search` ALREADY HAS A `loading.tsx`. The route
 * boundary only paints during Next's pending phase for that route, and this app
 * prefetches `/search` from the nav — `search-field.tsx` and
 * `search-pending.ts` both document that a prefetched route skips that phase.
 * That is the whole reason the client-side lock store exists instead of
 * `useTransition`. The consequence was that submitting a search left the
 * PREVIOUS results (or the idle empty state) painted, with nothing indicating
 * work was happening, for the entire request.
 *
 * The lock is the one signal that is honest about "a search is in flight": it is
 * armed synchronously at submit, before `router.push`, and it is the same
 * signal the field already uses to lock itself. So the skeleton is driven from
 * it, and it appears in the same frame as the submit.
 *
 * WHY THE COMPARISON IS AGAINST THE RENDERED QUERY, NOT AGAINST `null`. The
 * lock is released by `SearchPendingRelease` in an effect, so on the commit
 * that carries the answer the lock is still open. Gating on `pending !== null`
 * alone would therefore paint the skeleton OVER the results for one frame and
 * only then clear it — precisely the "keep the skeleton to satisfy an animation"
 * failure the brief calls out. Comparing the pending query with the query this
 * render actually shows makes the skeleton stop in that same render, with no
 * timer and no extra frame.
 *
 * This also gives latest-wins for free, without touching the server action: the
 * field refuses a second submit while the lock is open, so there is only ever
 * one active search, and the skeleton belongs to whichever query the lock holds.
 * A stale response cannot resurrect it, because the lock was never re-armed for
 * it.
 *
 * WHY NO SKELETON FOR A PASTED LINK. A link resolves to `LinkSearchResult`,
 * which is a completely different body — promising the text-search layout and
 * then replacing it with a link card is both misleading and a layout jump.
 * `looksLikeUrl` is the classifier's own first step, so this agrees with the
 * page's own routing decision rather than re-deciding it.
 */
export function SearchPendingResults({
  renderedQuery,
  children,
}: {
  /** The query this render is showing; `""` for the idle route and for links. */
  renderedQuery: string;
  children: ReactNode;
}) {
  const pendingQuery = useSearchPending((state) => state.query);

  const showSkeleton =
    pendingQuery !== null &&
    !looksLikeUrl(pendingQuery) &&
    pendingQuery.trim() !== renderedQuery.trim();

  if (!showSkeleton) return <>{children}</>;

  // `aria-busy` is NOT declared here, and that is the whole point of the
  // wrapper existing separately from it.
  //
  // TWO mechanisms can be in flight at once for one search, and each used to
  // claim the state: this island and `SearchField`'s own form. Measured
  // 2026-10-04 with the route navigation held open, `/search` published two
  // `[aria-busy="true"]` regions inside `main` for a single submit — and the
  // spec that caught it had assumed the second one was `loading.tsx`. It is not:
  // on `/search` → `/search?q=…` the page is already mounted, so Next never
  // shows the route fallback and `loading.tsx` never paints. The two were this
  // div and the field's form.
  //
  // The FIELD keeps it, for a semantic reason rather than a convenience one: it
  // is the only one of the two with an accessible NAME, so it is the only one a
  // screen reader can announce as anything but an anonymous busy group. "Search
  // tracks, busy" is useful; a nameless `<div aria-busy>` is not. Both are
  // driven by the same lock, so the field's claim is exactly as true as this
  // div's would have been — and it is the one that carries meaning.
  //
  // The skeleton stays `aria-hidden`, so a screen reader is told the area is
  // working without reading twenty decorative rectangles. `children` are not
  // rendered at all while this shows, which is what makes "no results found"
  // unable to flash.
  return (
    <div>
      <SearchResultSkeleton />
    </div>
  );
}