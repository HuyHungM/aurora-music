// @vitest-environment jsdom
/**
 * The brand link is the one control whose accessible name is entirely
 * hand-written, so the rule that governs it is worth pinning: WCAG 2.5.3
 * (Label in Name) requires the accessible name to CONTAIN the visible text, so
 * that a voice-control user can say the words on screen and get the control on
 * screen.
 *
 * The wordmark is two elements, so the rule has a real failure mode here: two
 * sibling spans render as "Aurora" over "Music" and, with nothing between them
 * in the DOM, the element's text content is the single word "AuroraMusic",
 * which is not inside the name "Aurora Music home". The browser search box then
 * cannot match what a user can read. (This is what Lighthouse's
 * `label-content-name-mismatch` reported on the home page.)
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Brand } from "@/components/shell/brand";

/** WCAG's normalization: collapse runs of whitespace, trim the ends. */
function visibleText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Brand", () => {
  afterEach(cleanup);

  it("contains the visible wordmark inside the accessible name", () => {
    render(<Brand />);
    const link = screen.getByRole("link", { name: "Aurora Music home" });

    // The name must contain what the user can read, as words.
    expect(visibleText(link)).toBe("Aurora Music");
    expect("Aurora Music home").toContain(visibleText(link));
  });

  it("keeps the mark as the only graphic content, so the name is the wordmark's", () => {
    render(<Brand />);
    // The icon is decorative and the wordmark is the content: if the mark
    // started contributing text, the visible text and the name would drift
    // apart again, which is the failure this suite exists to prevent.
    const link = screen.getByRole("link", { name: "Aurora Music home" });
    expect(visibleText(link)).not.toMatch(/sparkle|icon/i);
  });

  it("drops the wordmark when compact, and the name still describes the control", () => {
    render(<Brand compact />);
    const link = screen.getByRole("link", { name: "Aurora Music home" });
    // Compact (the sidebar/phone layout) has no wordmark, so the name is doing
    // all the work and must not become empty.
    expect(visibleText(link)).toBe("");
    expect(link).toHaveProperty("ariaLabel", "Aurora Music home");
  });
});
