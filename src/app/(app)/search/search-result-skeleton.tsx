import { Skeleton } from "@/components/ui/skeleton";

/**
 * The `/search` RESULT AREA skeleton — the one skeleton design for search.
 *
 * Two callers, one component:
 *
 *   - `loading.tsx`, the route-level boundary, for the window Next knows
 *     about; and
 *   - `search-pending-results.tsx`, which paints the same thing from the
 *     client-side search lock the moment a search is submitted.
 *
 * They share it because a second, near-identical block would be two things
 * to keep in step — and the geometry below is a contract with the real result
 * layout, not a preference. It mirrors that layout section for section — top
 * result, track rows, artist grid, album grid — with the SAME outer spacing
 * and breakpoints as `page.tsx`, so nothing jumps when results replace it.
 * Every block is the shared glass skeleton (translucent sweep in Glass Mode,
 * pulse with it off), already disabled under `prefers-reduced-motion`
 * (`components/ui/skeleton.tsx`).
 *
 * IT IS NOT INTERACTIVE AND IS NOT ANNOUNCED. Every block goes through the
 * shared `Skeleton`, which sets `aria-hidden` itself: a screen reader must not
 * read twenty decorative rectangles. `aria-busy` on the region (set by each
 * caller) is the single honest signal that the area is loading. No placeholder
 * carries a role, a tabindex or an href.
 *
 * WHY THE FIELD IS NOT IN HERE: the real page field keeps its own geometry
 * and its own lock above this area. `SearchField` calls `useSearchParams()`,
 * so it cannot be server-rendered inside a Suspense fallback — the header
 * field in the layout is what stays mounted, focused and locked during a
 * search. `loading.tsx` documents the measurement behind that in full.
 */
export function SearchResultSkeleton() {
  return (
    <div className="flex flex-col gap-10">
      {/* Top result card: art + eyebrow + title + metadata + play. */}
      <section>
        <Skeleton className="mb-3 h-5 w-24" />
        <div className="flex items-center gap-4 rounded-2xl border border-border-subtle bg-surface-1 p-4 sm:p-5">
          {/* 88px art to match the real card's `Artwork pixelSize={88}`.
              `h-22 w-22` (5.5rem) renders 88px. */}
          <Skeleton className="h-22 w-22 shrink-0 rounded-xl" />
          <div className="relative flex min-w-0 flex-1 flex-col gap-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-3.5 w-1/4" />
          </div>
          <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
        </div>
      </section>

      {/* Track rows, inside the same bordered container the real list uses. */}
      <section>
        <Skeleton className="mb-3 h-5 w-24" />
        <div className="rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
          {/* Row geometry mirrors `TrackRow`'s own box: 44px art (`Artwork
              size="small" pixelSize={44}`), `gap-3`, `px-2 py-2`. The trailing
              slot mirrors the row's own `h-11 w-11 rounded-full` Play
              control, so the row keeps its width on populate. */}
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-11 w-11 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </span>
              <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </section>

      {/* Artist cards: circular art in the responsive grid. */}
      <section>
        <Skeleton className="mb-3 h-5 w-24" />
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <li
              key={index}
              className="flex min-w-0 flex-col items-center gap-2.5 rounded-xl border border-transparent p-2"
            >
              <Skeleton className="aspect-square w-full max-w-28 rounded-full" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3 w-14" />
            </li>
          ))}
        </ul>
      </section>

      {/* Album cards: square art in the same responsive grid. */}
      <section>
        <Skeleton className="mb-3 h-5 w-24" />
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <li
              key={index}
              className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-transparent p-2"
            >
              <Skeleton className="aspect-square w-full rounded-lg" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}