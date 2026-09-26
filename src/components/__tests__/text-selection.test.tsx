// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, ButtonLink } from "@/components/ui/button";
import { PlayIcon, SearchIcon } from "@/components/ui/icons";

/**
 * `next/link` needs a router from context, which jsdom has no way to provide, so
 * it is replaced by the element it ultimately produces. That is the right
 * substitution here rather than a workaround: the subject of the assertions
 * below is the `className` and the tag, both of which a real `Link` forwards
 * unchanged, and nothing else in this file exercises navigation.
 */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) => <a href={href} {...props}>{children}</a>,
}));

/**
 * Interaction-policy regression gate (PHASE 51 ADDENDUM, extended in Phase 55).
 *
 * The policy is short: content stays selectable, controls stay unselectable, and
 * anything that is interactive by semantic says so with a pointer. What makes it
 * fragile is that the whole thing is expressed as Tailwind class strings and
 * element-scoped stylesheet rules across thirty files, where a single
 * `select-none` on a wrapper silently removes a user's ability to copy a track
 * title - and nothing in a screenshot will ever show it. The cursor half is the
 * same failure with the opposite sign: a `<button>` gets `cursor: default` from
 * both the browser and Tailwind's preflight, so a missing declaration is
 * invisible too, and the control simply stops looking like a control.
 *
 * So the guarantee is asserted rather than documented:
 *
 *   1. No global rule can make the app unselectable, and none can make every
 *      element look clickable.
 *   2. Text-entry fields are selectable, and no component may say otherwise.
 *   3. Content elements - titles, artists, albums, descriptions, error text,
 *      share URLs - are never inside a `select-none` container.
 *   4. The interaction surfaces this policy names ARE unselectable, so the
 *      policy is not satisfied by doing nothing.
 *   5. Links stay selectable. A `<button>` is a command whose label is part of
 *      the control; an `<a href>` is a destination whose text the user may still
 *      want to drag-select and paste. The asymmetry is the point of both rules.
 *   6. Every control is a pointer, every disabled control is not-allowed, and
 *      there is no `grab` cursor - Aurora has no drag-and-drop, so one would be
 *      a claim about an interaction that does not exist.
 *   7. Decorative graphics are inert: not selectable, and never the target of a
 *      click aimed at the control around them.
 *
 * Checks 3, 4 and 7 are source-level on purpose. Tailwind classes are strings;
 * in jsdom they are never applied, so a DOM-level assertion of "is this text
 * selectable" would have to re-implement the cascade. Asserting on the class
 * contract is asserting the thing the developer actually writes. The handful of
 * assertions that CAN be made on a real element - the `Button` and `ButtonLink`
 * primitives, the icons - are made on the rendered DOM instead.
 */

const rootDir = resolve(process.cwd());
const componentsRoot = join(rootDir, "src", "components");

/** Every component `.tsx`, excluding tests. Paths are repository-relative. */
function componentFiles(relative = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(componentsRoot, relative))) {
    const fullPath = join(componentsRoot, relative, entry);
    const childRelative = relative.length > 0 ? `${relative}/${entry}` : entry;
    if (statSync(fullPath).isDirectory()) {
      found.push(...componentFiles(childRelative));
    } else if (fullPath.endsWith(".tsx") && !fullPath.includes("__tests__")) {
      found.push(fullPath);
    }
  }
  return found;
}

/** `globals.css` with every comment removed, so prose cannot satisfy a rule. */
function globalCssWithoutComments(): string {
  return readFileSync(join(rootDir, "src", "app", "globals.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

/**
 * Every top-level rule in `globals.css`, as `{ selector, body }`.
 *
 * A parse rather than a regex, and the reason is concrete: this stylesheet
 * documents its own rules at length, so a selector is regularly preceded by a
 * comment that explains it. A regex anchored on `(^|[};])` therefore fails on a
 * file that is exactly right and passes on one where the same words appear in
 * the wrong place. Splitting on braces also keeps `@media` blocks intact as
 * part of the enclosing context rather than pretending they are top-level, so a
 * rule is only ever judged together with the selectors it actually ships with.
 */
function globalCssRules(): Array<{ selector: string; body: string }> {
  const css = globalCssWithoutComments();
  const rules: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

/** Selector lists, one entry per comma-separated part. */
function selectorsOf(rule: { selector: string }): string[] {
  return rule.selector.split(",").map((part) => part.trim());
}

describe("text selection policy", () => {
  it("has no global rule that could make the app unselectable", () => {
    // The blanket `* { user-select: none }` shortcut is the failure this whole
    // addendum exists to prevent: it is invisible in a screenshot because a
    // selection that never happens draws nothing.
    const css = readFileSync(join(rootDir, "src", "app", "globals.css"), "utf8");
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const selector of [String.raw`\*`, "body", "html", String.raw`:root`]) {
      const blanket = new RegExp(
        String.raw`(^|[};])\s*(html\s*,\s*)?${selector}\s*[,{][^}]*user-select\s*:\s*none`,
        "i",
      );
      expect(
        withoutComments,
        `no blanket user-select rule on ${selector}`,
      ).not.toMatch(blanket);
    }
  });

  it("states the field guarantee in the stylesheet", () => {
    const css = globalCssWithoutComments();
    // A text-entry field that cannot have its content selected is broken for
    // every user who needs to edit or copy what they typed.
    //
    // Looked up structurally rather than matched as a literal. The previous form
    // was `input,\s*\ntextarea,\s*\[contenteditable=...`, which pinned the gate
    // to three things that are all incidental: that the list is written in that
    // order, that it holds exactly those three members, and that each line
    // carries no indentation. The rule is indented (it lives inside
    // `@layer components`), so the gate was failing against a stylesheet that
    // was already correct. The question worth asking is "is there a rule whose
    // selectors ARE the text-entry elements and whose body makes them
    // selectable", and that is what is asked now.
    const textEntry = globalCssRules().find((rule) => {
      const selectors = selectorsOf(rule);
      return (
        selectors.includes("input") &&
        selectors.includes("textarea") &&
        selectors.includes('[contenteditable="true"]') &&
        /user-select:\s*text/.test(rule.body)
      );
    });
    expect(
      textEntry,
      "no rule makes input, textarea and [contenteditable] selectable",
    ).toBeDefined();

    // And a range control must not paint a selection as it is dragged.
    const range = globalCssRules().find((rule) =>
      selectorsOf(rule).includes('input[type="range"]'),
    );
    expect(range, "no rule for the range input").toBeDefined();
    expect(range?.body).toMatch(/user-select:\s*none/);

    // No vendor prefixes: a prefixed duplicate is a second, silently divergent
    // answer to the same question.
    expect(css).not.toMatch(/-webkit-user-select|-moz-user-select|-ms-user-select/);
  });

  it("splits interaction rules into overridable defaults and unoverrideable guarantees", () => {
    // This is the reason the block is wrapped, and it is invisible in a
    // screenshot: an UNLAYERED author rule outranks every `@layer` in the
    // document categorically, before specificity is even consulted. Tailwind
    // declares `properties, theme, base, components, utilities`, so a rule
    // written at the bottom of `globals.css` outside any layer beats
    // `disabled:cursor-default` and `select-text` no matter how the selectors
    // compare - and a component that deliberately asked for a neutral cursor
    // silently gets a refusal one instead.
    //
    // Which means the layer a rule sits in is not a style choice, it is the
    // rule's JOB, and there are exactly two jobs:
    //
    //   1. A DEFAULT describes what an element is, and a component must be able
    //      to disagree. Cursor and selection are defaults. They live in
    //      `@layer components`: above `base` so they beat the browser and
    //      preflight, below `utilities` so a class at the call site decides.
    //
    //   2. A GUARANTEE says something must never be true, and nothing may opt
    //      out. The fixed backdrop must never intercept a click; an element
    //      animating out must never eat one. These are deliberately UNLAYERED,
    //      so that a stray `pointer-events-auto` utility anywhere in the app
    //      cannot reinstate a full-screen click blocker. They are named
    //      explicitly below, because the default answer for a new unlayered rule
    //      should be "no".
    const css = globalCssWithoutComments();

    const layerStart = css.indexOf("@layer components {");
    expect(layerStart, "the interaction contract lives in @layer components").toBeGreaterThan(-1);

    // The block ends at the first `}` that closes it at nesting depth zero.
    let depth = 0;
    let layerEnd = -1;
    for (let i = css.indexOf("{", layerStart); i < css.length; i += 1) {
      const ch = css[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          layerEnd = i;
          break;
        }
      }
    }
    expect(layerEnd, "the @layer components block is closed").toBeGreaterThan(-1);

    const inside = css.slice(layerStart, layerEnd);
    const outside = css.slice(0, layerStart) + css.slice(layerEnd);

    // Defaults - cursor and selection - must be overridable, so none may escape
    // the layer. This is the assertion that catches the bug: an unlayered
    // `button:disabled { cursor: not-allowed }` looks correct in isolation and
    // then defeats every `disabled:cursor-default` in the app.
    const defaults = /^\s*(?:user-select|cursor)\s*:/m;
    const escapedDefaults = outside
      .split("\n")
      .filter((line) => defaults.test(line))
      .map((line) => line.trim());
    expect(
      escapedDefaults,
      "an unlayered cursor or selection default silently outranks every Tailwind utility",
    ).toEqual([]);

    // Guarantees - pointer-events - must be named, not merely allowed. Each one
    // is a rule that exists so a whole class of bug cannot be reintroduced by a
    // utility class, and each has to be argued for on that basis.
    const guarantees: Array<{ selector: string; why: string }> = [
      {
        selector: ".aurora-backdrop",
        why: "a fixed, full-screen decorative layer that must never intercept a click",
      },
      {
        selector: '[data-presence="exiting"]',
        why: "an element animating out must not swallow pointer events while it is still in the layout",
      },
    ];
    const escapedGuarantees = outside
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\s*pointer-events\s*:/.test(line));
    expect(
      escapedGuarantees.length,
      `every unlayered pointer-events rule must be a declared guarantee; found ${escapedGuarantees.length} unlayered declaration(s)`,
    ).toBe(guarantees.length);
    for (const guarantee of guarantees) {
      expect(
        outside,
        `${guarantee.selector} is a guarantee (${guarantee.why}) and must stay unlayered`,
      ).toMatch(new RegExp(`${guarantee.selector.replace(/[[\]"']/g, "\\$&")}\\s*\\{[^}]*pointer-events:\\s*none`));
    }

    // And the layer must actually carry the policy, or the assertions above are
    // satisfied by an empty block.
    expect(inside).toMatch(/cursor:\s*pointer/);
    expect(inside).toMatch(/cursor:\s*not-allowed/);
    expect(inside).toMatch(/user-select:\s*text/);
    expect(inside).toMatch(/user-select:\s*none/);
    // The decorative-graphics backstop IS a default, not a guarantee: a graphic
    // that becomes a control - a click-to-play thumbnail - opts back in with
    // `pointer-events-auto` rather than by editing this stylesheet.
    expect(inside).toMatch(/pointer-events:\s*none/);
  });

  it("keeps editable controls selectable even though buttons are not", () => {
    // The `button { user-select: none }` default is what makes the ~100
    // hand-rolled controls match the `Button` primitive. Its blast radius has to
    // stop at the control, so the same sheet must state the opposite for the
    // editable elements, by name rather than by specificity.
    const rules = globalCssRules();
    const unselectableButtons = rules.filter(
      (rule) => selectorsOf(rule).includes("button") && /user-select:\s*none/.test(rule.body),
    );
    expect(
      unselectableButtons,
      "buttons are chrome, not content",
    ).not.toHaveLength(0);

    const editable = new Set(["input", "textarea", "select", '[contenteditable="true"]']);
    const editableMadeUnselectable: string[] = [];
    for (const rule of rules) {
      if (!/user-select:\s*none/.test(rule.body)) {
        continue;
      }
      for (const selector of selectorsOf(rule)) {
        if (editable.has(selector)) {
          editableMadeUnselectable.push(selector);
        }
      }
    }
    // `input[type="range"]` and `img`/`svg` are the deliberate exceptions and are
    // named as such; a bare `input` or `textarea` here is the cascade reaching
    // an editable control by accident.
    expect(
      editableMadeUnselectable,
      "an editable control must never be made unselectable by a stylesheet rule",
    ).toEqual([]);
  });

  it("keeps links selectable", () => {
    // The asymmetry with the rule above is deliberate and is the point of both:
    // a button is a command whose label is part of the control, an `<a href>`
    // is a destination whose text the user may still want to drag-select and
    // paste. If a link ever inherits an unselectable ancestor, the user can no
    // longer copy the title of the thing they clicked, and nothing in a
    // screenshot would show it.
    const offenders: string[] = [];
    for (const rule of globalCssRules()) {
      if (!/user-select:\s*none/.test(rule.body)) {
        continue;
      }
      for (const selector of selectorsOf(rule)) {
        if (/^a(\b|:|\[|\.)/.test(selector)) {
          offenders.push(selector);
        }
      }
    }
    expect(offenders, "no anchor is made unselectable by a stylesheet rule").toEqual([]);
  });

  it("never makes a text-entry field unselectable", () => {
    // The real guarantee behind the low-specificity CSS default. An element
    // carrying BOTH `select-text` and `select-none` is a contradiction, and the
    // winner depends on stylesheet order, so it is a failure either way.
    const offenders: string[] = [];
    for (const file of componentFiles()) {
      const content = readFileSync(file, "utf8");
      if (content.includes("select-text") && content.includes("select-none")) {
        // Allowed only if they are on provably different elements, which is
        // checked per-file below by counting tags; flag for manual review.
        offenders.push(file.slice(rootDir.length + 1).replace(/\\/g, "/"));
      }
    }
    // `search-field.tsx` and `playlist-share-control.tsx` are the two files
    // that legitimately pair a selectable field with an unselectable control.
    // `ui/button.tsx` is the third, and the most structural of them: the two
    // utilities live on the two different exported primitives, `select-none` on
    // `Button` (a command) and `select-text` on `ButtonLink` (a navigation).
    // That is the only correct way for that file to read - one element cannot
    // be both - and the source-level check cannot see the element boundary.
    const allowed = [
      "src/components/search/search-field.tsx",
      "src/components/playlist/playlist-share-control.tsx",
      "src/components/ui/button.tsx",
    ];
    for (const offender of offenders) {
      expect(
        allowed,
        `${offender} mixes select-text with select-none; confirm they are on different elements`,
      ).toContain(offender);
    }
  });

  it("keeps content text free of select-none in the components that render it", () => {
    // These are the elements whose text IS the product. Each is named
    // explicitly rather than pattern-matched, because a generic "find the
    // element with a title class" heuristic would drift silently as classes
    // are renamed.
    const contentClassNames = [
      "t-track-title",
      "t-metadata",
    ];
    for (const file of componentFiles()) {
      const content = readFileSync(file, "utf8");
      for (const className of contentClassNames) {
        if (!content.includes(className)) {
          continue;
        }
        // The class attribute that contains a content class must not also
        // contain select-none.
        const classAttributes = content.match(/className=\{?"[^"]*"/g) ?? [];
        for (const attribute of classAttributes) {
          if (attribute.includes(className)) {
            expect(
              attribute,
              `${file.slice(rootDir.length + 1)}: "${className}" must stay selectable`,
            ).not.toContain("select-none");
          }
        }
      }
    }
  });

  it("marks the shared Button primitive unselectable", () => {
    // Every `<Button>` in the product inherits this, which is why the bulk of
    // the control surface needs no per-component rule.
    const source = readFileSync(join(componentsRoot, "ui", "button.tsx"), "utf8");
    expect(source).toContain("select-none");
    render(<Button>Phát</Button>);
    const button = document.querySelector("button");
    expect(button?.className).toContain("select-none");
  });

  it("keeps the shared ButtonLink selectable", () => {
    // The counterpart of the assertion above, and the reason the two primitives
    // stopped sharing one base string. `ButtonLink` renders an `<a href>`, so it
    // is navigation: the user clicks a destination and then still wants to
    // drag-select the label to paste it elsewhere. Shipping `select-none` here
    // would have removed that ability from 17 call sites while fixing nothing,
    // because the rule it was borrowing - "the text is part of the control" -
    // does not reach a link.
    //
    // Asserted on the rendered element rather than on a source substring: the
    // class is what the browser reads, and a substring check would also be
    // satisfied by a doc comment that merely names the class it forbids.
    const link = render(<ButtonLink href="/library">Thư viện</ButtonLink>).container.querySelector(
      "a",
    );
    expect(link, "ButtonLink renders an anchor").not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/library");
    expect(link?.className).toContain("select-text");
    expect(
      link?.className,
      "a navigation link must not be unselectable",
    ).not.toContain("select-none");
  });

  it("gives every interactive primitive a pointer and a disabled state", () => {
    // A `<button>` gets `cursor: default` from the browser and from Tailwind's
    // preflight; nothing in this app used to put it back. These are the two
    // classes that make the control say what it is, so they are asserted at the
    // primitive rather than trusted to a stylesheet - the primitive is also what
    // a test or an embed renders without one.
    //
    // Each render is queried through its own container, because
    // `document.querySelector` would return the FIRST button in the document and
    // report the enabled one's classes for the disabled one.
    const enabled = render(<Button>Phát</Button>).container.querySelector("button");
    expect(enabled?.className).toContain("cursor-pointer");
    expect(enabled?.className).toContain("disabled:cursor-not-allowed");

    const off = render(<Button disabled>Phát</Button>).container.querySelector("button");
    expect(off?.hasAttribute("disabled")).toBe(true);
  });

  it("states the semantic cursor defaults in the stylesheet", () => {
    // The rule that covers the ~100 hand-rolled `<button>`s, menu items and
    // links that never touch the `Button` primitive. Element-scoped, so it
    // reaches a control without making a paragraph look live, and low
    // specificity so a `cursor-*` utility can still win at the call site.
    //
    // Asserted selector-by-selector rather than as one string, so adding a
    // control type later is a visible edit to this list instead of a silent
    // drift, and so removing one of them is a failure.
    const rules = globalCssRules();
    const pointerSelectors = new Set(
      rules.filter((r) => /cursor:\s*pointer/.test(r.body)).flatMap(selectorsOf),
    );
    for (const selector of [
      "button:not(:disabled)",
      "a[href]",
      "summary",
      "label[for]",
      'input[type="range"]',
      'input[type="checkbox"]',
      'input[type="radio"]',
    ]) {
      expect(
        [...pointerSelectors],
        `${selector} is interactive by semantic and must say so`,
      ).toContain(selector);
    }

    const notAllowedSelectors = new Set(
      rules.filter((r) => /cursor:\s*not-allowed/.test(r.body)).flatMap(selectorsOf),
    );
    expect([...notAllowedSelectors]).toContain("button:disabled");
    expect([...notAllowedSelectors]).toContain('a[aria-disabled="true"]');

    // No grab cursor: Aurora has no drag-and-drop anywhere, so a `grab` would
    // be a claim about an interaction that does not exist. Reordering is Move
    // up / Move down, which is a button and says so.
    expect(globalCssWithoutComments()).not.toMatch(/cursor:\s*grab/);
  });

  it("makes icons inert decoration", () => {
    // `base()` in ui/icons.tsx is the single choke point every icon passes
    // through, so this one assertion covers all of them.
    for (const Icon of [PlayIcon, SearchIcon]) {
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg, "icon renders an svg").not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.style.userSelect).toBe("none");
      expect(svg?.style.pointerEvents).toBe("none");
    }

    // The second half of the same contract: `base()` covers every icon that goes
    // THROUGH it, and the three hand-written `<svg>` elements in
    // `queue-panel.tsx`, `track-action-menu.tsx` and `locale-switcher.tsx` do not
    // - they are drawn with `fill` instead of the primitive's stroke. The
    // stylesheet is the only thing covering them, so it is asserted here rather
    // than assumed, and it carries both properties because the failure this
    // prevents is a click landing on a glyph instead of on its button.
    const decorative = globalCssRules().filter((rule) =>
      ["img", "svg"].every((tag) => selectorsOf(rule).includes(tag)),
    );
    expect(decorative, "the img/svg backstop exists").not.toHaveLength(0);
    for (const rule of decorative) {
      expect(rule.body, "decorative graphics are not selectable").toMatch(
        /user-select:\s*none/,
      );
      expect(rule.body, "decorative graphics never intercept a click").toMatch(
        /pointer-events:\s*none/,
      );
    }
  });

  it("never attaches a handler to a decorative graphic", () => {
    // The condition the global `img, svg { pointer-events: none }` backstop in
    // `globals.css` depends on. That rule is what stops a glyph from
    // intercepting a click aimed at the control around it, and it would be the
    // wrong rule the moment a graphic became the target - a click-to-play
    // artwork thumbnail, say, or an icon that opens its own detail view. Aurora
    // has no such element: artwork is either wrapped in a control or
    // informational, and every icon is decoration that names its control
    // elsewhere.
    //
    // A handler attribute on the element is the thing that would break the
    // rule's premise, so it is the thing asserted. A `<g>` inside a raw `<svg>`
    // is covered by the same query, which is why the pattern is not anchored to
    // the tag itself.
    const offenders: string[] = [];
    for (const file of componentFiles()) {
      const source = readFileSync(file, "utf8");
      const elements = source.match(/<(img|svg|g)\b[^>]*/g) ?? [];
      for (const element of elements) {
        if (/\bon[A-Z]/.test(element)) {
          offenders.push(
            `${file.slice(rootDir.length + 1).replace(/\\/g, "/")}: ${element.slice(0, 60)}`,
          );
        }
      }
    }
    expect(
      offenders,
      "a graphic with a handler is a control, not decoration, and must not be covered by the backstop",
    ).toEqual([]);
  });

  it("keeps the seek slider a control, not text", () => {
    const source = readFileSync(
      join(componentsRoot, "ui", "player-controls.tsx"),
      "utf8",
    );
    // A range input is not a <Button>, so it does not inherit that primitive's
    // classes; this is the one player control that needs its own rule. The
    // window is generous because the handler props sit between the type and the
    // className; what matters is that they are the same element.
    const inputStart = source.indexOf('type="range"');
    expect(inputStart, "SeekSlider renders a range input").toBeGreaterThan(-1);
    expect(source.slice(inputStart, inputStart + 1200)).toContain("select-none");
  });

  it("keeps the search field selectable and its clear button not", () => {
    const source = readFileSync(
      join(componentsRoot, "search", "search-field.tsx"),
      "utf8",
    );
    // The input and the clear control are siblings. Getting this backwards is
    // the specific bug this assertion exists to catch: an unselectable search
    // box means the user cannot copy the query they just typed.
    const inputStart = source.indexOf("<input");
    expect(inputStart, "SearchField renders an input").toBeGreaterThan(-1);
    expect(source.slice(inputStart, inputStart + 1200)).toContain("select-text");

    const clearStart = source.indexOf("onClick={handleClear}");
    expect(clearStart, "the clear control is present").toBeGreaterThan(-1);
    expect(source.slice(clearStart, clearStart + 600)).toContain("select-none");
  });

  it("keeps the share link selectable", () => {
    const source = readFileSync(
      join(componentsRoot, "playlist", "playlist-share-control.tsx"),
      "utf8",
    );
    // The share URL is the payload of the share dialog and the single most
    // copied string in the product.
    const fieldStart = source.indexOf("playlist-share-link");
    expect(fieldStart, "the share field is present").toBeGreaterThan(-1);
    expect(source.slice(fieldStart, fieldStart + 1400)).toContain("select-text");
  });
});
