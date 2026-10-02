// @vitest-environment jsdom
/**
 * The search skeleton is the loading state a submit-driven search actually
 * shows. These assertions hold two properties that matter:
 *
 *   - it is announced as busy, and never pretends to be a result state;
 *   - its blocks match the geometry of the content they stand in for, so the
 *     page does not jump when the real results replace them.
 *
 * The field is deliberately a PLACEHOLDER here, and `loading.tsx` documents why
 * at length: `SearchField` reads `useSearchParams()`, which cannot be
 * server-rendered inside a Suspense fallback, so a "real" field here renders
 * nothing at all. The lock, spinner and `aria-busy` for an in-flight search are
 * delivered by the layout's header field, which this boundary never unmounts.
 * `e2e/search-loading.spec.ts` asserts that against a real browser.
 *
 * Geometry is asserted by comparing the two SOURCES rather than the two rendered
 * trees, because the property is that the skeleton and the results keep the same
 * geometry STRINGS as the page evolves. A rendered comparison would need both
 * trees mounted with real data, and would silently stop testing anything the
 * moment a class name changed in both files at once.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import SearchLoading from "@/app/(app)/search/loading";

describe("SearchLoading skeleton", () => {
  it("announces the busy loading state", () => {
    const { container } = render(<SearchLoading />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("renders skeleton blocks, not a generic spinner", () => {
    const { container } = render(<SearchLoading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("disables the shimmer under prefers-reduced-motion", () => {
    const { container } = render(<SearchLoading />);
    const first = container.querySelector(".animate-pulse");
    expect(first?.className).toContain("motion-reduce:animate-none");
  });

  it("shows no result, empty or error state while loading", () => {
    const { container } = render(<SearchLoading />);
    // The skeleton is decorative only: it must never render a headline,
    // "no results" copy, or an error surface.
    expect(container.querySelector("h1, h2, h3")).toBeNull();
    // The placeholder field carries no text at all: no label, no value, no
    // "searching" copy that a screen reader would read out of context.
    expect(container.textContent).toBe("");
  });

  it("does not render an interactive control", () => {
    // Nothing in the placeholder may be focusable or announce itself as a
    // field. A grey box shaped like an input but wired to nothing is worse
    // than a plain block: it takes a tab stop and answers to "searchbox".
    const { container } = render(<SearchLoading />);
    expect(container.querySelector("input, button, select, textarea")).toBeNull();
    expect(container.querySelector('[role="search"]')).toBeNull();
  });
});

/**
 * Skeleton fidelity: a placeholder that does not match the content it stands in
 * for is worse than none, because it promises a layout and then breaks it.
 */
describe("SearchLoading fidelity to the result layout", () => {
  const loading = readFileSync(
    resolve(process.cwd(), "src/app/(app)/search/loading.tsx"),
    "utf8",
  );
  const page = readFileSync(
    resolve(process.cwd(), "src/app/(app)/search/page.tsx"),
    "utf8",
  );

  it("reuses the page's outer spacing so the page height does not jump", () => {
    // Both must open with the same vertical rhythm. If the skeleton's gaps
    // differ from the results', every section below the fold shifts once.
    expect(loading).toContain('className="flex flex-col gap-8"');
    expect(page).toContain('className="flex flex-col gap-8"');
    expect(loading).toContain('className="flex flex-col gap-10"');
    expect(page).toContain('className="flex flex-col gap-10"');
  });

  it("reuses the results grid's breakpoints", () => {
    // Artists and albums sit in one responsive grid each; a skeleton on
    // different breakpoints reflows the moment real cards arrive.
    const grid = "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4";
    expect(loading).toContain(grid);
    expect(page).toContain(grid);
  });

  it("reuses the track container and section headings' geometry", () => {
    expect(loading).toContain("rounded-2xl border border-border-subtle bg-surface-1/60 p-2");
    expect(page).toContain("rounded-2xl border border-border-subtle bg-surface-1/60 p-2");
    // Section headings are `t-section-title mb-3`; the skeleton stands in for
    // the heading itself, so it carries the same bottom margin.
    expect(page).toContain("t-section-title mb-3");
    expect(loading).toContain("mb-3 h-5 w-24");
  });

  it("reuses the top-result card's geometry", () => {
    // The one result surface that was previously unpinned: the card's padding
    // is what decides the height of the first section on the page, so a
    // placeholder that guesses it moves everything below the fold.
    const card = "rounded-2xl border border-border-subtle bg-surface-1 p-4 sm:p-5";
    expect(loading).toContain(card);
    const topResult = readFileSync(
      resolve(process.cwd(), "src/app/(app)/search/top-result-card.tsx"),
      "utf8",
    );
    expect(topResult).toContain(card);
  });

  it("reuses the page field's geometry, including its height", () => {
    // The field's real geometry lives in the shared field component, not in the
    // page — which is exactly why the skeleton has to be checked against
    // `search-field.tsx` rather than against whatever the page happens to wrap
    // it in.
    const field = readFileSync(
      resolve(process.cwd(), "src/components/search/search-field.tsx"),
      "utf8",
    );
    expect(loading).toContain("h-13 w-full max-w-2xl rounded-2xl");
    expect(field).toContain("h-13");
    expect(field).toContain("w-full max-w-2xl");
    // `h-13` is the page field's real height; a placeholder of a different
    // height is the single most visible jump on the page.
    expect(loading).toContain("h-13");
  });

  it("stays synchronous so the skeleton paints before anything is awaited", () => {
    // A locale lookup here would resolve through the session, so the fallback
    // could not paint a single block until that round trip returned - the
    // skeleton would arrive after the wait it exists to cover.
    expect(loading).not.toMatch(/export default async function/);
    expect(loading).not.toContain("getRequestLocale");
  });

  it("stands in for each result section exactly once", () => {
    // The brief's "do not create duplicate result lists underneath the
    // skeleton": one track block, one artist grid, one album grid.
    const { container } = render(<SearchLoading />);
    expect(container.querySelectorAll("ul")).toHaveLength(2);
    expect(
      container.querySelectorAll(
        ".rounded-2xl.border.border-border-subtle.bg-surface-1\\/60",
      ),
    ).toHaveLength(1);
  });

  it("keeps the track artwork square and the row count plausible", () => {
    // h-11/w-11 art is what the real list occupies; a 3-row skeleton makes the
    // page jump upward when the results land.
    const { container } = render(<SearchLoading />);
    expect(container.querySelectorAll(".h-11.w-11").length).toBeGreaterThanOrEqual(5);
    expect(container.querySelectorAll(".h-20.w-20")).toHaveLength(1);
  });

  it("uses the shared glass skeleton rather than an opaque block", () => {
    // `Skeleton` owns the glass treatment and the reduced-motion contract; the
    // loading boundary must go through it rather than hand-rolling a grey box,
    // or Glass Mode silently stops applying to loading states.
    const skeleton = readFileSync(
      resolve(process.cwd(), "src/components/ui/skeleton.tsx"),
      "utf8",
    );
    expect(skeleton).toContain("glass-skeleton");
    expect(skeleton).toContain("motion-reduce:animate-none");
    // Every block on this page comes from the one primitive.
    expect(loading).toContain('from "@/components/ui/skeleton"');
    expect(loading).not.toMatch(/bg-(gray|neutral|slate|zinc)-\d/);
  });
});