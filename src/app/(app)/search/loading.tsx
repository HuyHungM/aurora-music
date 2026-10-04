import { Skeleton } from "@/components/ui/skeleton";
import { SearchResultSkeleton } from "./search-result-skeleton";

/**
 * Route-level skeleton for `/search`.
 *
 * Aurora's search is submit-driven, so this is the loading state the user
 * actually sees: they submit, `router.push` starts the RSC fetch, and this
 * boundary paints until the server component resolves.
 *
 * THIS FILE IS NOT THE ONLY LOADING STATE, and the split is deliberate. This
 * boundary can only paint during Next's pending phase for `/search`, and `/search`
 * is prefetched from the nav — a prefetched route skips that phase, which is
 * documented at length in `search-pending.ts` and `search-field.tsx` and is the
 * entire reason the client-side lock store exists instead of `useTransition`. So
 * the window in which Next does NOT report pending is covered by
 * `search-pending-results.tsx`, which paints the same result area from the lock.
 * Both render `SearchResultSkeleton`, so the loading state is one design with two
 * callers rather than two designs to keep in step.
 *
 * What is left here is the part only this boundary can show: the header and the
 * page field placeholder, both above the result area.
 *
 * The result area mirrors the real result layout section for section — top
 * result, track rows, artist grid, album grid — with the same outer spacing and
 * breakpoints as `page.tsx`, so the page does not jump when the real results
 * replace it. Every block is the shared glass skeleton (translucent sweep in
 * Glass Mode, pulse with it off), disabled under `prefers-reduced-motion` (see
 * `components/ui/skeleton.tsx`).
 *
 * WHY THE FIELD IS A BLOCK AND NOT THE REAL `SearchField`
 *
 * This was tried: a version of this file rendered the actual shared field
 * instead of the placeholder, on the reasoning that the page field would then
 * keep showing the submitted query and carry its own lock, spinner and
 * `aria-busy`. It does not work, and the reason is structural rather than
 * fixable here.
 *
 * `SearchField` calls `useSearchParams()`. A client component that does is not
 * server-rendered inside a Suspense fallback — Next has no search params to give
 * it while the navigation is still in flight, so it bails out and emits nothing.
 * Measured in the browser: during a held RSC response this boundary rendered
 * 57 skeleton blocks and ZERO `input[type=search]` elements, i.e. the field was
 * simply absent rather than present-and-real.
 *
 * So the field's real behaviour during a search is delivered by the LAYOUT's
 * header field instead. That one is never unmounted by this boundary, so it
 * stays mounted, focused and locked for the whole request, and it is what
 * `e2e/search-loading.spec.ts` asserts against. The page field's own lock is a
 * correctness guard (it refuses a second submit) whose visible lifetime is
 * almost nil, because it exists only once this boundary has been replaced.
 *
 * Giving the fallback a real, interactive field would mean removing
 * `useSearchParams()` from `SearchField` — a client component with a great deal
 * of carefully measured behaviour in it — to serve a below-`md` case where the
 * header field is not rendered. That trade is not worth it, and it is not this
 * file's to make.
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

      {/*
        The page search field: `md:max-w-4xl`, `h-13`, `rounded-2xl`.

        GEOMETRY CONTRACT. This must keep the exact outer box of the real page
        field (`SearchField` variant="page": `aurora-glass h-13 w-full
        rounded-2xl border border-border-strong` inside `form.mx-auto w-full
        md:max-w-4xl`). The three tokens that decide the box — height, width
        cap, radius — are mirrored token-for-token; the loading test pins the
        full strings. The wrapper also carries `aurora-glass` so the surface
        treatment matches: both sides paint the same translucent field
        surface, and neither side is opaque.

        WHY THE INNER FILL, NOT A FLAT BLOCK. The real input fills its whole
        box with translucent surface and carries a hairline border. A single
        flat `Skeleton` would paint that block correctly — and that is all this
        is: a full-bleed inner fill inside a border-carrying wrapper, so the
        wrapper owns the border the way the real field does.

        `overflow-hidden` ON THE WRAPPER, AND ONLY THERE. Every `Skeleton`
        paints `overflow: hidden` on itself for its own sweep — but the sweep
        is `inset: 0`, so it never leaves its own box, and this wrapper's
        radius (28px at 16px root) is smaller than its height, meaning a square
        inner corner would poke past the rounded border. The page's other
        skeleton wrappers (top-result card, track container) do not need this:
        their inner fills are inset by padding. Here the fill is full-bleed,
        so the wrapper clips it. The real form needs no such rule — it has no
        inner fill to clip.
      */}
      <div className="aurora-glass h-13 w-full overflow-hidden rounded-2xl border border-border-strong md:max-w-4xl">
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>

      {/* The result area, shared verbatim with the client-driven pending state
          (`search-pending-results.tsx`). `gap-10` is the page's own rhythm for
          this block; `loading.test.tsx` pins both sides of that contract. */}
      <SearchResultSkeleton />
    </div>
  );
}
