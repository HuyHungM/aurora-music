import Link from "next/link";
import { SparkleIcon } from "@/components/ui/icons";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      aria-label="Aurora Music home"
      className="aurora-press aurora-touch inline-flex items-center gap-2.5 rounded-xl outline-none"
    >
      {/* The mark: a pastel-lit squircle with a hairline rim and a soft
          electric-violet bloom (Stitch logo). The gradient is the canonical
          aurora fill, so the mark is the same violet light as the primary
          action, not a second brand colour. */}
      <span className="aurora-fill relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl text-background ring-1 ring-inset ring-white/20 shadow-[0_0_22px_-6px_var(--aurora-electric-violet)]">
        <SparkleIcon size={18} />
      </span>
      {!compact ? (
        // THE WORDMARK YIELDS, AND THE THRESHOLD IS MEASURED.
        //
        // The header is one flex row: brand, search button, language, settings,
        // and - when signed in - a 98px account group (a 46px avatar pill plus
        // the 44px sign-out target). Below `md` the search *field* is `hidden`
        // and only its icon button remains, so the row is five fixed-width
        // items plus the brand, and the slack between them is a function of
        // the viewport and nothing else. Signed in, the row needs 393px:
        // 44 mark + 47 wordmark + 4x44 controls + 98 account + 4x12 gaps
        // + 32 padding. The wordmark's 47px is the difference between a row
        // that fits and one that scrolls sideways.
        //
        // The alternative - dropping the wordmark for every phone - would cost
        // a phone that has room for it, so it is revealed from the width where
        // it actually fits. See the Phase 54 note below for the measurement
        // that sets the exact number.
        //
        // Phase 54, second measurement. The 380px threshold was derived
        // before the header's controls reached their 44px touch floor, and
        // the sign-out button growing from 36px to 44px pushed the row's
        // requirement from 346px to 393px. At 380px the threshold therefore
        // became wrong in the worst direction: the wordmark came back at
        // exactly the width where the row no longer fit.
        //
        // Re-measured signed in, in the browser, at one-pixel steps:
        //   375px  wordmark hidden  -> row fits, no document overflow
        //   380px  wordmark shown   -> row 399px wide in a 380px viewport
        //   390px  wordmark shown   -> row 399px wide, 9px of horizontal
        //                                document scroll
        //   393px  wordmark shown   -> 6px of horizontal document scroll
        //   400px  wordmark shown   -> no document scroll, but the row is
        //                                still wider than its content box, so
        //                                the trailing 16px of safe padding is
        //                                silently eaten - a defect the
        //                                "does the document scroll" test
        //                                cannot see.
        //   415px+ row fits outright
        //
        // So 392px, not a round number: it is the last width at which the
        // wordmark is revealed and still fits. The mark, the accessible name
        // and the sidebar copy are all unaffected, and the sidebar that shows
        // the wordmark at full size is `hidden lg:flex`, far below this.
        //
        // The second half of the fix lives in `header.tsx`: the wordmark is
        // the row's one elastic child (`min-w-0`, and its wrapper is NOT
        // `shrink-0`), so if this threshold is ever wrong - a longer locale,
        // a wider fallback font, a future account control - the wordmark
        // ellipsizes rather than the row scrolling sideways or deforming a
        // declared 44px touch target. A threshold that is slightly early now
        // degrades instead of breaking.
        // The space between the two words is real, not decorative. They are
        // two elements, so without it the element's text content is
        // "AuroraMusic" - one word - and a voice-control user cannot say what
        // is on screen to get what is on screen (WCAG 2.5.3, Label in Name).
        // A whitespace-only run is not rendered as a flex item, so naming the
        // wordmark "Aurora Music" costs the layout nothing.
        <span className="flex min-w-0 flex-col leading-none max-[392px]:hidden">
          <span className="truncate text-[15px] font-bold tracking-tight">Aurora</span>{" "}
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-text-muted">
            Music
          </span>
        </span>
      ) : null}
    </Link>
  );
}
