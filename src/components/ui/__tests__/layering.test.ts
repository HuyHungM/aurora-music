// @vitest-environment node
/**
 * Structural guards for the layering and presence system (Phase 48).
 *
 * These exist because both of the defects this phase fixed were invisible to
 * the unit tests that were already there. The queue panel was in the DOM, had
 * correct styles, passed every assertion anyone had written — and was
 * completely untappable. Nothing about "two surfaces share a z-index" is
 * expressible as a component test; it is a property of the stylesheet and the
 * render order together.
 *
 * So these tests read the source and the stylesheet directly. That is
 * normally the wrong thing to do, and it is the right thing here precisely
 * because the bugs are cross-file agreements that no runtime test can see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Component source only: no `__tests__`, no Prisma's generated DMMF. */
const componentFiles = walk(SRC).filter(
  (f) => !f.includes(`${join("__tests__")}`) && /\.(tsx|ts)$/.test(f),
);

const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");

function read(rel: string) {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("layer tokens", () => {
  it("no component hardcodes a z-index number", () => {
    // The layer stack is declared in globals.css and consumed as semantic
    // utilities. A raw `z-50` in a component means someone picked a layer by
    // guessing, which is exactly how the queue and the full player ended up
    // sharing one and ordered only by DOM position.
    const offenders: string[] = [];
    for (const file of componentFiles) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // Arbitrary values and bare numbers only; `z-index: 5` in a comment or
        // a zustand selector is a false positive we do not care about.
        if (/class(Name)?=.*\bz-\[?\d/.test(line) && !line.trim().startsWith("*")) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("declares the full layer stack as theme utilities", () => {
    // Every layer the app uses must be a real utility, not a convention.
    for (const layer of [
      "sticky",
      "rail",
      "player",
      "floating",
      "dropdown",
      "popover",
      "sheet",
      "dialog",
      "toast",
    ]) {
      expect(css, `missing --z-index-${layer}`).toContain(
        `--z-index-${layer}: var(--p-z-${layer})`,
      );
      expect(css, `missing --p-z-${layer} primitive`).toContain(
        `--p-z-${layer}:`,
      );
    }
  });

  /**
   * The layer of the element that is *announced as a dialog* — matched on the
   * bare attribute line, not on the string `role="dialog"`, which also
   * appears inside the `closest('[role="dialog"]')` guards that dismiss
   * menus. Then the layer is read from the first `className` after it, which
   * is the same element's class list in JSX attribute order.
   */
  const dialogLayer = (text: string, label: string) => {
    const anchor = /^[\t ]*role="dialog"[\t ]*$/m.exec(text);
    expect(anchor, `no dialog element found in ${label}`).not.toBeNull();
    const rest = text.slice(anchor!.index);
    // The DIALOG's own class list is the first className attribute after the
    // anchor, in JSX attribute order — a later literal (the queue's menu
    // layer) must not answer for it. Either a string or a template; a
    // template's layer must sit in the static head, ahead of the first
    // interpolation, because a layer inside `${...}` would be conditional and
    // the layer a dialog paints at is not.
    const literal = /className="([^"]*)"/.exec(rest);
    const template = /className=\{`([^`]*)/.exec(rest);
    const first =
      literal && (!template || literal.index < template.index)
        ? literal[1]
        : (template?.[1]?.split("${")[0] ?? "");
    return first.match(/\bz-([a-z]+)\b/)?.[1];
  };

  it("orders the player surfaces so the queue is above the full player", () => {
    // The bug this phase found. Asserted as an ordering, because that is the
    // actual requirement: the full player is a full-viewport takeover, the
    // queue is a panel that must be able to sit on top of it. A comment
    // cannot drift this, and a future refactor of either value will fail
    // here rather than in a user's hands.
    const queue = read(join("components", "player", "queue-panel.tsx"));
    const full = read(join("components", "player", "full-player.tsx"));

    expect(dialogLayer(queue, "queue-panel")).toBe("dialog");
    expect(dialogLayer(full, "full-player")).toBe("sheet");

    // And the primitives those map to really are ordered.
    const value = (name: string) =>
      Number(css.match(new RegExp(`--p-z-${name}:\\s*(\\d+)`))?.[1]);
    expect(value("dialog")).toBeGreaterThan(value("sheet"));
    expect(value("sheet")).toBeGreaterThan(value("player"));
    expect(value("player")).toBeGreaterThan(value("rail"));
    expect(value("toast")).toBeGreaterThan(value("dialog"));
  });
});

describe("presence system", () => {
  it("defines a keyframe pair for every presence variant", () => {
    for (const name of [
      "backdrop",
      "pop",
      "sheet",
      "menu",
      "menu-up",
    ]) {
      expect(css, `missing .${name} rule`).toContain(`.presence-${name}[data-presence=`);
    }
    // Backdrop: opacity only. Pop/sheet: opacity + transform. Nothing may
    // animate a layout property, because that would cost frames during
    // playback.
    const keyframeBlock = css.slice(css.indexOf("@keyframes presence-pop-in"));
    expect(keyframeBlock).toMatch(/transform: scale\(0\.96\)/);
    expect(keyframeBlock).toMatch(/translateY\(12px\)/);
  });

  it("disables pointer events while exiting", () => {
    // The overlay is `fixed inset-0`. It has to stay mounted to animate, and
    // while it is mounted it would otherwise swallow every click on the page
    // for the length of its exit — an invisible dialog that eats the UI.
    expect(css).toMatch(/\[data-presence="exiting"\]\s*\{\s*pointer-events: none;/);
  });

  it("closes faster than it opens", () => {
    // A dismissal the listener has to wait out reads as latency.
    expect(css).toMatch(
      /presence-pop-out var\(--p-duration-fast\)/,
    );
    expect(css).toMatch(/presence-pop-in var\(--p-duration-normal\)/);
  });

  it("never loops", () => {
    // No presence animation may be infinite: an overlay that keeps
    // animating forever is a permanent cost on every page.
    //
    // Scanned from the first presence keyframe to the end of the file, and
    // only lines that actually declare an animation. The block's own comment
    // explains that nothing loops, and contains the word "infinite" while
    // doing so — a naive substring search over the block would flag the
    // comment that documents the invariant.
    const start = css.indexOf("@keyframes presence-backdrop-in");
    expect(start).toBeGreaterThan(-1);
    const declarations = css
      .slice(start)
      .split("\n")
      .filter((l) => /^\s*animation:/.test(l));
    expect(declarations.length).toBeGreaterThanOrEqual(8);
    for (const line of declarations) {
      expect(line, "presence animation must be finite").not.toMatch(/infinite/);
    }
  });
});

describe("bottom-of-viewport stack", () => {
  const appShell = read(join("components", "shell", "app-shell.tsx"));
  const miniPlayer = read(join("components", "player", "mini-player.tsx"));

  it("stacks content, then the mini player, then the bottom navigation", () => {
    // The mini player sits directly on top of the navigation, and its offset
    // accounts for the navigation's height AND its safe-area inset. An
    // offset of `bottom-16` only matched by coincidence with the nav's
    // `h-16`, and ignored the safe area entirely, so on a device with a home
    // indicator the player covered the bottom of the navigation.
    expect(miniPlayer).toContain(
      "bottom-[calc(4rem+env(safe-area-inset-bottom))]",
    );
    expect(appShell).toContain("h-16");
  });

  it("gives the safe-area inset to the bottom-most element only", () => {
    // Both the navigation and the mini player used to add
    // `pb-[env(safe-area-inset-bottom)]`, stacking two safe areas and
    // pushing the player's own content up off the navigation. Only the
    // bottom-most element should own it.
    expect(miniPlayer).not.toContain("pb-[env(safe-area-inset-bottom)]");
    expect(appShell).toContain("pb-[env(safe-area-inset-bottom)]");
  });
});
