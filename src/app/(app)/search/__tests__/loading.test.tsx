// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import SearchLoading from "@/app/(app)/search/loading";

/**
 * The search skeleton is the loading state a submit-driven search actually
 * shows. These assertions hold the two properties that matter: it is announced
 * as busy, and it never pretends to be a result state (no empty/error copy can
 * appear while results are still loading).
 */
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
    expect(container.textContent).toBe("");
  });
});
