// @vitest-environment jsdom
/**
 * The create-playlist dialog is PORTALLED out of the menu that opened it, and
 * the portal TARGET is what decides whether the user's appearance reaches it.
 *
 * THE DEFECT THIS PINS. `AppearanceRoot` carries the user's values as an inline
 * style on the shell root (`[data-aurora-glass]`). Everything inside it
 * inherits them by the ordinary DOM rule. `document.body` is a SIBLING of the
 * shell root, not a descendant, so a dialog portalled there inherited nothing
 * and rendered with the stylesheet defaults — measured 2026-10-04 at
 * `glassAlpha: 0.15`: the application wore `0.15` and the dialog wore `.6`.
 * Portalling into the shell root makes it inherit like everything else, with no
 * second writer and no duplicated token.
 *
 * WHY A REAL PORTAL IS STILL NEEDED. The picker's own menu is `overflow-hidden`
 * (`add-to-playlist-menu.tsx:452`), so the dialog has to leave it. Portalling is
 * not the bug; portalling to the wrong element was.
 *
 * WHY THIS IS A SOURCE ASSERTION RATHER THAN A RENDERED ONE. The dialog is a
 * `lazy()` boundary behind a click on "New playlist", so reaching it in jsdom
 * needs a server-action mock, a Suspense flush and a click — a lot of
 * machinery to assert a single argument that is right there in the call. The
 * property under test is literally "which element was handed to
 * `createPortal`", and reading that off the source is the direct measurement.
 * The behavioural proof is the browser run recorded above; this gate exists so
 * the argument cannot silently regress back to `document.body`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/tracks/add-to-playlist-menu.tsx"),
  "utf8",
);

/**
 * The portal target expression, with comments stripped.
 *
 * Comments have to go: the explanation for this decision sits directly above the
 * argument and names both `[data-aurora-glass]` and `document.body`, so an
 * assertion over the raw text would pass on the prose alone. Stripping them
 * first means the assertion can only be satisfied by executable code.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("the create-playlist dialog's portal target", () => {
  it("portals into the appearance shell root, not document.body", () => {
    const start = code.indexOf("createPortal(");
    expect(start, "add-to-playlist-menu.tsx no longer calls createPortal").toBeGreaterThan(-1);
    // The target is the last argument, after the lazy element. Matching rather
    // than slicing on `)` because the selector string itself contains one.
    const target = code
      .slice(start, code.indexOf("; ", start) === -1 ? start + 2000 : start)
      .slice(code.slice(start).indexOf("</Suspense>"));

    // The shell root FIRST, so the dialog inherits the user's
    // `--p-appearance-*` by the ordinary DOM rule; `document.body` survives only
    // as the `??` fallback for a render with no shell.
    expect(target).toMatch(
      /,\s*document\s*\.\s*querySelector\(\s*"\[data-aurora-glass\]"\s*\)\s*\?\?\s*document\s*\.\s*body\s*,?\s*[\s\S]{0,3}\)/,
    );
  });

  it("keeps the picker menu overflow-hidden, which is why a portal exists at all", () => {
    // If this ever stops being true the portal can go away entirely, and
    // finding that out by deleting the portal would have been the slow way.
    expect(code).toContain("overflow-hidden");
  });
});
