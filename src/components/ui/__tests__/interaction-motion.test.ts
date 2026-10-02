// @vitest-environment node
/**
 * Structural guards for interaction motion.
 *
 * The defects this file pins are all "the animation lies about the cost":
 * a layout property in a loop, a missing press state on touch, a menu row
 * with no acknowledgement at all. Durations and easings already live on
 * tokens; these assert the properties being animated and the states that
 * must exist.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");

function readSource(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

const MENU_ROW_FILES = [
  "components/tracks/track-action-menu.tsx",
  "components/player/queue-panel.tsx",
  "components/tracks/add-to-playlist-menu.tsx",
  "components/i18n/locale-switcher.tsx",
];

describe("compositor-friendly loops", () => {
  it("animates the playing bars with scaleY, never height", () => {
    // An infinite loop on a layout property is per-frame layout work for as
    // long as anything plays. `scaleY` from a bottom origin renders the same
    // grow-from-the-baseline motion through the compositor alone.
    const keyframes = css.match(/@keyframes aurora-playing-bars\s*\{[\s\S]*?\n\}/);
    expect(keyframes).not.toBeNull();
    expect(keyframes![0]).toContain("scaleY");
    expect(keyframes![0]).not.toMatch(/(^|\s)height\s*:/);
  });

  it("parks the playing bars statically under reduced motion", () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.playing-bar\s*\{[^}]*transform:\s*scaleY\(0\.6\)/,
    );
  });

  it("keeps press feedback motion-safe at the primitive", () => {
    // Every `Button` compresses on press through the shared class, which is
    // declared inside the stylesheet's `no-preference` block: reduced-motion
    // visitors get the instant colour change, never the scale.
    expect(readSource("components/ui/button.tsx")).toContain("aurora-press");
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\.aurora-press:active\s*\{[^}]*transform:\s*scale\(0\.98\)/,
    );
  });
});

describe("menu press states", () => {
  it("gives every menu row an active fill", () => {
    // `:active` is the touch equivalent of `:hover` - on a phone there is no
    // hover to fall back on, so a row without one gives no acknowledgement
    // at all. The fill is one step firmer than the hover, never opaque.
    for (const file of MENU_ROW_FILES) {
      const source = readSource(file);
      const rows = source.match(/role="menuitem[^"]*"[\s\S]{0,400}?className="([^"]*)"/g) ?? [];
      expect(rows.length, `${file} has no menu rows`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row, `${file} menu row without :active`).toContain("active:bg-");
      }
    }
  });
});

describe("loading swap stability", () => {
  it("keeps the play/pause box fixed across icon and spinner", () => {
    // A loading swap that changes size shoves its neighbours on every track
    // change. The spinner and both icons live in the same fixed box; only the
    // glyph (20px vs 22px) varies, which moves nothing.
    const source = readSource("components/ui/player-controls.tsx");
    expect(source).toMatch(/className=\{primary \? "h-12 w-12 aurora-press" : "h-11 w-11 aurora-press"\}/);
  });
});
