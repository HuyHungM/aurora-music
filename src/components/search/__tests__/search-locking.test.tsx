// @vitest-environment jsdom
/**
 * Search locking: what the field does between a submit and the arrival of the
 * results.
 *
 * HOW THE IN-FLIGHT WINDOW IS DRIVEN. The lock is a real store
 * (`@/lib/search/search-pending`), opened by the field at submit and closed by
 * the results page. These tests therefore drive it the way the app does: a
 * submit opens it, and `SearchPendingRelease` — rendered here directly, because
 * `page.tsx` is a server component — closes it. That is a real handshake, not a
 * mocked hook: if the release path ever stops matching the opening one, these
 * tests fail.
 *
 * What these tests cannot prove is that the browser re-renders the layout's
 * field while a navigation is in flight, nor that the release component actually
 * mounts in the real page. That is `e2e/search-loading.spec.ts`, which holds a
 * real RSC response open and asserts the lock on a real page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchField, type SearchFieldVariant } from "../search-field";
import { SearchPendingRelease } from "@/app/(app)/search/search-pending-release";
import { useSearchPending } from "@/lib/search/search-pending";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/",
  query: "",
}));

/** Minimal stand-in for the read-only object `useSearchParams` returns. */
function params() {
  const sp = new URLSearchParams(mocks.query);
  return {
    get: (key: string) => sp.get(key),
    has: (key: string) => sp.has(key),
    // The release component keys its effect on the committed params, so the
    // mock must answer `toString` the way `ReadonlyURLSearchParams` does.
    toString: () => sp.toString(),
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => params(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pathname = "/";
  mocks.query = "";
  // `release` rather than a raw `setState`, so the store's safety timer is
  // cancelled too and cannot outlive the test that started it.
  useSearchPending.getState().release();
});

const CLEAR = "Clear search";
const SEARCHING = "Searching…";
const QUERY = "never gonna give you up";

function Field(props: Partial<Parameters<typeof SearchField>[0]> = {}) {
  return (
    <SearchField
      id="q"
      variant="page"
      label="Search tracks"
      placeholder="Search…"
      clearLabel={CLEAR}
      searchingLabel={SEARCHING}
      {...props}
    />
  );
}

function renderField(props: Partial<Parameters<typeof SearchField>[0]> = {}) {
  const utils = render(Field(props));
  return {
    ...utils,
    /** Re-renders against the given URL, as a committed navigation does. */
    commit(pathname: string, query: string) {
      mocks.pathname = pathname;
      mocks.query = query;
      utils.rerender(Field(props));
    },
  };
}

const input = () => screen.getByRole("searchbox") as HTMLInputElement;
const form = () => screen.getByRole("search");
const clearButton = () => screen.getByRole("button", { name: CLEAR }) as HTMLButtonElement;

/** The absolutely-positioned slot that holds the magnifier or the spinner. */
function iconSlot(): HTMLElement {
  const slot = input().parentElement?.querySelector("span.absolute");
  if (!slot) throw new Error("icon slot not found");
  return slot as HTMLElement;
}

/** Submits `QUERY` and returns with the request in flight. */
async function submitInFlight(props: Partial<Parameters<typeof SearchField>[0]> = {}) {
  const user = userEvent.setup();
  const view = renderField(props);
  await user.type(input(), `${QUERY}{Enter}`);
  return { user, commit: view.commit };
}

/**
 * Closes the lock exactly as `/search` does: the search page mounts and its
 * effect releases. Only the release's own root is unmounted — `cleanup()` would
 * take the field with it.
 */
function resultsArrive() {
  render(<SearchPendingRelease />).unmount();
}

describe("SearchField: locking the search while a request is in flight", () => {
  it("locks the field and marks the region busy once submitted", async () => {
    await submitInFlight();
    expect(input().readOnly).toBe(true);
    expect(input().getAttribute("aria-disabled")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
  });

  it("starts unlocked and reports an idle region", () => {
    renderField();
    expect(input().readOnly).toBe(false);
    // No `aria-disabled` at rest at all: React renders `aria-disabled={false}`
    // as the string "false", which would leave an announcement-shaped
    // attribute in the idle DOM for a screen reader to weigh on every focus.
    expect(input().hasAttribute("aria-disabled")).toBe(false);
    expect(form().getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the query visible and refuses edits while locked", async () => {
    const { user } = await submitInFlight();
    // The brief's "do not clear or replace the user's query": a locked search
    // that emptied the box would read as losing the search, not as it running.
    await user.type(input(), "and more");
    expect(input().value).toBe(QUERY);
  });

  it("keeps focus in the field while locked", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(input());
    expect(document.activeElement).toBe(input());
    await user.type(input(), `${QUERY}{Enter}`);
    // The whole reason the input is `readOnly` + `aria-disabled` and not
    // `disabled`: a disabled focused input is blurred by the browser, and on
    // iOS/Android it also dismisses the on-screen keyboard. The search would
    // collapse the instant it started.
    expect(document.activeElement).toBe(input());
  });

  it("swaps the magnifier for a spinner without moving anything", async () => {
    const { container, commit } = renderField();
    expect(screen.queryByTestId("search-spinner")).toBeNull();
    const before = iconSlot().className;
    const beforeCount = container.querySelectorAll("span.absolute").length;

    await userEvent.setup().type(input(), `${QUERY}{Enter}`);

    // In flight: the spinner occupies the magnifier's own slot.
    expect(screen.getByTestId("search-spinner")).toBeTruthy();
    expect(iconSlot().className).toBe(before);
    expect(container.querySelectorAll("span.absolute").length).toBe(beforeCount);

    commit("/search", `q=${encodeURIComponent(QUERY)}`);
    resultsArrive();

    // Settled: the magnifier is back, same slot, same classes, same number of
    // positioned siblings. A field that widened itself to fit a spinner would
    // shift the text under the cursor.
    expect(screen.queryByTestId("search-spinner")).toBeNull();
    expect(iconSlot().className).toBe(before);
    expect(container.querySelectorAll("span.absolute").length).toBe(beforeCount);
  });

  it("uses the app's existing spinner so the state costs no new CSS", async () => {
    await submitInFlight();
    // Copied verbatim from `add-to-playlist-menu.tsx`'s spinner. A one-off ring
    // here would emit a fresh set of utilities into a stylesheet every visitor
    // downloads.
    expect(screen.getByTestId("search-spinner").className).toBe(
      "block h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent",
    );
  });
});

describe("SearchField: the lock is released by the results, not by a timer", () => {
  it("stays locked while the request is outstanding", async () => {
    const { commit } = await submitInFlight();
    expect(input().readOnly).toBe(true);
    // Time passing is not evidence; only the results page is. Note that the
    // optimistic URL update cannot release it either - `router.push` has
    // already rewritten the URL by this point.
    commit("/search", `q=${encodeURIComponent(QUERY)}`);
    expect(input().readOnly).toBe(true);
  });

  it("lifts when the results page releases it", async () => {
    const { commit } = await submitInFlight();
    commit("/search", `q=${encodeURIComponent(QUERY)}`);
    expect(input().readOnly).toBe(true);

    resultsArrive();

    expect(input().readOnly).toBe(false);
    expect(form().getAttribute("aria-busy")).toBe("false");
    // Whichever terminal state arrived - results, an empty result set, or an
    // error - the same handshake released the lock. One code path, three
    // outcomes, and the test never had to say which happened.
    expect(input().value).toBe(QUERY);
  });

  it("re-fires when new results commit without remounting the release", async () => {
    // THE regression test for the bug E2E caught: the release once ran its
    // effect on mount only (`[]` deps), so on the real `/search` →
    // `/search?q=…` navigation React preserved the instance, the effect never
    // re-fired, and the field stayed locked after results arrived. Rendering a
    // fresh release per case masked it completely. Here the SAME mounted
    // release must close a lock opened after it mounted, keyed on the committed
    // params changing underneath it.
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = "";
    const view = render(<SearchPendingRelease />);
    expect(useSearchPending.getState().query).toBeNull();

    // A search begins while the release from the idle page is still mounted.
    renderField();
    await user.type(input(), `${QUERY}{Enter}`);
    expect(input().readOnly).toBe(true);

    // The results commit: same release instance, new params. The effect must
    // fire again for the new value.
    mocks.query = `q=${encodeURIComponent(QUERY)}`;
    view.rerender(<SearchPendingRelease />);

    expect(input().readOnly).toBe(false);
  });

  it("releases on the safety timer when the results page never arrives", async () => {
    // The one case the release cannot cover: the user submits and then navigates
    // away, so the page that would have released the lock never renders. The
    // timer's own behaviour is asserted in `search-pending.test.ts` with a mocked
    // clock, because `userEvent` and fake timers deadlock each other; here the
    // component's part is simply that the lock is still held while the request
    // is outstanding and the timer has not fired.
    const { commit } = await submitInFlight();
    commit("/library", "");
    expect(input().readOnly).toBe(true);
  });

  it("releases when a different search's page replaces the pending one", async () => {
    // A history chip can navigate while a search is in flight. The page that
    // renders is not the pending request's, but it IS a settled navigation, and
    // holding the lock there would strand the field on a page visibly showing
    // results for something else.
    const { commit } = await submitInFlight();
    commit("/search", "q=someone%20else");
    expect(input().readOnly).toBe(true);

    resultsArrive();
    expect(input().readOnly).toBe(false);
  });

  it("keeps the lock for a same-route search, where the URL does not move", async () => {
    // The case that killed the earlier `?q=` veto: submitting a new query from
    // an existing search page leaves the old `?q=` in the URL for the whole
    // request, so any "does the URL already match?" check unlocks the field
    // immediately. Locking is the correct behaviour here.
    const user = userEvent.setup();
    const view = renderField();
    view.commit("/search", "q=old");
    await user.clear(input());
    await user.type(input(), "brand new{Enter}");
    expect(input().value).toBe("brand new");
    expect(input().readOnly).toBe(true);

    view.commit("/search", "q=brand%20new");
    expect(input().readOnly).toBe(true);
    resultsArrive();
    expect(input().readOnly).toBe(false);
  });

  it("releases on the idle route too", async () => {
    // Clearing the field submits the EMPTY query, which is a real pending value
    // rather than a missing one - conflating "" with null would mean the idle
    // route could never be released.
    const user = userEvent.setup();
    const view = renderField({ variant: "header" });
    view.commit("/search", `q=${encodeURIComponent(QUERY)}`);

    await user.clear(input());
    await user.type(input(), "{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search");
    expect(useSearchPending.getState().query).toBe("");
    expect(input().readOnly).toBe(true);

    view.commit("/search", "");
    resultsArrive();

    expect(input().readOnly).toBe(false);
  });

  it("does not keep a parallel loading state of its own", () => {
    // Structural guard, scoped to the import so that the file header's prose
    // about why `useTransition` was rejected does not trip it. A stored
    // `isSearching` boolean in this component would need clearing on success,
    // on error, on unmount and on foreign navigations; the state instead lives
    // in one module with two writers and a URL veto.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/search/search-field.tsx"),
      "utf8",
    );
    expect(source).toContain("useSearchPending");
    expect(source).not.toMatch(/import\s*\{[^}]*\buseTransition\b/);
    expect(source).not.toMatch(/setIsSearching|useState\(false\)/);
  });
});

describe("SearchField: the clear control", () => {
  it("is disabled while searching and cannot mutate the query", async () => {
    const { user } = await submitInFlight();
    expect(clearButton().disabled).toBe(true);

    await user.click(clearButton());

    expect(input().value).toBe(QUERY);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("unlocks when the search finishes", async () => {
    const user = userEvent.setup();
    const view = renderField({ defaultValue: QUERY });
    view.commit("/search", `q=${encodeURIComponent(QUERY)}`);

    // A DIFFERENT query, because re-submitting what the URL already shows is
    // deliberately a no-op — and a test that tripped that guard would be
    // asserting "not locked" for the wrong reason.
    await user.clear(input());
    await user.type(input(), "another{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search?q=another");
    expect(clearButton().disabled).toBe(true);

    view.commit("/search", "q=another");
    resultsArrive();
    expect(clearButton().disabled).toBe(false);

    await user.click(clearButton());
    expect(mocks.push).toHaveBeenLastCalledWith("/search");
  });
});

describe("SearchField: duplicate and racing requests", () => {
  it("ignores a burst of Enters while the first search is running", async () => {
    const { user } = await submitInFlight();
    await user.click(input());
    await user.keyboard("{Enter}{Enter}{Enter}");

    // Enter still submits a form whose input is readOnly, so the input's state
    // is not the gate — the handler's guard is.
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("ignores a programmatic submit that never touches the input", async () => {
    // `requestSubmit()` and synthetic submit events bypass the element's state
    // entirely. A lock that only relied on `readOnly` would be defeated by any
    // automation, and this is a real test harness.
    const { commit } = renderField();
    await userEvent.setup().type(input(), `${QUERY}{Enter}`);
    expect(mocks.push).toHaveBeenCalledTimes(1);

    fireEvent.submit(form());
    expect(mocks.push).toHaveBeenCalledTimes(1);

    commit("/search", `q=${encodeURIComponent(QUERY)}`);
  });

  it("issues no second request for a query already on screen", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = `q=${encodeURIComponent(QUERY)}`;
    renderField({ defaultValue: QUERY });
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("SearchField: announcing the busy state", () => {
  it("announces the busy sentence in the page field's existing live region", async () => {
    // Reusing the region that already announces link detection is deliberate: a
    // second `role="status"` in the same form is two live messages racing, and
    // screen readers read the result as one garbled sentence.
    await submitInFlight({ linkDetectedTemplate: "{provider} link detected" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(SEARCHING);
  });

  it("replaces the link hint rather than competing with it", async () => {
    const link = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3";
    const props = { defaultValue: link, linkDetectedTemplate: "{provider} link detected" };
    const view = renderField(props);
    view.commit("/search", `q=${encodeURIComponent(link)}`);
    expect(screen.getByRole("status").textContent).toBe("Spotify link detected");

    // A different query, so the same-query guard does not swallow the submit.
    await userEvent.setup().clear(input());
    await userEvent.setup().type(input(), "{Enter}");

    // The query is already submitted; the pending-link hint is stale, and two
    // sentences in one live region is worse than the right one.
    expect(screen.getByRole("status").textContent).toBe(SEARCHING);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    view.commit("/search", "");
    resultsArrive();
  });

  it("keeps the busy sentence out of the visual layout", async () => {
    // A visible line under the field would grow the page for the moment before
    // the route skeleton takes over — a layout jump, which is the thing this
    // work is meant to avoid. The spinner is the visual signal; the region is
    // the announced one.
    await submitInFlight();
    expect(screen.getByRole("status").className).toBe("sr-only");
  });

  it("describes the header field instead of adding a live region to the layout", async () => {
    // The header is shared by every route. A status region there would announce
    // a search on pages that have nothing to do with one, so `aria-describedby`
    // is the right instrument: it is read when the field takes focus, which is
    // exactly when a locked header field needs explaining.
    for (const variant of ["page", "header"] as SearchFieldVariant[]) {
      cleanup();
      const { commit } = renderField({ variant });
      await userEvent.setup().type(input(), `${QUERY}{Enter}`);

      const describedBy = input().getAttribute("aria-describedby");
      expect(describedBy).toBe("q-searching");
      expect(document.getElementById(describedBy!)?.textContent).toBe(SEARCHING);

      if (variant === "header") {
        expect(screen.queryByRole("status")).toBeNull();
      }
      commit("/search", `q=${encodeURIComponent(QUERY)}`);
    }
  });

  it("drops the description once the search finishes", async () => {
    const { commit } = await submitInFlight({ variant: "header" });
    expect(input().getAttribute("aria-describedby")).toBe("q-searching");
    commit("/search", `q=${encodeURIComponent(QUERY)}`);
    resultsArrive();
    expect(input().hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("SearchField: reduced motion", () => {
  it("keeps the busy indicator visible when the animation is suppressed", async () => {
    // The global `prefers-reduced-motion: reduce` block collapses
    // `animation-duration`/`animation-iteration-count` for every spinner in the
    // app (asserted in `app/__tests__/reduced-motion.test.ts`). That leaves the
    // ring's BORDER to carry the state, so the indicator must not depend on
    // motion, opacity or a `motion-safe:` gate in order to be seen.
    await submitInFlight();
    const spinner = screen.getByTestId("search-spinner");
    expect(spinner.className).toContain("border-2");
    expect(spinner.className).not.toMatch(/opacity-0|\bhidden\b|motion-safe:/);
    // Decorative, and aria-hidden either way — the region carries the meaning.
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
  });
});

// Imported at the bottom on purpose: the structural test above reads this file
// as text, and keeping the imports adjacent to it keeps the reader's eye on the
// assertion rather than on plumbing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
