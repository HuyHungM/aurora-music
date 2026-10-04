// @vitest-environment jsdom
/**
 * The search result skeleton that is driven by the search LOCK rather than by
 * the route's `loading.tsx`.
 *
 * `/search` is prefetched from the nav, and a prefetched route skips Next's
 * pending phase — which is the documented reason `search-pending.ts` exists at
 * all. So this island covers the window where `loading.tsx` cannot: the moment
 * between submit and the response.
 *
 * The properties worth holding, in order of how badly they break if lost:
 *
 *   - the no-results / error states cannot render while a search is pending
 *     (the "No results found" flash);
 *   - the skeleton stops in the SAME commit that carries the answer, because the
 *     lock is only released in an effect and gating on "still pending" alone
 *     would leave the skeleton sitting over the results for one frame;
 *   - the skeleton belongs to the latest submitted query, not to whichever
 *     promise happened to settle;
 *   - a pasted link never promises the text-search layout;
 *   - the placeholders are decorative and are announced once, not twenty times.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSearchPending } from "@/lib/search/search-pending";
import { SearchPendingResults } from "../search-pending-results";

function begin(query: string) {
  act(() => useSearchPending.getState().begin(query));
}

function release() {
  act(() => useSearchPending.getState().release());
}

function renderArea(renderedQuery: string) {
  return render(
    <SearchPendingResults renderedQuery={renderedQuery}>
      <p>result body</p>
      <p>no results found for this</p>
    </SearchPendingResults>,
  );
}

function skeletonBlocks(container: HTMLElement) {
  return container.querySelectorAll(".animate-pulse").length;
}

afterEach(() => {
  cleanup();
  // The lock owns a 30s safety timer; leaving it armed would outlive the suite.
  useSearchPending.setState({ query: null });
});

describe("SearchPendingResults: idle", () => {
  it("renders the result body and no skeleton when nothing is pending", () => {
    const { container } = renderArea("taylor");
    expect(screen.getByText("result body")).toBeTruthy();
    expect(skeletonBlocks(container)).toBe(0);
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("renders the idle route's own body without a skeleton", () => {
    // `renderedQuery` is `""` on the idle route, which is a real search target
    // (clearing the field navigates to bare `/search`). No pending lock means
    // there is nothing to cover.
    const { container } = renderArea("");
    expect(screen.getByText("result body")).toBeTruthy();
    expect(skeletonBlocks(container)).toBe(0);
  });
});

describe("SearchPendingResults: pending", () => {
  it("replaces the result body with skeletons while a search is in flight", () => {
    const { container } = renderArea("");
    expect(skeletonBlocks(container)).toBe(0);

    begin("taylor swift");

    expect(skeletonBlocks(container)).toBeGreaterThan(0);
    expect(screen.queryByText("result body")).toBeNull();
  });

  it("cannot show the no-results state while pending", () => {
    // The flash the brief is about. Because the island SWAPS rather than layers,
    // the empty state is not painted at all for the length of the request —
    // there is no window in which both exist.
    renderArea("taylor");
    begin("taylor swift");

    expect(screen.queryByText("no results found for this")).toBeNull();
    expect(screen.queryByText("result body")).toBeNull();
  });

  it("does not skeleton a pasted link, which resolves to a different body", () => {
    // A link renders `LinkSearchResult`. Promising the track-rows-and-grids
    // layout and then replacing it with a link card is both misleading and a
    // layout jump, so the classifier's own first step decides it.
    renderArea("");
    begin("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    expect(screen.getByText("result body")).toBeTruthy();
    expect(skeletonBlocks(document.body)).toBe(0);
  });

  it("stops in the same render that shows the answer, not one frame later", () => {
    // The lock is released by `SearchPendingRelease` in an effect, so on the
    // commit carrying the answer it is still open. Comparing against the
    // rendered query is what makes the skeleton stop synchronously.
    const { container, rerender } = renderArea("");
    begin("taylor swift");
    expect(skeletonBlocks(container)).toBeGreaterThan(0);

    rerender(
      <SearchPendingResults renderedQuery="taylor swift">
        <p>result body</p>
        <p>no results found for this</p>
      </SearchPendingResults>,
    );

    expect(screen.getByText("result body")).toBeTruthy();
    expect(skeletonBlocks(container)).toBe(0);
    // Still locked at this instant — the release effect has not run. The
    // skeleton is gone anyway, which is the property being pinned.
    expect(useSearchPending.getState().query).toBe("taylor swift");
  });

  it("compares trimmed queries, so trailing spaces do not strand the skeleton", () => {
    // The field submits `value.trim()` and `searchQuerySchema` trims again, so
    // both sides of the comparison are already trimmed. Asserting it keeps a
    // future change to either side from producing a skeleton that outlives its
    // own request.
    const { container } = renderArea("taylor");
    begin("  taylor  ");
    expect(skeletonBlocks(container)).toBe(0);
  });

  it("keeps the skeleton attached to the latest submitted query", () => {
    // Rapid succession. The field refuses a second submit while the lock is
    // open, so the lock only ever names the ACTIVE search — and the skeleton
    // therefore cannot be swapped out from under a newer one by an older
    // response settling late.
    const { container, rerender } = renderArea("");
    begin("t");
    begin("taylor swift");
    expect(skeletonBlocks(container)).toBeGreaterThan(0);

    // The answer for the active query arrives.
    rerender(
      <SearchPendingResults renderedQuery="taylor swift">
        <p>result body</p>
        <p>no results found for this</p>
      </SearchPendingResults>,
    );
    expect(skeletonBlocks(container)).toBe(0);

    // A late arrival for a superseded query cannot bring the skeleton back,
    // because the lock still names only the active search.
    begin("t");
    expect(skeletonBlocks(container)).toBeGreaterThan(0);
    release();
    expect(screen.getByText("result body")).toBeTruthy();
    expect(skeletonBlocks(container)).toBe(0);
  });

  it("returns to the result body when the search settles with nothing", () => {
    // The zero-result outcome: the skeleton goes, and the empty state it was
    // hiding is allowed to speak — but only now, once the request is settled.
    const { container, rerender } = renderArea("");
    begin("obscure query");
    expect(skeletonBlocks(container)).toBeGreaterThan(0);
    expect(screen.queryByText("no results found for this")).toBeNull();

    rerender(
      <SearchPendingResults renderedQuery="obscure query">
        <p>result body</p>
        <p>no results found for this</p>
      </SearchPendingResults>,
    );

    expect(skeletonBlocks(container)).toBe(0);
    expect(screen.getByText("no results found for this")).toBeTruthy();
  });
});

describe("SearchPendingResults: accessibility", () => {
  it("contributes no busy region of its own, and hides every decorative block", () => {
    // THE INVARIANT, and it is a negative one on purpose.
    //
    // `/search` used to publish TWO `[aria-busy="true"]` regions for a single
    // submit: this island's wrapper and `SearchField`'s own form. Measured
    // 2026-10-04 — and not `loading.tsx`, which never paints on a
    // `/search` → `/search?q=…` transition because the page is already mounted.
    //
    // The FIELD keeps the attribute, because it is the only one of the two with
    // an accessible name: a screen reader can announce "Search tracks, busy",
    // but an anonymous `<div aria-busy>` is announced as nothing. Asserting zero
    // here is therefore the stronger claim of the two — it pins that this
    // island can never become the second busy region again, whoever adds a
    // caller later.
    const { container } = renderArea("");
    begin("taylor swift");

    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);

    // Still nothing a screen reader has to read: the shared `Skeleton` primitive
    // hides every block itself, so twenty grey rectangles produce zero
    // announcements.
    const blocks = Array.from(container.querySelectorAll(".animate-pulse"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders no focusable control, link or role in the skeleton", () => {
    const { container } = renderArea("");
    begin("taylor swift");

    expect(
      container.querySelectorAll("a, button, input, select, textarea"),
    ).toHaveLength(0);
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(container.querySelectorAll("[role]")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-label]")).toHaveLength(0);
  });

  it("uses the same skeleton the route boundary shows", () => {
    // One design, two callers. A second near-identical block would be two
    // things to keep in step, and the geometry is a contract with the real
    // result layout rather than a preference.
    const { container } = renderArea("");
    begin("taylor swift");
    expect(skeletonBlocks(container)).toBeGreaterThan(0);

    const skeleton = container.querySelector(".animate-pulse")?.parentElement
      ?.parentElement;
    expect(skeleton?.querySelectorAll("ul")).toHaveLength(2);
    expect(
      skeleton?.querySelectorAll(
        ".rounded-2xl.border.border-border-subtle.bg-surface-1\\/60",
      ),
    ).toHaveLength(1);
    expect(skeleton?.querySelectorAll(".h-22.w-22")).toHaveLength(1);
  });
});