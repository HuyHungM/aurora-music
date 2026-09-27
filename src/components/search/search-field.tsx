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
 */
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon, XIcon, LinkIcon } from "@/components/ui/icons";
import { classifySearchInput, providerDisplayName } from "@/lib/search/input";

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
  children,
}: SearchFieldProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

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
   * The single submit path. Enter and any submit control both land here,
   * because a native form fires `submit` for either — there is no second
   * implementation to drift (§11).
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Without this the browser performs the document navigation this
    // component exists to avoid (§5, §10).
    event.preventDefault();

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
    router.push(target);
  };

  const handleClear = () => {
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
  // on every touch width from 768 up, which is the size the app uses for a
  // mouse-driven field; the page variant is already `h-13` (52px) and needed
  // nothing. The header field is the primary path to search on a tablet, so
  // it gets the floor. `min-width: 44px` is inert against `w-full`.
  const fieldClass = isPage
    ? "aurora-glass h-13 w-full select-text rounded-2xl border border-border-strong py-3.5 pl-11 pr-12 text-[15px] text-text-primary shadow-sm placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none"
    : "aurora-touch aurora-glass-nested h-10 w-full select-text rounded-full border border-border-subtle pl-10 pr-9 text-sm text-text-primary placeholder:text-text-disabled focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:appearance-none";

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
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
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted">
          <SearchIcon size={isPage ? 18 : 17} />
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
          className={fieldClass}
        />
        {showClear ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearLabel}
            // `select-none` on the control, `select-text` on the field beside
            // it. A drag that starts on the clear button clears; a drag inside
            // the input selects the query so it can be copied. Applying this to
            // the wrapping `<form>` instead would take the input's text with it.
            className="absolute right-3 top-1/2 grid h-7 w-7 -translate-y-1/2 select-none place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
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
          className={
            linkDetectedText
              ? "mt-2 flex items-center gap-1.5 text-xs text-text-muted"
              : "sr-only"
          }
        >
          {linkDetectedText ? (
            <>
              <LinkIcon size={13} className="shrink-0 text-accent" aria-hidden="true" />
              <span className="break-all">{linkDetectedText}</span>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
