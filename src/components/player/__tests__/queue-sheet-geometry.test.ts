// @vitest-environment node
/**
 * Structural guards for the mobile queue sheet geometry.
 *
 * The defects this file pins were invisible to every runtime test that
 * existed: the sheet was in the DOM, had "correct styles", passed every
 * assertion anyone had written — and hugged the left edge of every phone
 * with dead space on the right, because `mx-auto` does not center a `fixed`
 * element whose `left`/`right` are `auto` (the static position is the
 * containing block's left edge). Centering is a property of the class list
 * and the stylesheet together, so it is asserted here, at the source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
const panel = readFileSync(
  join(SRC, "components", "player", "queue-panel.tsx"),
  "utf8",
);

describe("queue sheet geometry", () => {
  it("declares the bottom offset once, as a custom property", () => {
    // The single source of truth. Both `bottom-` and `max-h` on the sheet
    // derive from it, so the anchor and the height cap cannot drift apart.
    const declarations = css.match(/--p-queue-sheet-bottom\s*:/g) ?? [];
    expect(declarations).toHaveLength(2);
    expect(css).toContain("--p-queue-sheet-bottom: 9rem;");
    expect(css).toContain("--p-queue-sheet-bottom: 9.5rem;");
  });

  it("steps the offset at sm on the variable, not in a second class", () => {
    // The 9.5rem step the sheet already used at `sm` lives on the variable
    // behind a plain breakpoint query — a custom property is not a utility,
    // so a Tailwind variant is the wrong tool and would split the answer to
    // "how far up is the sheet" across two places.
    expect(css).toMatch(
      /@media\s*\(min-width:\s*640px\)\s*\{\s*:root\s*\{\s*--p-queue-sheet-bottom:\s*9\.5rem;\s*\}\s*\}/,
    );
  });

  it("anchors the sheet's bottom and height cap to the variable", () => {
    expect(panel).toContain(
      "bottom-[calc(var(--p-queue-sheet-bottom)+env(safe-area-inset-bottom))]",
    );
    expect(panel).toContain(
      "max-h-[min(70svh,calc(100dvh-var(--p-queue-sheet-bottom)-env(safe-area-inset-bottom)-env(safe-area-inset-top)))]",
    );
  });

  it("keeps no magic-number bottom offset on the sheet", () => {
    // `9rem`/`9.5rem` in a positioning class is the duplication this change
    // removes: the numbers live on the variable now. Comments may still name
    // them, and the empty-queue anchor below is a different state, not a
    // second copy of the same offset.
    const lines = panel.split("\n");
    const offenders = lines.filter(
      (line) =>
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("//") &&
        /bottom-\[calc\(9(\.5)?rem/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("centers with explicit insets rather than margin auto alone", () => {
    // `mx-auto` on a `fixed` element with auto left/right resolves to the
    // static position (the left edge). Both insets set + `mx-auto` +
    // `max-w-md` centers by construction at every width.
    expect(panel).toContain(
      "left-[max(1rem,env(safe-area-inset-left))]",
    );
    expect(panel).toContain(
      "right-[max(1rem,env(safe-area-inset-right))]",
    );
    expect(panel).toContain("max-w-md");
  });

  it("drops the sheet when the mini player is gone", () => {
    // No track means no mini player, so the sheet sits just above the
    // navigation instead of floating over the space the mini player would
    // occupy. The condition is the mini player's own visibility condition
    // read from the same store, so the two cannot disagree.
    expect(panel).toMatch(/currentTrack !== null/);
    expect(panel).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom))]");
  });

  it("derives the desktop side panel anchor from the player bar's own token", () => {
    // The desktop panel used to sit at a hand-written `calc(6rem + 1.5rem)`,
    // which spelled out the player bar's height as a literal. `--p-layout-player`
    // is that height, so the panel derives from it and the two cannot drift
    // apart; the gap under the bar is the only thing stated here.
    expect(panel).toContain("lg:bottom-[calc(var(--p-layout-player)+0.75rem)]");
    expect(css).toContain("--p-layout-player: 6rem;");
  });

  it("lines the desktop panel's right edge up with the player bar's content edge", () => {
    // `right-6` put the panel 1.5rem from the viewport edge while the bar's own
    // content is inset by `px-5` (1.25rem), so nothing lined up. The panel now
    // uses that same inset, still inside the safe area.
    expect(panel).toContain(
      "lg:right-[max(1.25rem,env(safe-area-inset-right))]",
    );
    expect(panel).not.toContain("lg:right-6");
  });

  it("keeps the desktop panel's own anchoring properties", () => {
    expect(panel).toContain("lg:left-auto");
    expect(panel).toContain("lg:mx-0");
    expect(panel).toContain("lg:w-96");
  });

  it("keeps the sheet above the full player and the dialog below toasts", () => {
    // The layering contract the existing layering test owns; repeated here
    // only as the half this file could break by touching the class list. The
    // sheet's classes are a template with interpolations, so the assertion
    // reads from the token forward rather than through a character window
    // that a conditional could shift.
    const sheetClasses = panel.slice(panel.indexOf("presence-sheet"));
    expect(sheetClasses).toContain("z-dialog");
  });

  it("keeps the internal scroller contained", () => {
    // `overflow-y-auto` + `overscroll-contain` is the combination the
    // scrollbar system test owns; the geometry change must not drop either.
    expect(panel).toContain("overflow-y-auto");
    expect(panel).toContain("overscroll-contain");
  });

  it("never centers with a transform", () => {
    // The `presence-sheet` animation owns `transform` for the entrance. A
    // translate-based centering would be overridden mid-animation and snap
    // after it — insets are the only centering that survives the lifecycle.
    expect(panel).not.toMatch(/-translate-x-/);
  });
});

describe("queue outside-pointer dismissal", () => {
  it("registers exactly one pointerdown listener per open lifecycle", () => {
    // One listener, added while open and removed on close: never a second one
    // for touch, never a pair for pointer+mouse (a mouse click also fires
    // pointerdown, so a second mouse listener would double-handle).
    const listeners = panel.match(/addEventListener\("pointerdown"/g) ?? [];
    expect(listeners).toHaveLength(1);
    expect(panel).toContain('removeEventListener("pointerdown"');
  });

  it("treats the panel, the trigger and other overlays as inside", () => {
    expect(panel).toContain("dialogRef.current?.contains(target)");
    expect(panel).toContain("[data-queue-trigger]");
    expect(panel).toContain('[role="dialog"], [role="alertdialog"], [role="menu"]');
  });

  it("marks every queue trigger it can be opened from", () => {
    // The bar, the mini player and the full player each own an "Up next"
    // control. Missing one would make that trigger dismiss the panel on the
    // same press that opens it.
    const triggers = [
      join(SRC, "components", "player", "player-bar.tsx"),
      join(SRC, "components", "player", "mini-player.tsx"),
      join(SRC, "components", "player", "full-player.tsx"),
    ];
    for (const file of triggers) {
      expect(readFileSync(file, "utf8")).toContain("data-queue-trigger");
    }
  });

  it("does not reach for broad default suppression", () => {
    // Tapping outside must not be a way to cancel a native scroll or a click
    // elsewhere; dismissal observes the event, it never prevents it.
    const effect = panel.slice(
      panel.indexOf("const onPointerDown"),
      panel.indexOf("}, [isQueueOpen, closeAndRestoreFocus]);"),
    );
    expect(effect).not.toContain("preventDefault");
    expect(effect).not.toContain("stopPropagation");
  });
});
