// @vitest-environment node
/**
 * Structural guards for glass STATE consistency (hover/active/focus/disabled/
 * loading).
 *
 * The defects this file pins share one shape: a component that is translucent
 * at rest and opaque the moment it is touched. They are properties of the
 * stylesheet and the class lists together, so they are asserted at the
 * source, in the same style as the layering and scrollbar gates.
 *
 * The mechanism under test: in Glass Mode the six surface tokens are
 * redefined as translucent lifts (`globals.css`, scoped to
 * `[data-aurora-glass="on"]`), so every existing `hover:bg-surface-*` and
 * `bg-surface-*` call site stays glass without any class changing - and with
 * the attribute absent none of it is parsed, which is what keeps Glass Mode
 * off pixel-identical to the pre-glass rendering.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
const skeleton = readFileSync(
  join(SRC, "components", "ui", "skeleton.tsx"),
  "utf8",
);
const button = readFileSync(
  join(SRC, "components", "ui", "button.tsx"),
  "utf8",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!full.includes("__tests__")) {
        walk(full, out);
      }
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `className="..."` literal in a component file. */
function classLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /className="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(m[1]);
  }
  return out;
}

const SURFACE_TOKENS = [
  "--surface-base",
  "--surface-raised",
  "--surface-overlay",
  "--surface-elevated",
  "--surface-hover",
  "--surface-active",
];

describe("glass interaction surfaces", () => {
  it("redefines the surface tokens as translucent lifts in Glass Mode", () => {
    // The block is what turns thirty opaque call sites glass at once; a
    // seventh token here would need its own reason written beside it.
    for (const token of SURFACE_TOKENS) {
      expect(css).toMatch(
        new RegExp(
          `\\[data-aurora-glass="on"\\]\\s*\\{[\\s\\S]*?${token}:\\s*color-mix\\(in oklab, var\\(--p-neutral-\\d\\) [\\d.]+%, transparent\\)`,
        ),
      );
    }
  });

  it("leaves the opaque-by-design surfaces alone", () => {
    // The full player is an intentional opaque takeover, accent buttons are
    // solid by design, canvas tokens are the page itself, and the selected
    // token has no call site. None of them may be redefined in a glass block.
    const blocks = (
      css.match(/\[data-aurora-glass="on"\]\s*\{([\s\S]*?)\n\}/g) ?? []
    ).join("\n");
    for (const forbidden of [
      "--canvas-base",
      "--canvas-raised",
      "--surface-selected",
    ]) {
      expect(blocks).not.toContain(forbidden);
    }
    expect(blocks).not.toMatch(/--accent\s*:/);
  });
});

describe("glass skeleton", () => {
  it("renders the skeleton through the glass primitive", () => {
    expect(skeleton).toContain("glass-skeleton");
  });

  it("keeps the legacy pulse for Glass Mode off", () => {
    // Off-mode rendering is exactly the pre-glass skeleton: opaque fill plus
    // pulse. The glass rule removes the pulse only under the attribute.
    expect(skeleton).toContain("animate-pulse");
    expect(css).toMatch(
      /\[data-aurora-glass="on"\] \.glass-skeleton\s*\{[^}]*animation:\s*none/,
    );
  });

  it("gives the skeleton a translucent fill and hairline in Glass Mode", () => {
    expect(css).toMatch(
      /\[data-aurora-glass="on"\] \.glass-skeleton\s*\{[^}]*background-color:\s*color-mix\([^}]*transparent\)/,
    );
    expect(css).toMatch(
      /\[data-aurora-glass="on"\] \.glass-skeleton\s*\{[^}]*border-color:\s*var\(--glass-border-subtle\)/,
    );
  });

  it("sweeps a low-contrast highlight, never a white flash", () => {
    // 8% white over ~3s: light moving across glass, not a loading bar.
    expect(css).toContain("@keyframes glass-shimmer");
    expect(css).toContain("oklch(1 0 0 / 0.08)");
  });

  it("gates the sweep on no-preference", () => {
    // Reduced motion gets a static translucent block. The blanket rule at
    // the end of the stylesheet would collapse the animation anyway; gating
    // the declaration as well means it is never even parsed for those users.
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\.glass-skeleton::after\s*\{[\s\S]*?animation:\s*glass-shimmer/,
    );
  });

  it("gives the skeleton no backdrop-filter of its own", () => {
    // A track list paints twenty of these; a per-block blur would be twenty
    // backdrop copies, which is the nested-blur cost pattern the system
    // forbids. Translucency plus the sweep reads as glass without it.
    const chunks = css.split(".glass-skeleton");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      const rule = chunk.slice(0, chunk.indexOf("}"));
      expect(rule).not.toMatch(/backdrop-filter\s*:/);
    }
  });
});

describe("glass control states", () => {
  it("dims disabled buttons instead of flattening them", () => {
    // A refused interaction must not keep claiming full strength, and the
    // dim is opacity only - no solid fill swap, so a disabled control on
    // glass stays glass.
    expect(button).toContain("disabled:opacity-60");
  });

  it("keeps a visible global focus ring", () => {
    // Focus over wallpaper, dark glass, light glass and gradients alike:
    // the accent outline is the one focus treatment, and it survives every
    // surface because it is drawn around the control, never as its fill.
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/,
    );
  });

  it("applies no component-level backdrop blur", () => {
    // The blur budget is three system layers, never nested: chrome, floating
    // panels, and the dialog scrim. A `backdrop-blur-*` utility in a
    // component would be a fourth layer (or a nested one), so the only one
    // allowed is the scrim's own.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const literal of classLiterals(source)) {
        for (const hit of literal.match(/backdrop-blur-[a-z0-9]+/g) ?? []) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${hit}`);
        }
      }
    }
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("dialog.tsx");
  });

  it("paints no opaque black or white outside scrims and artwork", () => {
    // `bg-black/*` is legitimate exactly three times: the two modal scrims
    // and the playing indicator over artwork. Anything else would be an
    // opaque block intruding on the wallpaper.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const literal of classLiterals(source)) {
        for (const hit of literal.match(/bg-(?:black|white)(?:\/\d+)?/g) ?? []) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${hit}`);
        }
      }
    }
    expect(offenders).toHaveLength(3);
    expect(offenders.some((o) => o.includes("dialog.tsx"))).toBe(true);
    expect(offenders.some((o) => o.includes("queue-panel.tsx"))).toBe(true);
    expect(offenders.some((o) => o.includes("track-row.tsx"))).toBe(true);
  });
});
