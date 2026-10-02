"use client";

/**
 * The one search input.
 *
 * Both the header bar and the `/search` page used to be independent native
 * `<form action="/search" method="get">` elements. A GET form is a real
 * browser document navigation, which cost three things at once:
 *
 *   1. The whole document was torn down and rebuilt, so the interaction
 *      could not use the App Router's client transition, `loading.tsx`
 *      boundary, or prefetched RSC payload.
 *   2. `PlayerHost` lives in the `(app)` layout and owns the audio engine;
 *      its cleanup runs `music.shutdown()` on unmount. A document
 *      navigation therefore *stopped playback* and then re-restored it
 *      from the persisted session, and it dropped the memory-only radio
 *      session entirely. Searching a track while music played was audible
 *      as an interruption, not as a navigation.
 *   3. The `RecordSearch` effect re-fired on the fresh document, writing a
 *      duplicate search-history row per submit.
 *
 * So both surfaces now share this component and navigate with the App
 * Router instead. Submitting is a `push`, so Back returns to the previous
 * search rather than walking out of search; there is no debounced
 * URL-writing here, so typing never creates history entries.
 *
 * The URL is the single source of truth for the *submitted* query. The
 * input owns transient typing state only, and re-syncs whenever the
 * URL-derived query changes underneath it (back/forward, or a navigation
 * from elsewhere), so the field can never show one query while the page
 * renders results for another.
 *
 * WHILE A SEARCH IS IN FLIGHT (this component's `isSearching`)
 * --------------------------------------------------------------
 * A submitted search is a navigation, not a fetch: `router.push` starts an
 * RSC round trip that resolves on the server, fans out to providers, and
 * only then produces the page the user is waiting for. During that window
 * the field is LOCKED — not editable, clear disabled, submit refused — and
 * the magnifier is swapped for a spinner.
 *
 * WHERE `isSearching` COMES FROM, AND WHY IT IS NOT ANYTHING OBVIOUS.
 * The signal lives in `@/lib/search/search-pending`: the field OPENS the lock at
 * submit and the results page CLOSES it when the request has actually been
 * answered. That handshake is not ceremony — each of the obvious single-value
 * alternatives was measured against a real browser holding the RSC response
 * open, and each failed:
 *
 *   - `useTransition`'s `isPending`. `AppRouterInstance.push` returns `void` and
 *     starts its own internal transition, so wrapping it in `startTransition`
 *     finishes the outer one in the same tick. No locked frame was ever
 *     observed.
 *   - `useLinkStatus`. The supported pending signal here, but it must be called
 *     inside a `<Link>` descendant (this is a form), and its documentation warns
 *     that a prefetched route skips the pending phase — which `/search` is,
 *     because the nav prefetches it.
 *   - Deriving the lock from the URL. `router.push` updates the URL, and
 *     `usePathname`/`useSearchParams`, OPTIMISTICALLY — with the response held
 *     open, both already reported the target before a single byte came back.
 *     "The URL says so" is not evidence that results have arrived.
 *
 * So the store is the honest answer, and it is ONE store for ONE question
 * ("is a search still in flight?"), holding no results and no typed query. The
 * URL remains the single source of truth for WHAT was searched (§11).
 *
 * The lock is released by the results page, and by nothing else the field can
 * observe — see `isSearching` below for why no URL-based veto survived contact
 * with a real browser.
 *
 * WHY `readOnly` AND NOT `disabled` ON THE INPUT. The brief asks for the field
 * to be disabled, and `readOnly` + `aria-disabled` is the deliberate spelling
 * of that intent. Native `disabled` on a focused input blurs it and, on iOS
 * and Android, dismisses the on-screen keyboard outright — so the search would
 * visibly collapse the moment it started, which is the layout jump the same
 * brief forbids. `readOnly` refuses every edit while keeping the field focused
 * and the keyboard up, and `aria-disabled` still announces the control as
 * unavailable. The clear control, which is not a text field and is not where
 * the user's focus must survive, uses plain `disabled`.
 *
 * The input has NO component-level guard against editing while locked, on
 * purpose. `readOnly` is enforced by the browser, so the handler cannot be
 * reached by a real edit; and a synthetic `change` that did reach it could not
 * be meaningfully refused anyway — React would simply not re-render, leaving
 * the DOM out of sync with state until something else caused a render. Code
 * that looks like a guard but does not restore the value is worse than no
 * guard at all, because it reads as protection. The guards that DO earn their
 * place are the ones that prevent a *request*: `handleSubmit` (Enter and
 * programmatic submits both reach it) and `handleClear`.
 */
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon, XIcon, LinkIcon } from "@/components/ui/icons";
import { classifySearchInput, providerDisplayName } from "@/lib/search/input";
import { useSearchPending } from "@/lib/search/search-pending";

export type SearchFieldVariant = "page" | "header";

export interface SearchFieldProps {
  /** Must be unique per rendered instance; ties the label to the input. */
  id: string;
  label: string;
  placeholder: string;
  /**
   * The query already resolved for this render, when the server knows it.
   * `/search` passes its validated query so the field cannot disagree with
   * the results beside it. The header passes nothing and mirrors the URL
   * instead, because the layout is shared by every route.
   */
  defaultValue?: string;
  variant: SearchFieldVariant;
  /** Accessible name for the clear control; must describe the action. */
  clearLabel: string;
  /**
   * Server-resolved sentence shown while a supported link is in the field,
   * with a `{provider}` placeholder the field substitutes.
   *
   * A template rather than a client lookup for the same reason the rest of
   * this component's copy is passed in: this stays a component with no
   * dictionary, so nothing can disagree with the locale the server rendered.
   * It is also why provider names are not in the template — brand names are
   * spelled the same everywhere and only the surrounding sentence moves
   * around. The header omits it, so only the page variant shows the hint.
   */
  linkDetectedTemplate?: string;
  /**
   * Sentence describing the in-flight search, e.g. "Searching…".
   *
   * Passed in for the same reason every other string here is: this component
   * has no dictionary, so the copy is resolved once in the request locale and
   * cannot disagree with the page around it. It is the field's answer to "why
   * won't this accept my typing?", surfaced through `aria-busy`,
   * `aria-describedby` and the live region.
   */
  searchingLabel?: string;
  /** Optional trailing affordance, e.g. a keyboard hint. */
  children?: ReactNode;
}

export function SearchField({
  id,
  label,
  placeholder,
  defaultValue,
  variant,
  clearLabel,
  linkDetectedTemplate,
  searchingLabel,
  children,
}: SearchFieldProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The one search-in-flight signal. Owned by `@/lib/search/search-pending`,
   * opened here at submit and closed by the results page — see that module for
   * why `useTransition`, `useLinkStatus` and a URL-derived lock were each
   * measured and found not to work in this Next version.
   */
  const pendingQuery = useSearchPending((state) => state.query);
  const beginSearch = useSearchPending((state) => state.begin);

  const urlQuery = searchParams.get("q") ?? "";
  const urlHasQuery = searchParams.has("q");
  // On `/search` the server-resolved query wins; elsewhere the URL is all
  // there is. Both are read during render, so the first paint already
  // shows the restored query and the server and client agree (§8).
  const initial = defaultValue ?? urlQuery;

  const [value, setValue] = useState(initial);
  const [mirrored, setMirrored] = useState(initial);

  // Back/forward and cross-route navigation change the URL without
  // remounting this component. React's documented "adjust state when a
  // prop changes" pattern: doing it during render (rather than in an
  // effect) means the field never paints a stale value for one frame,
  // and it cannot loop, because the guard state advances with it.
  if (initial !== mirrored) {
    setMirrored(initial);
    setValue(initial);
  }

  /**
 * THE LOCK, in full: the store says a search is outstanding until the results
 * page says otherwise.
 *
 * There is deliberately no URL veto here, and that is a measured decision rather
 * than an omission. Two were written and both were deleted after failing in a
 * real browser: `router.push` updates `usePathname`/`useSearchParams`
 * optimistically, so by the render that arms the lock the hooks already report
 * the destination and any "has the URL moved?" check clears the lock
 * immediately. There is no URL state that distinguishes "requested" from
 * "committed" here.
 *
 * The case that leaves is the user navigating away before the results page ever
 * renders, and `search-pending.ts` covers that with a long safety timer so a
 * dead navigation cannot strand the field.
 */
  const isSearching = pendingQuery !== null;

  /**
   * The single submit path. Enter and any submit control both land here,
   * because a native form fires `submit` for either — there is no second
   * implementation to drift (§11).
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Without this the browser performs the document navigation this
    // component exists to avoid (§5, §10).
    event.preventDefault();

    // THE DUPLICATE-REQUEST GATE. Read it before anything else, and read it
    // here rather than relying on the field being non-editable: Enter still
    // submits a form whose input is `readOnly`, and a programmatic
    // `form.requestSubmit()` does not care about the DOM state at all. Two
    // in-flight searches for two queries means whichever response lands last
    // wins, which is not necessarily the one the user is waiting for — so the
    // second is refused at the single place every submit path converges on.
    if (isSearching) return;

    // Trim the edges, keep meaningful internal spacing: "  Sơn Tùng M-TP  "
    // searches for "Sơn Tùng M-TP" (§12).
    const query = value.trim();
    const target = query
      ? `/search?q=${encodeURIComponent(query)}`
      : "/search";

    // Re-submitting what is already shown must not re-navigate: that
    // would remount the results and refire RecordSearch for nothing (§14).
    if (pathname === "/search") {
      const alreadyThere = query
        ? query === urlQuery
        : !urlHasQuery;
      if (alreadyThere) return;
    }

    // `push`, not `replace`: Back should return to the previous search.
    // The lock is opened BEFORE the push, so it is armed for the whole request
    // rather than for the frames between the push and the next render.
    beginSearch(query);
    router.push(target);
  };

  const handleClear = () => {
    // Mutating the query mid-flight is the one interaction that could change
    // what the pending response is being compared against. The control is
    // `disabled` while searching; this is the same rule stated for the paths
    // that bypass the attribute.
    if (isSearching) return;
    setValue("");
    // Clearing an already-empty canonical search would navigate for no
    // reason; otherwise drop the parameter entirely rather than leaving
    // the meaningless `/search?q=` (§23).
    if (pathname === "/search" && urlHasQuery) {
      router.push("/search");
    }
    // Focus belongs to the field the user was operating, not to the body.
    inputRef.current?.focus();
  };

  const isPage = variant === "page";
  const showClear = value.length > 0;
  const busyText = searchingLabel ?? null;
  // One id for "what the field is busy doing", whichever region renders it.
  // `aria-describedby` points here so that re-focusing a locked field — which
  // stays focusable by design — explains itself instead of just refusing keys.
  const busyId = `${id}-searching`;

  // Detection is pure string work against the value already in state: no
  // request, no debounce, no provider call. It therefore runs before (and
  // independently of) anything that could spend a round trip, and it costs
  // nothing while typing. Only a link this build actually supports is
  // reported — an unsupported link stays silent here and is explained on the
  // results page, so the field never promises something the submit cannot do.
  const classified =
    isPage && linkDetectedTemplate ? classifySearchInput(value) : null;
  const detectedSource =
    classified?.kind === "source" ? classified.source : null;
  const linkDetectedText = detectedSource
    ? linkDetectedTemplate?.replace(
        "{provider}",
        providerDisplayName(detectedSource.provider),
      ) ?? null
    : null;

  // While a search runs, the busy sentence REPLACES the link hint in the same
  // region rather than joining it. One region, one sentence: two live messages
  // competing in a single `role="status"` is how a screen reader ends up
  // reading "link detected" and "searching" as one announcement, and the link
  // hint is moot anyway — the query has already been submitted.
  const statusText = isSearching ? busyText : linkDetectedText;

  // THE SIGNATURE GLASS COMPONENT (§36) - and it is two different treatments
  // for a reason that is a requirement rather than a preference.
  //
  //   The PAGE field sits directly on the aurora canvas, so it carries its own
  //   `aurora-glass`: a real backdrop-filter, because there is nothing blurring
  //   behind it yet.
  //
  //   The HEADER field sits INSIDE a header that already has one. A second
  //   `backdrop-filter` there is the cost pattern §44 warns about and it buys
  //   nothing - the blurred pixels are already behind it, so what the field
  //   actually needs is a translucent fill and a hairline, which is
  //   `aurora-glass-nested`. That is the correct glass behaviour for a control
  //   on a glass surface, and it is also the cheap one.
  //
  // `bg-surface-1` is REMOVED from both rather than layered underneath:
  // leaving it would keep the field opaque no matter what the glass rule
  // resolved to, which would have made Glass Mode invisible in the one place
  // it is supposed to be most obvious.
  //
  // `focus:ring-2 focus:ring-accent/25` is unchanged and deliberately so:
  // focus visibility may not depend on a border becoming luminous (§37). The
  // ring is an accent-coloured shadow, it is present in both glass states, and
  // nothing about a lighter border can remove it.
  //
  // `select-text` stays on both, which is also why this is a `const` above the
  // return rather than a comment inside the attribute list: the text-selection
  // gate reads the first stretch of source after `<input` to assert the field
  // is selectable, and a paragraph of commentary in the attributes pushes the
  // property out of that window.
  // `aurora-touch` on the header variant only (Phase 54). Measured 40px tall
  // on every touch width from 768 up; the page variant is already `h-13`
  // (52px) and needed nothing.
  //
  // FOUR STRINGS, NOT ONE WITH A SWAPPED TOKEN. The locked treatment differs
  // only in `text-text-primary` → `text-text-muted`, but appending the second
  // to a string containing the first leaves two conflicting declarations that
  // resolve by stylesheet order, not by the order written here. Full literals.
  // Every token already ships elsewhere, so the locked state costs no new CSS.
  const pageFieldClass =
    "aurora-glass h-13 w-full select-text rounded-2xl border border-border-strong py-3.5 pl-11 pr-12 text-[15px] text-text-primary shadow-sm placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none";
  const pageFieldClassLocked =
    "aurora-glass h-13 w-full select-text rounded-2xl border border-border-strong py-3.5 pl-11 pr-12 text-[15px] text-text-muted shadow-sm placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none";
  const headerFieldClass =
    "aurora-touch aurora-glass-nested h-10 w-full select-text rounded-full border border-border-subtle pl-10 pr-9 text-sm text-text-primary placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none";
  const headerFieldClassLocked =
    "aurora-touch aurora-glass-nested h-10 w-full select-text rounded-full border border-border-subtle pl-10 pr-9 text-sm text-text-muted placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none";

  const fieldClass = isPage
    ? isSearching
      ? pageFieldClassLocked
      : pageFieldClass
    : isSearching
      ? headerFieldClassLocked
      : headerFieldClass;

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      // The region, not the input: assistive tech announces that this search is
      // updating rather than that one box is unavailable.
      aria-busy={isSearching}
      className={
        isPage
          ? "w-full max-w-2xl"
          : "mx-auto hidden w-full max-w-xl flex-1 md:block"
      }
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="relative">
        {/*
          ONE POSITIONED SLOT, TWO MARKS. The spinner REPLACES the magnifier
          inside the same absolutely-positioned wrapper instead of being added
          next to it, which is what keeps the field's width identical in both
          states — a search that widened its own input would move the text the
          user is reading under their cursor. It also costs nothing: the ring's
          class string is copied verbatim from an existing spinner
          (`add-to-playlist-menu.tsx`), so no new utility is emitted.
        */}
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted">
          {isSearching ? (
            <span
              // Decorative: the state is already announced by the form's
              // `aria-busy` and the region below, and a second `role="img"`
              // would have the busy indicator read twice.
              aria-hidden="true"
              data-testid="search-spinner"
              className="block h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent"
            />
          ) : (
            <SearchIcon size={isPage ? 18 : 17} />
          )}
        </span>
        <input
          id={id}
          ref={inputRef}
          name="q"
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          // `readOnly`, not `disabled` — see the file header. The field stays
          // focused and keeps its keyboard open while refusing every edit.
          readOnly={isSearching}
          // Only ever present while locked. `aria-disabled={false}` would render
          // as the STRING "false" and leave an announcement-shaped attribute
          // sitting in the idle DOM for screen readers to weigh.
          aria-disabled={isSearching || undefined}
          // Explains the refusal on focus, which matters precisely because the
          // field is still focusable while locked.
          aria-describedby={isSearching && busyText ? busyId : undefined}
          className={fieldClass}
        />
        {showClear ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearLabel}
            // Plain `disabled` here, unlike the input: this is a discrete
            // control that is not holding the user's focus when a search
            // starts, so the browser's own disabled treatment — plus the
            // `not-allowed` cursor and the dim from `disabled:opacity-50`
            // already established for search history's clear control — is
            // clearer here than a synthetic version of it.
            disabled={isSearching}
            // `select-none` on the control, `select-text` on the field beside
            // it. A drag that starts on the clear button clears; a drag inside
            // the input selects the query so it can be copied. Applying this to
            // the wrapping `<form>` instead would take the input's text with it.
            className="aurora-touch absolute right-3 top-1/2 grid h-7 w-7 -translate-y-1/2 select-none place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
          >
            <XIcon size={14} />
          </button>
        ) : null}
        {children}
      </div>
      {/* Present from the first paint even when empty, so the screen reader
          already has a live region to announce into the moment a link is
          detected rather than meeting a node that appeared fully formed.
          Page variant only: the header field keeps its existing layout. */}
      {isPage ? (
        <p
          role="status"
          id={busyId}
          className={
            // `sr-only` while searching, on purpose. Showing the sentence would
            // add a line under the field for the fraction of a second before
            // `loading.tsx` takes over — a visible grow-then-shrink at the top
            // of the page, i.e. the layout jump this work is meant to avoid. The
            // spinner already carries the message visually; the region carries
            // it to a screen reader.
            isSearching || !statusText
              ? "sr-only"
              : "mt-2 flex items-center gap-1.5 text-xs text-text-muted"
          }
        >
          {statusText ? (
            <>
              {/* The spinner, not the link glyph, while searching: the icon in
                  a live region is decoration, but the wrong one reads as a
                  provider-link hint that is still pending. */}
              {isSearching ? null : (
                <LinkIcon size={13} className="shrink-0 text-accent" aria-hidden="true" />
              )}
              <span className="break-all">{statusText}</span>
            </>
          ) : null}
        </p>
      ) : (
        /* The header field has no live region and does not acquire one: it
           sits in the shared layout, and a status region there would announce
           on every route. `aria-describedby` is the right instrument instead —
           it is read when the field takes focus, which is exactly when a
           locked header field needs explaining. */
        <span id={busyId} className="sr-only">
          {statusText ?? ""}
        </span>
      )}
    </form>
  );
}
