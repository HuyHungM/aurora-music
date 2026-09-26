/**
 * Scrollbar and scroll-containment contract, verified in a real browser against
 * a real authenticated session.
 *
 * The unit gate in `src/app/__tests__/scrollbar.test.ts` proves the rules are
 * written correctly and land on exactly the intended set of scrollers. It
 * cannot prove that a browser resolves them: that `scrollbar-gutter` actually
 * removes a reflow when the page scrollbar disappears, that `overscroll-contain`
 * is what the engine computes on the dialog overlay rather than what the class
 * name suggests, or that the sidebar is genuinely left chaining. Those are the
 * claims only a running engine settles, and they are the claims a user would
 * notice being wrong.
 *
 * Every assertion runs on `pageA` rather than the default `page`. The scroll
 * surfaces that matter here - the library's playlist section, the queue, the
 * row menu - only exist once there is a session, and a contract test that
 * quietly ran signed-out would assert against the empty state of the very
 * surfaces it names.
 *
 * Nothing here is a visual assertion. Contrast, thumb discoverability and the
 * hover/active steps belong to visual review; a test that could not see them
 * would be a test asserting nothing.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";

const TRACK_ONE = FIXTURE_TRACKS[0].title;

/**
 * Opens the create-playlist dialog through whichever entry point is on screen.
 *
 * There are two "Create playlist" buttons and which one exists depends on
 * whether the user has any playlists: the section header carries an
 * `aria-label`, and the empty state carries the text. Both open the same
 * dialog, and the dialog is the subject here, so the entry point is not worth
 * an assertion of its own - but an unqualified `getByRole` would be a strict
 * mode violation the moment a fixture user's library is in the other state.
 */
async function openCreatePlaylistDialog(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Create playlist" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** Computed scroll state for every scroll container at or under `rootSelector`. */
async function scrollersUnder(
  page: import("@playwright/test").Page,
  rootSelector: string,
): Promise<
  Array<{ overflowY: string; overscrollY: string; cursor: string; userSelect: string }>
> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];
    return [root, ...Array.from(root.querySelectorAll("*"))]
      .map((el) => {
        const style = getComputedStyle(el);
        return {
          overflowY: style.overflowY,
          overscrollY: style.overscrollBehaviorY,
          cursor: style.cursor,
          userSelect: style.userSelect,
        };
      })
      .filter((s) => s.overflowY === "auto" || s.overflowY === "scroll");
  }, rootSelector);
}

authTest.describe("scroll contract", () => {
  authTest("reserves the gutter, so opening a dialog cannot reflow the page", async ({
    pageA,
  }) => {
    // The measurable half of `scrollbar-gutter: stable`. The dialog scroll lock
    // removes the page scrollbar; without a reserved gutter the content column
    // grows by the scrollbar's width, which is a visible jump on every dialog
    // open. Asserted as a number because a screenshot of a 10px shift is
    // indistinguishable from a screenshot of no shift.
    await pageA.goto("/library");
    await expect(pageA.getByRole("main")).toBeVisible();

    const measure = () =>
      pageA.evaluate(() => {
        const main = document.querySelector("main");
        return main ? Math.round(main.getBoundingClientRect().width) : null;
      });

    const before = await measure();
    await openCreatePlaylistDialog(pageA);
    const after = await measure();

    expect(before).not.toBeNull();
    expect(after).toEqual(before);
  });

  authTest("styles the page scrollbar from the token, not a hard-coded colour", async ({
    pageA,
  }) => {
    await pageA.goto("/library");
    await expect(pageA.getByRole("main")).toBeVisible();

    const root = await pageA.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        gutter: style.scrollbarGutter,
        width: style.scrollbarWidth,
        color: style.scrollbarColor,
        // The token must resolve to a real colour, not to an empty string. An
        // unresolved `var()` in a custom property reads as the literal text,
        // which is exactly how a broken token ships.
        thumb: style.getPropertyValue("--scrollbar-thumb").trim(),
        size: style.getPropertyValue("--scrollbar-size").trim(),
      };
    });

    expect(root.gutter).toBe("stable");
    expect(root.width).toBe("thin");
    expect(root.color).not.toBe("");
    expect(root.thumb).not.toBe("");
    expect(root.thumb).not.toMatch(/^var\(/);
    // A colour function, not a keyword the engine would have to invent.
    expect(root.thumb).toMatch(/oklab|oklch|color-mix|rgb/);
    expect(root.size).toMatch(/^\d/);
  });

  authTest("contains the dialog at both layers, because a tall dialog scrolls its panel", async ({
    pageA,
  }) => {
    await pageA.goto("/library");
    await openCreatePlaylistDialog(pageA);

    const layers = await pageA.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const overlay = panel?.parentElement;
      const read = (el: Element | null | undefined) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          overflowY: style.overflowY,
          overscrollY: style.overscrollBehaviorY,
        };
      };
      return { overlay: read(overlay), panel: read(panel) };
    });

    expect(layers.overlay).not.toBeNull();
    expect(layers.overlay?.overflowY).toBe("auto");
    expect(layers.overlay?.overscrollY).toBe("contain");
    expect(layers.panel?.overflowY).toBe("auto");
    expect(layers.panel?.overscrollY).toBe("contain");
  });

  authTest("contains the queue, which a trackpad flick leaves easily", async ({ pageA }) => {
    // The queue is the highest-frequency scroll area in the product, so it has
    // to be populated before "it scrolls" means anything: an empty queue has no
    // scroller at all, and a test that passed there would be asserting that an
    // absent element is fine.
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Actions for ${TRACK_ONE}` }).click();
    await pageA.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(pageA.getByRole("menuitem", { name: "Add to queue" })).toHaveCount(0);

    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const queue = pageA.getByRole("dialog", { name: "Queue" });
    await expect(queue).toBeVisible();

    const scrollers = await scrollersUnder(pageA, '[role="dialog"]');
    expect(scrollers.length).toBeGreaterThan(0);
    for (const scroller of scrollers) {
      expect(scroller.overscrollY).toBe("contain");
    }
  });

  authTest("leaves the sidebar chaining into the page, because it is a column and not an overlay", async ({
    pageA,
  }) => {
    // The half of the containment decision that is easy to get wrong by
    // applying containment everywhere. The sidebar sits beside the content in
    // one document, so running off its end SHOULD carry into the page; that is
    // what a user with a long library expects. Containment is for surfaces that
    // float over the page, and only for those.
    await pageA.goto("/library");
    await expect(pageA.getByRole("main")).toBeVisible();

    const sidebar = await scrollersUnder(pageA, "aside, [role='complementary']");
    expect(sidebar.length).toBeGreaterThan(0);
    for (const scroller of sidebar) {
      expect(scroller.overscrollY).toBe("auto");
    }
  });

  authTest("keeps a scroller a normal scroller: text cursor, selectable content, no drag", async ({
    pageA,
  }) => {
    // A scrollbar is the one affordance that appears on content, so the two
    // common ways to break scrolling show up here: claiming the text cursor on
    // a scrollable list, or making the list unselectable. Both are invisible in
    // a screenshot.
    await pageA.goto("/library");
    await expect(pageA.getByRole("main")).toBeVisible();

    const result = await pageA.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      return {
        drags: all.filter((el) => {
          const cursor = getComputedStyle(el).cursor;
          return cursor === "grab" || cursor === "grabbing";
        }).length,
        pointerScrollers: all
          .filter((el) => {
            const style = getComputedStyle(el);
            const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
            return scrolls && style.cursor === "pointer";
          })
          .map((el) => el.className.toString().slice(0, 40)),
        unselectableContent: Array.from(
          document.querySelectorAll("h1, h2, p, li"),
        ).filter((el) => getComputedStyle(el).userSelect === "none").length,
        unselectableFields: Array.from(
          document.querySelectorAll("input:not([type='range']), textarea, select"),
        ).filter((el) => getComputedStyle(el).userSelect === "none").length,
      };
    });

    expect(result.drags).toBe(0);
    expect(result.pointerScrollers).toEqual([]);
    expect(result.unselectableContent).toBe(0);
    expect(result.unselectableFields).toBe(0);
  });

  authTest("keeps the thumb contrast above the track on every glass preset", async ({
    pageA,
  }) => {
    // A thumb at the same alpha as the track is an invisible scrollbar, and the
    // track is transparent by design. Checked across the glass setting, because
    // the thumb alphas are declared per level and the level is what a user
    // actually changes.
    await pageA.goto("/settings");
    await expect(pageA.getByRole("main")).toBeVisible();

    const alphas = await pageA.evaluate(() => {
      const shell = document.querySelector("[data-aurora-glass]");
      if (!shell) return null;
      const read = () => {
        const style = getComputedStyle(shell);
        return {
          idle: style.getPropertyValue("--scrollbar-opacity").trim(),
          hover: style.getPropertyValue("--scrollbar-hover-opacity").trim(),
          active: style.getPropertyValue("--scrollbar-active-opacity").trim(),
        };
      };
      const previous = shell.getAttribute("data-aurora-glass");
      const samples = [read()];
      // Drive the same attribute the appearance system writes, so this checks
      // the cascade the glass override actually sits in rather than a
      // re-implementation of it.
      for (const on of ["off", "on"]) {
        shell.setAttribute("data-aurora-glass", on);
        samples.push(read());
      }
      if (previous === null) shell.removeAttribute("data-aurora-glass");
      else shell.setAttribute("data-aurora-glass", previous);
      return samples;
    });

    expect(alphas).not.toBeNull();
    expect((alphas ?? []).length).toBe(3);
    for (const sample of alphas ?? []) {
      const idle = Number.parseFloat(sample.idle);
      const hover = Number.parseFloat(sample.hover);
      const active = Number.parseFloat(sample.active);
      // Ordered, and never zero: a transparent thumb is the failure this
      // system exists to prevent.
      expect(idle).toBeGreaterThan(0);
      expect(hover).toBeGreaterThan(idle);
      expect(active).toBeGreaterThan(hover);
    }
  });
});
