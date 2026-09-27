/**
 * Scrollbar-system contract (Phase 56).
 *
 * A scrollbar is the only part of this application the browser paints, and
 * that single fact drives every assertion below. It is also why the whole
 * system is forty lines of CSS with no component behind it: the platform
 * already draws a scrollbar, already responds to hover, already drags,
 * already answers the keyboard, and already gets touch right. Anything built
 * on top of that would be a worse version of it, and §15 and §18 both say not
 * to.
 *
 * The decisions worth protecting are therefore not "does it look right" -
 * nothing in a test can see that - but the ones that are invisible in a
 * screenshot and load-bearing everywhere:
 *
 *   1. The system is declared ONLY where a scrollbar can be hovered. Styling
 *      `::-webkit-scrollbar` switches Chromium out of overlay scrollbars into
 *      classic ones, and that cannot be undone, so a touch device that is
 *      styled anyway keeps a permanent 10px gutter forever.
 *   2. `scrollbar-gutter` is a layout reservation, applied once, to the root,
 *      and it is inside that same gate. Sprinkled across containers it is a
 *      bug; on the root it is the fix for a measured 10px reflow.
 *   3. The thumb has three states and every one of them is token-driven. A
 *      literal in a scrollbar rule is a second colour system.
 *   4. Glass Mode re-declares the thumb COLOURS, not just the alphas, because
 *      custom-property substitution happens at the declaration site. This is
 *      the subtlest thing in the change and the easiest to break by editing
 *      what looks like the right line.
 *   5. No JavaScript. No scroll listeners, no rAF loop, no observers, no
 *      React state on scroll. The single named exception is an anchored menu
 *      that has to be told its row scrolled away - see
 *      `SCROLL_LISTENER_ALLOWANCE`.
 *   6. Scrolling and selecting are separate concerns: no scroll container may
 *      carry `select-none`, and no scroll container may claim `cursor: grab`.
 *   7. The scroll-container inventory is closed. A new one is a decision, not
 *      an accident.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const GLOBALS_PATH = resolve(ROOT, "src/app/globals.css");
const RAW = readFileSync(GLOBALS_PATH, "utf-8");

/** Comments stripped. The file documents its own conventions in prose, and
 *  that prose is full of backticked selectors that are not declarations. */
const GLOBALS = RAW.replace(/\/\*[\s\S]*?\*\//g, " ");

interface StyleRule {
  /** The rule's own selector, verbatim. */
  selector: string;
  /** Enclosing at-rule preludes, outermost first. */
  atRules: string[];
  /** The declaration block, without the braces. */
  body: string;
}

/**
 * Every style rule in the file, with the at-rules it sits inside.
 *
 * The nesting matters as much as the selector. `::-webkit-scrollbar` written
 * inside `@media (any-hover: hover)` and the same selector written at the top
 * level are different programs with opposite effects on a phone, and no amount
 * of reading the selector alone will tell them apart.
 */
function styleRules(): StyleRule[] {
  const out: StyleRule[] = [];

  // Recursive rather than iterative because nesting is the whole point: a
  // `::-webkit-scrollbar` inside `@media (any-hover: hover)` and the same
  // selector at the top level are different programs with opposite effects on
  // a phone, and the at-rule chain is the only thing that tells them apart.
  const parseBlock = (body: string, atRules: string[]): void => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i);
      if (open === -1) return;
      const prelude = body.slice(i, open).trim();
      if (!prelude) {
        i = open + 1;
        continue;
      }

      // Walk to the matching close brace so a nested block is consumed whole.
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = body.slice(open + 1, j - 1);

      if (prelude.startsWith("@")) {
        // `@media`/`@supports`/`@layer` wrap style rules. `@keyframes` and
        // `@font-face` hold declarations directly and enclose nothing, so they
        // are stepped over rather than entered.
        if (!/^@(keyframes|font-face|page)\b/.test(prelude)) {
          parseBlock(inner, [...atRules, prelude]);
        }
      } else {
        out.push({ selector: prelude, atRules, body: inner });
      }
      i = j;
    }
  };

  parseBlock(GLOBALS, []);
  return out;
}

const RULES = styleRules();

/** Rules whose selector mentions a scrollbar pseudo-element or property. */
function scrollbarRules(): StyleRule[] {
  return RULES.filter(
    (r) =>
      r.selector.includes("scrollbar") ||
      /\b(scrollbar-width|scrollbar-color|scrollbar-gutter)\s*:/.test(r.body),
  );
}

/** True when the rule is inside a media query whose prelude contains `query`. */
function insideMedia(rule: StyleRule, query: string): boolean {
  return rule.atRules.some((a) => a.startsWith("@media") && a.includes(query));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const COMPONENT_FILES = [
  ...walk(resolve(ROOT, "src/components")),
  ...walk(resolve(ROOT, "src/app")),
].filter((f) => !f.includes(`${join("__tests__")}`) && !/\.test\.tsx?$/.test(f));

/** Repo-relative, forward-slashed, so an expectation reads the same on
 *  Windows and on CI. */
const rel = (file: string) => file.replace(`${ROOT}\\`, "").split("\\").join("/");

/** Every className string in a component file. */
function classNames(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const out: string[] = [];
  const patterns = [
    /className="([^"]*)"/g,
    /className=\{`([^`]*)`\}/g,
    /className=\{([^}]*)\}/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) out.push(m[1]);
  }
  return out;
}

const SCROLL_UTILITIES = [
  "overflow-y-auto",
  "overflow-x-auto",
  "overflow-auto",
  "overflow-y-scroll",
  "overflow-x-scroll",
  "overflow-scroll",
];

/**
 * The one place a component may register a scroll listener, and how many.
 *
 * The rule above is about the SCROLLBAR: nothing may restyle, measure or
 * re-render on scroll, because the platform already does all of it. An
 * anchored overlay is the one case that is not about the scrollbar at all and
 * still needs the event. A menu whose trigger lives inside a scroll
 * container but whose surface has to be painted OUTSIDE that container -
 * because the container clips it - is positioned from the trigger's
 * coordinates, and those coordinates are stale the moment the list scrolls.
 * Left alone the surface stays where it was, floating over rows it no longer
 * belongs to, which is the detached menu this listener exists to prevent.
 *
 * What makes it acceptable is everything the rule is actually protecting
 * against: it registers only while the menu is open, it removes itself when
 * the menu closes, and it neither measures nor re-renders per frame - it
 * closes the menu, once, and that is the end of it. The count is capped at
 * one per file so a second listener cannot hide behind the first.
 */
const SCROLL_LISTENER_ALLOWANCE = new Map<string, number>([
  ["src/components/player/queue-panel.tsx", 1],
]);

describe("scrollbar system", () => {
  it("declares the whole system only where a scrollbar can be hovered", () => {
    // §14 and §28. Styling `::-webkit-scrollbar` at all opts Chromium and
    // WebKit out of their native OVERLAY scrollbar and into a CLASSIC one: a
    // permanent gutter, and a bar that never auto-hides. On a 360px phone
    // that is 10px of viewport gone and a bar the user cannot dismiss.
    //
    // There is no declaration that undoes it, so "style it, then turn it off
    // for touch" is not a plan that exists. The query has to gate the
    // DECLARATION. `any-hover: hover` is true exactly when a hover-capable
    // pointer is present, so a mouse or trackpad gets the Aurora scrollbar and
    // a finger keeps the one the phone's manufacturer tuned for the phone.
    const ungated = scrollbarRules().filter(
      (r) => !insideMedia(r, "any-hover: hover"),
    );

    expect(
      ungated.map((r) => `${r.selector} @ ${r.atRules.join(" > ") || "(top level)"}`),
      "an ungated scrollbar override permanently opts touch devices out of overlay scrollbars",
    ).toEqual([]);
  });

  it("keeps the layout reservation inside the same gate, and only on the root", () => {
    // §12. `scrollbar-gutter` reserves inline space, so on a platform whose
    // scrollbars overlay it would be a phantom strip down every page. It is
    // part of the scrollbar system and switches with it.
    //
    // And it is on `html` alone. `dialog.tsx` locks the page with
    // `body { overflow: hidden }`, which removes the page scrollbar; measured
    // in a real browser, that widened every element on screen by the full
    // gutter - `<main>` went 990px to 1000px on open and back on close, so
    // opening a dialog reflowed the page behind it. `stable` on the root
    // reserves the gutter whenever a scrollbar can appear, and the same
    // measurement after the change is 0px.
    const gutterRules = scrollbarRules().filter((r) =>
      /scrollbar-gutter\s*:/.test(r.body),
    );

    expect(gutterRules).toHaveLength(1);
    expect(gutterRules[0].selector.trim()).toBe("html");
    expect(gutterRules[0].body).toMatch(/scrollbar-gutter:\s*stable/);
    expect(insideMedia(gutterRules[0], "any-hover: hover")).toBe(true);
  });

  it("gives the thumb three states and drives all of them from tokens", () => {
    // §7: idle must be quiet but findable, hover stronger, dragging
    // strongest. A single flat thumb - which is what this replaced - is
    // visible at rest and carries no information, because it looks identical
    // when grabbed.
    const thumb = scrollbarRules().filter((r) =>
      r.selector.includes("::-webkit-scrollbar-thumb"),
    );
    const selectors = thumb.map((r) => r.selector);

    expect(selectors.some((s) => s.includes(":hover"))).toBe(true);
    expect(selectors.some((s) => s.includes(":active"))).toBe(true);

    // The four roles §3 names, each consumed by a rule rather than inlined.
    for (const token of [
      "var(--scrollbar-thumb)",
      "var(--scrollbar-thumb-hover)",
      "var(--scrollbar-thumb-active)",
      "var(--scrollbar-track)",
      "var(--scrollbar-size)",
      "var(--scrollbar-radius)",
    ]) {
      expect(GLOBALS, `${token} is declared but never used`).toContain(token);
    }

    // Firefox. `scrollbar-width` is the platform's own compact size, so the
    // 6-8px target is expressed through contrast there, and Firefox exposes
    // no hover or active state for `scrollbar-color` - documented, not worked
    // around, because a JS hover detector for a cosmetic property would cost
    // far more than the missing step.
    expect(GLOBALS).toMatch(/scrollbar-width:\s*thin/);
    expect(GLOBALS).toMatch(/scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)/);
  });

  it("keeps the scrollbar rules free of raw values", () => {
    // §27. A `rgba(...)`, a hex, or a bare `6px` in a scrollbar rule is the
    // moment the system stops being a system: the next surface copies the
    // literal and the two drift. Every measured value is a token, and the
    // tokens are the only place a number is allowed.
    //
    // CSS keywords are not raw values. `thin`, `none`, `transparent` and
    // `content-box` are names the platform defines, not numbers this file
    // chose, and there is no token that could hold them.
    const KEYWORDS =
      /^(thin|none|transparent|content-box|padding-box|border-box|auto|initial|stable|both)$/;
    const offenders: string[] = [];

    for (const rule of scrollbarRules()) {
      for (const line of rule.body.split(";")) {
        const decl = line.trim();
        if (!decl) continue;
        const value = decl.slice(decl.indexOf(":") + 1).trim();
        if (value === "" || KEYWORDS.test(value)) continue;
        // A var(), a calc() over vars, or a `none`/`display` toggle is fine.
        if (value === "none") continue;
        if (!/^(width|height|color|background|background-color|border|border-width|border-radius|scrollbar-color|scrollbar-width|scrollbar-gutter|transition)\b/.test(decl)) {
          continue;
        }
        if (/var\(/.test(value)) continue;
        offenders.push(`${rule.selector} -> ${decl}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("re-declares the thumb colours in Glass Mode, not only the alphas", () => {
    // The subtlest thing in this change. A custom property's `var()` references
    // are substituted where the property is DECLARED, not where it is used.
    // `--scrollbar-thumb` on `:root` is therefore already a finished
    // `color-mix(...)` computed with the base alpha, and overriding
    // `--scrollbar-opacity` on a descendant cannot retroactively re-substitute
    // the value that descendant inherited. Flip the alphas alone and Glass Mode
    // silently keeps the flat-canvas thumb - which is precisely the surface
    // where §7's findability floor is closest to being missed.
    const glassBlock = RULES.filter((r) =>
      r.selector.includes('data-aurora-glass="on"'),
    );
    const declaring = glassBlock.filter((r) => /--scrollbar-thumb/.test(r.body));

    expect(declaring, "Glass Mode must re-declare the thumb colours").not.toEqual([]);
    const glassBody = declaring.map((r) => r.body).join("\n");
    for (const name of [
      "--scrollbar-thumb",
      "--scrollbar-thumb-hover",
      "--scrollbar-thumb-active",
      "--scrollbar-opacity",
      "--scrollbar-hover-opacity",
      "--scrollbar-active-opacity",
    ]) {
      expect(glassBody, `${name} is not re-declared for glass`).toMatch(
        new RegExp(`${name}\\s*:`),
      );
    }

    // And the glass alphas must actually be lifted, or the override is a
    // second copy of the same values.
    const base = /:root\s*\{([\s\S]*?)\n\}/.exec(GLOBALS)?.[1] ?? "";
    const baseOpacity = /--scrollbar-opacity:\s*([\d.]+%)/.exec(base)?.[1];
    const glassOpacity = /--scrollbar-opacity:\s*([\d.]+%)/.exec(glassBody)?.[1];
    expect(baseOpacity).toBeDefined();
    expect(glassOpacity).toBeDefined();
    expect(
      parseFloat(glassOpacity as string),
      "glass must lift the floor, not restate it",
    ).toBeGreaterThan(parseFloat(baseOpacity as string));
  });

  it("switches the thumb transition off under reduced motion", () => {
    // §17. It cannot lean on the global `prefers-reduced-motion` safety net at
    // the end of globals.css, because that net is `*, ::before, ::after` and
    // none of those match a scrollbar pseudo-element. A transition declared on
    // `::-webkit-scrollbar-thumb` has to be gated here or not at all.
    const transitions = scrollbarRules().filter((r) => /\btransition\s*:/.test(r.body));

    expect(transitions.length).toBeGreaterThan(0);
    for (const rule of transitions) {
      expect(
        insideMedia(rule, "prefers-reduced-motion: no-preference"),
        "a scrollbar transition outside no-preference runs for a user who asked for none",
      ).toBe(true);
    }

    // Only `background-color` may be transitioned. `border-width` is a layout
    // property: animating the 1px hover swell would run a layout pass on every
    // hover frame of every scrollbar in the app to produce a two-pixel
    // cosmetic difference (§16, §33). Colour alone gives the whole perceptual
    // effect and nothing to reflow.
    for (const rule of transitions) {
      const value = /transition:\s*([^;]+)/.exec(rule.body)?.[1] ?? "";
      const properties = value
        .replace(/var\([^)]*\)/g, "")
        .split(",")
        .map((p) => p.trim().split(/\s/)[0])
        .filter(Boolean);
      expect(properties).toEqual(["background-color"]);
    }
  });

  it("suppresses the stepper buttons and the corner", () => {
    // §4. Styling a WebKit scrollbar opts into a CLASSIC scrollbar, and a
    // classic scrollbar draws arrow buttons at both ends of each axis unless
    // they are suppressed. This file declared `::-webkit-scrollbar` with no
    // such rule, so the browser's default arrows were part of the scrollbar
    // the design was trying to make invisible. The corner is the square where
    // two tracks meet; on a transparent track it reads as a stray block of
    // colour in the corner of a panel.
    expect(GLOBALS).toMatch(
      /::-webkit-scrollbar-button\s*\{\s*display:\s*none;\s*\}/,
    );
    expect(GLOBALS).toMatch(
      /::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;\s*\}/,
    );
  });

  it("keeps scrolling and selecting separate", () => {
    // §19. A scroll container holds content the user came to read. Applying
    // `select-none` because an element happens to scroll is the two concerns
    // being confused, and it is the exact mistake the selection policy exists
    // to prevent one layer over.
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      for (const value of classNames(file)) {
        const tokens = value.split(/\s+/);
        if (!tokens.some((t) => SCROLL_UTILITIES.includes(t))) continue;
        if (tokens.includes("select-none")) offenders.push(`${rel(file)}: ${value}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never claims a drag that does not exist", () => {
    // §20. `cursor: grab` on a scroll region claims the whole region is
    // draggable. Aurora has no drag-and-drop - queue and playlist reordering
    // are Move up / Move down buttons - and a scrollbar drag is the platform's
    // own, which should keep platform semantics. A grab cursor on a scroll
    // container is a claim about an interaction that does not exist.
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = readFileSync(file, "utf-8");
      if (/cursor-(grab|grabbing)\b/.test(source)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);

    expect(GLOBALS).not.toMatch(/cursor:\s*grab/);
  });

  it("never disables touch scrolling", () => {
    // §14. `touch-action: none` anywhere would break touch scrolling, and the
    // brief forbids it globally. There is no drag gesture in this application
    // that would need it.
    expect(GLOBALS).not.toMatch(/touch-action:\s*none/);
    for (const file of COMPONENT_FILES) {
      expect(readFileSync(file, "utf-8"), rel(file)).not.toMatch(/touch-action|touch-none/);
    }
  });

  it("adds no JavaScript to the scrollbar", () => {
    // §16 and §33. The platform draws, hovers, drags and keyboard-scrolls a
    // scrollbar for free. A listener that exists only to restyle one is a
    // per-frame cost, a React re-render, or a leak, in exchange for something
    // CSS already did.
    for (const file of COMPONENT_FILES) {
      const source = readFileSync(file, "utf-8");
      const matches = source.match(/addEventListener\(\s*["'`]scroll["'`]/g) ?? [];
      const allowance = SCROLL_LISTENER_ALLOWANCE.get(rel(file)) ?? 0;
      expect(
        matches.length,
        `${rel(file)} registers ${matches.length} scroll listener(s), allowance ${allowance}`,
      ).toBeLessThanOrEqual(allowance);
      expect(source, `${rel(file)} observes scrolling`).not.toMatch(
        /IntersectionObserver|ResizeObserver[\s\S]{0,80}scroll/,
      );
    }
  });

  it("keeps the scroll-container inventory closed and deliberate", () => {
    // §23. There are five places in this application that scroll something
    // other than the page, and each one is a decision with a reason. A sixth
    // is a new nested scroll area, which is a layout change someone should
    // have to write down.
    const scrollers: string[] = [];
    for (const file of COMPONENT_FILES) {
      for (const value of classNames(file)) {
        if (SCROLL_UTILITIES.some((t) => value.split(/\s+/).includes(t))) {
          scrollers.push(rel(file));
          break;
        }
      }
    }

    expect([...new Set(scrollers)].sort()).toEqual([
      "src/components/player/full-player.tsx",
      "src/components/player/queue-panel.tsx",
      "src/components/shell/sidebar.tsx",
      "src/components/tracks/add-to-playlist-menu.tsx",
      "src/components/ui/dialog.tsx",
    ]);
  });

  it("contains the overlay scrollers and leaves the sidebar chained", () => {
    // §11. Containment is per-container and it is not free: applied globally
    // it would break the natural chaining a user expects everywhere else. The
    // split is by ROLE. An overlay stacked above content the user can still
    // see - dialog, sheet, menu - must not scroll that content when the
    // overlay's own content runs out. The sidebar is a sibling of the main
    // column in one scrolling document, so running off its end SHOULD carry
    // on into the page; containing it would make the sidebar feel broken.
    const contained: string[] = [];
    const uncontained: string[] = [];

    for (const file of COMPONENT_FILES) {
      for (const value of classNames(file)) {
        const tokens = value.split(/\s+/);
        if (!SCROLL_UTILITIES.some((t) => tokens.includes(t))) continue;
        (tokens.includes("overscroll-contain") ? contained : uncontained).push(rel(file));
      }
    }

    expect([...new Set(contained)].sort()).toEqual([
      "src/components/player/full-player.tsx",
      "src/components/player/queue-panel.tsx",
      "src/components/tracks/add-to-playlist-menu.tsx",
      "src/components/ui/dialog.tsx",
    ]);
    expect([...new Set(uncontained)]).toEqual(["src/components/shell/sidebar.tsx"]);
  });

  it("never uses overflow-hidden to hide a scrollbar or a layout bug", () => {
    // §24. Every `overflow-hidden` in this codebase is a rounded-corner clip
    // on artwork, a card wash or a menu shell - all of them content-sized, so
    // none of them hides anything. An element that both clips and scrolls is
    // the shape this rule exists to catch.
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      for (const value of classNames(file)) {
        const tokens = value.split(/\s+/);
        if (!tokens.includes("overflow-hidden")) continue;
        if (tokens.some((t) => t.startsWith("overflow-") && t !== "overflow-hidden")) {
          offenders.push(`${rel(file)}: ${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has no page-specific scrollbar variants", () => {
    // §25 and §26. One system, expressed as tokens. A `.queue-scrollbar` or a
    // `.playlist-scrollbar` class is where a shared implementation starts
    // becoming five implementations that agree until one of them is edited.
    // Semantic variation belongs in a token override on a container, which is
    // what `[data-aurora-glass="on"]` does.
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      if (/[a-z-]*scrollbar[a-z-]*/.test(readFileSync(file, "utf-8"))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});
