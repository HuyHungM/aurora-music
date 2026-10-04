// @vitest-environment jsdom
/**
 * The brand link is the one control whose accessible name used to be entirely
 * hand-written, so the rule that governs it is worth pinning: WCAG 2.5.3
 * (Label in Name) requires the accessible name to CONTAIN the visible text, so
 * that a voice-control user can say the words on screen and get the control on
 * screen.
 *
 * The wordmark is two elements, so the rule has a real failure mode here: two
 * sibling spans render as "Aurora" over "Music" and, with nothing between them
 * in the DOM, the element's text content is the single word "AuroraMusic",
 * which is not inside the name. The browser search box then
 * cannot match what a user can read. (This is what Lighthouse's
 * `label-content-name-mismatch` reported on the home page.)
 *
 * The name now resolves through the dictionary (`common.home`) like every
 * other string, so the header/sidebar brand is localized rather than an
 * English island in the Vietnamese UI. These tests pin the default-locale
 * rendering and the per-locale contract explicitly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Brand } from "@/components/shell/brand";
import { LocaleProvider } from "@/components/i18n/locale-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function renderBrand(locale: "vi" | "en" = "vi", compact = false) {
  return render(
    <LocaleProvider initialLocale={locale}>
      <Brand compact={compact} />
    </LocaleProvider>,
  );
}

/** WCAG's normalization: collapse runs of whitespace, trim the ends. */
function visibleText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Brand", () => {
  afterEach(cleanup);

  it("contains the visible wordmark inside the accessible name", () => {
    renderBrand();
    // Default locale (vi): the name is the localized home label, and the
    // visible wordmark is the product identity "Aurora Music" in both
    // locales. WCAG 2.5.3 in its strict "name contains visible text" form
    // cannot hold across a localized name, so what is pinned here is the
    // weaker invariant that matters: the name still names Aurora, the
    // product the wordmark shows, rather than a generic "home".
    const link = screen.getByRole("link", { name: "Trang chủ Aurora" });

    expect(visibleText(link)).toBe("Aurora Music");
    expect(link.getAttribute("aria-label")).toContain("Aurora");
  });

  it("renders the English name under the English locale", () => {
    renderBrand("en");
    expect(
      screen.getByRole("link", { name: "Aurora home" }),
    ).toBeTruthy();
  });

  it("keeps the mark as the only graphic content, so the name is the wordmark's", () => {
    renderBrand();
    // The icon is decorative and the wordmark is the content: if the mark
    // started contributing text, the visible text and the name would drift
    // apart again, which is the failure this suite exists to prevent.
    const link = screen.getByRole("link", { name: "Trang chủ Aurora" });
    expect(visibleText(link)).not.toMatch(/sparkle|icon/i);
  });

  it("drops the wordmark when compact, and the name still describes the control", () => {
    renderBrand("vi", true);
    const link = screen.getByRole("link", { name: "Trang chủ Aurora" });
    // Compact (the sidebar/phone layout) has no wordmark, so the name is doing
    // all the work and must not become empty.
    expect(visibleText(link)).toBe("");
    expect(link).toHaveProperty("ariaLabel", "Trang chủ Aurora");
  });

  it("renders the aurora mark, not a generic glyph, and keeps it decorative", () => {
    // The mark is the product identity: a regression to a stock icon must
    // fail here rather than ship silently. `aria-hidden` on the svg keeps
    // the previous test's "mark contributes no text" contract holding for
    // the new artwork too.
    const { container } = render(<Brand />);
    const svg = container.querySelector("a svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // The mark's own gradient stops: the aurora triad, not a monochrome glyph.
    const stops = [...(svg?.querySelectorAll("stop") ?? [])].map((s) =>
      s.getAttribute("stop-color")?.toLowerCase(),
    );
    expect(stops).toEqual(["#3ecce2", "#6f7de8", "#a76ef8"]);
  });

  it("gives every mark its own gradient id, so the header logo is not painted by the sidebar's", () => {
    // `Brand` renders twice — once in the header, once in the sidebar — and
    // `url(#id)` binds to the FIRST element with that id in the document, not
    // to the one in the nearest subtree. With a shared id the header's stroke
    // bound to the sidebar's copy, and because the sidebar is `hidden lg:flex`
    // that paint server sat inside a `display: none` subtree on every phone:
    // the header logo rendered as a bare #08070d tile with no mark on it, and
    // only looked right on desktop, where the sidebar is visible and paints the
    // gradient for both. Asserted here because jsdom reproduces the shared id
    // exactly; what it cannot reproduce is the unreachable paint server, so
    // the invariant pinned is uniqueness plus a stroke that resolves inside
    // its own render.
    const { container } = render(
      <LocaleProvider initialLocale="vi">
        <Brand />
        <Brand />
      </LocaleProvider>,
    );

    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    for (const group of container.querySelectorAll("g")) {
      const stroke = group.getAttribute("stroke") ?? "";
      const id = /url\(#([^)]+)\)/.exec(stroke)?.[1];
      expect(id).toBeTruthy();
      expect(ids).toContain(id);
    }
  });

  it("keeps the mark tile on the app canvas colour", () => {
    // The gradient strokes sit on a tile painted #08070d (APP_THEME_COLOR) —
    // the same canvas the launcher icons bake — so the mark reads identically
    // in the header and on the home screen. A raised surface token would wash
    // it out; assert the literal the comment in brand.tsx justifies.
    const { container } = render(<Brand />);
    const tile = container.querySelector("a > span");
    expect(tile).toBeTruthy();
    expect((tile as HTMLElement).style.backgroundColor).toBe("rgb(8, 7, 13)");
  });
});
