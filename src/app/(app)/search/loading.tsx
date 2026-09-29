import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level skeleton for `/search`.
 *
 * Aurora's search is submit-driven, so this is the loading state the user
 * actually sees: they submit, `router.push` starts the RSC fetch, and this
 * boundary paints until the server component resolves. It mirrors the real
 * result layout section for section — header, field, top result, track rows,
 * then the artist and album grids — so the page does not jump when the real
 * results replace it. Each block reuses the same outer spacing and breakpoints
 * as `page.tsx`; the shimmer is `animate-pulse`, disabled under
 * `prefers-reduced-motion` (see `components/ui/skeleton.tsx`).
 */
export default function SearchLoading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      {/* Header: eyebrow, page title, subtitle. */}
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <Skeleton className="h-4 w-1/3 max-w-xs" />
      </div>

      {/* The page search field: `max-w-2xl`, `h-13`, `rounded-2xl`. */}
      <div className="h-13 w-full max-w-2xl rounded-2xl border border-border-strong">
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>

      <div className="flex flex-col gap-10">
        {/* Top result card: art + eyebrow + title + metadata + play. */}
        <section>
          <Skeleton className="mb-3 h-5 w-24" />
          <div className="flex items-center gap-4 rounded-2xl border border-border-subtle bg-surface-1 p-4 sm:p-5">
            <Skeleton className="h-20 w-20 shrink-0 rounded-xl" />
            <div className="relative flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-3.5 w-1/4" />
            </div>
            <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
          </div>
        </section>

        {/* Track rows, inside the same bordered container. */}
        <section>
          <Skeleton className="mb-3 h-5 w-24" />
          <div className="rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="h-11 w-11 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-1/4" />
                </span>
                <Skeleton className="h-3 w-8 shrink-0" />
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
    </div>
  );
}
