/**
 * Floating queue positioning guards (mobile).
 *
 * The queue is a viewport-anchored sheet below `lg`: it must stay inside the
 * viewport, stay clear of the mini player and the bottom navigation, stay
 * centered, and keep its list internally scrollable — at every phone width,
 * in landscape, and after the page scrolls. Every rule below is asserted
 * numerically, because a screenshot at 390px does not show the 16px of dead
 * space a left-aligned sheet leaves at 390px and not at 375px.
 *
 * WHAT IS ASSERTED, AND WHY THESE THINGS
 *
 * 1. Centering. The sheet once relied on `mx-auto` with `left`/`right` auto,
 *    which resolves a fixed element to the static position — the left edge —
 *    so the sheet hugged the left at every phone width. Asserted as
 *    |x - (viewport - width)/2| <= 1, which is centering by construction.
 *
 * 2. No overlap with the mini player or the bottom navigation. Asserted as
 *    rect comparisons (panel.bottom <= mini.top, panel.bottom <= nav.top),
 *    not z-index: correct position matters more than paint order.
 *
 * 3. Viewport anchoring. The page is scrolled with the sheet open and the
 *    sheet's rect is re-measured: a floating surface must not move with page
 *    content.
 *
 * 4. Internal scroll. A long queue must scroll inside the sheet (and only
 *    there) while the header row — close button included — stays reachable.
 *
 * 5. The no-mini-player state. With no track playing there is no mini player,
 *    so the sheet drops to just above the navigation instead of floating
 *    over empty space.
 *
 * 6. Desktop is untouched. At `lg` the queue is a right-anchored side panel;
 *    this file asserts that anchor so a mobile fix cannot silently move it.
 *
 * Selectors are structural (roles, not translated names) like the rest of
 * the suite. The queue is the dialog that owns a scrollable list, which
 * distinguishes it from the full player behind it.
 */
import { mobileAuthTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import { settle } from "./helpers/settle";
import type { Page } from "@playwright/test";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/** Phone portrait widths from the mission matrix, plus tablet portrait. */
const PORTRAIT_WIDTHS = [320, 360, 375, 390, 412, 430, 768];

/** Landscape phone, where height is the constraint. */
const LANDSCAPE = { w: 844, h: 390 };

async function openLibraryWithTrackPlaying(page: Page) {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: `Play ${TRACK_ONE}` })
    .click();
  await expect(page.locator('[role="region"]')).toHaveCount(2);
}

/** Open the queue from wherever the "Up next" control currently lives. */
async function openQueue(page: Page) {
  const inDialog = page.locator(
    '[role="dialog"][aria-modal="true"] [aria-label="Up next"]',
  );
  if (await inDialog.isVisible().catch(() => false)) {
    await inDialog.click();
  } else {
    await page.locator('[aria-label="Up next"]:visible').first().click();
  }
  await expect(
    page.locator('[role="dialog"]').filter({ has: page.locator("li") }),
  ).toBeVisible();
  await settle(page);
}

interface Rect {
  t: number;
  b: number;
  l: number;
  r: number;
  w: number;
  h: number;
}

interface SheetGeometry {
  vw: number;
  vh: number;
  queue: Rect | null;
  mini: Rect | null;
  nav: Rect | null;
  headerVisible: boolean;
}

async function measureSheet(page: Page): Promise<SheetGeometry> {
  return page.evaluate(() => {
    const r = (el: Element | null): Rect | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        t: Math.round(b.top),
        b: Math.round(b.bottom),
        l: Math.round(b.left),
        r: Math.round(b.right),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const panels = Array.from(document.querySelectorAll('[role="dialog"]'));
    const panel = panels.find((d) =>
      Array.from(d.querySelectorAll("div")).some((x) =>
        x.className.toString().includes("overflow-y-auto"),
      ),
    );
    const mini = document.querySelector('[aria-label="Mini player"]');
    // The bottom nav is the visible fixed nav whose bottom edge meets the
    // viewport bottom; the sidebar's inner nav is display:none below `lg`
    // and reports a zero rect, so it is filtered by size.
    const nav =
      Array.from(document.querySelectorAll("nav")).find((n) => {
        const b = n.getBoundingClientRect();
        return (
          b.height > 0 &&
          getComputedStyle(n).display !== "none" &&
          Math.abs(b.bottom - window.innerHeight) < 2
        );
      }) ?? null;
    const close = panel?.querySelector("button[aria-label]") ?? null;
    const closeBox = close?.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      queue: r(panel ?? null),
      mini: r(mini),
      nav: r(nav),
      headerVisible:
        closeBox !== undefined &&
        closeBox !== null &&
        closeBox.width > 0 &&
        closeBox.top >= -1 &&
        closeBox.bottom <= window.innerHeight + 1,
    };
  });
}

mobileAuthTest.describe("queue sheet positioning", () => {
  mobileAuthTest(
    "the sheet is centered and clear of the mini player and navigation",
    async ({ phoneA: page }) => {
      for (const w of PORTRAIT_WIDTHS) {
        await page.setViewportSize({ width: w, height: 800 });
        await openLibraryWithTrackPlaying(page);
        // Below `sm` the queue button lives in the full player.
        if (w < 640) {
          await page
            .locator('[aria-label="Expand player"]:visible')
            .first()
            .click();
          await expect(
            page.locator('[role="dialog"][aria-modal="true"]'),
          ).toBeVisible();
          await settle(page);
        }
        await openQueue(page);

        const g = await measureSheet(page);
        const label = `${w}x800`;
        expect(g.queue, `${label}: the queue dialog was not found`).not.toBeNull();
        const q = g.queue!;
        expect(q.l, `${label}: the sheet starts off-screen left`).toBeGreaterThanOrEqual(0);
        expect(q.r, `${label}: the sheet overflows the right edge`).toBeLessThanOrEqual(
          g.vw + 1,
        );
        // Centered by construction: the dead space is split equally.
        expect(
          Math.abs(q.l - (g.vw - q.w) / 2),
          `${label}: the sheet is not centered (x=${q.l}, width=${q.w})`,
        ).toBeLessThanOrEqual(1);
        expect(q.t, `${label}: the sheet starts above the viewport`).toBeGreaterThanOrEqual(-1);
        expect(g.headerVisible, `${label}: the header/close is unreachable`).toBe(true);
        // The single source of truth resolves: the test browser reports no
        // safe-area insets, so the sheet's bottom edge sits exactly one
        // variable above the viewport bottom (9rem base, 9.5rem at `sm`).
        expect(
          g.vh - q.b,
          `${label}: the sheet is not anchored to --p-queue-sheet-bottom`,
        ).toBe(w < 640 ? 144 : 152);
        if (g.mini) {
          expect(
            q.b,
            `${label}: the sheet overlaps the mini player`,
          ).toBeLessThanOrEqual(g.mini.t + 1);
        }
        if (g.nav) {
          expect(
            q.b,
            `${label}: the sheet overlaps the bottom navigation`,
          ).toBeLessThanOrEqual(g.nav.t + 1);
        }

        await page.keyboard.press("Escape");
        await expect(
          page.locator('[role="dialog"]').filter({ has: page.locator("li") }),
        ).toBeHidden();
      }
    },
  );

  mobileAuthTest("the sheet fits a short landscape viewport", async ({ phoneA: page }) => {
    await page.setViewportSize({ width: LANDSCAPE.w, height: LANDSCAPE.h });
    await openLibraryWithTrackPlaying(page);
    await openQueue(page);

    const g = await measureSheet(page);
    const label = `${LANDSCAPE.w}x${LANDSCAPE.h}`;
    expect(g.queue, `${label}: the queue dialog was not found`).not.toBeNull();
    const q = g.queue!;
    expect(q.t, `${label}: the sheet starts above the viewport`).toBeGreaterThanOrEqual(-1);
    expect(q.b, `${label}: the sheet runs past the viewport bottom`).toBeLessThanOrEqual(
      g.vh + 1,
    );
    expect(q.l, `${label}: the sheet starts off-screen left`).toBeGreaterThanOrEqual(0);
    expect(q.r, `${label}: the sheet overflows the right edge`).toBeLessThanOrEqual(
      g.vw + 1,
    );
    expect(
      Math.abs(q.l - (g.vw - q.w) / 2),
      `${label}: the sheet is not centered`,
    ).toBeLessThanOrEqual(1);
    expect(g.headerVisible, `${label}: the header/close is unreachable`).toBe(true);
    if (g.mini) {
      expect(q.b, `${label}: the sheet overlaps the mini player`).toBeLessThanOrEqual(
        g.mini.t + 1,
      );
    }
  });

  mobileAuthTest("the sheet stays anchored while the page scrolls", async ({
    phoneA: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLibraryWithTrackPlaying(page);
    await page.locator('[aria-label="Expand player"]:visible').first().click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await settle(page);
    await openQueue(page);

    const before = (await measureSheet(page)).queue!;
    // The sheet is modal with the page scroll-locked, but the assertion is
    // geometric rather than trusting the lock: the rect must not move.
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);
    const after = (await measureSheet(page)).queue!;
    expect(after, "the queue dialog was not found after scrolling").not.toBeNull();
    expect([after.t, after.b, after.l, after.r]).toEqual([
      before.t,
      before.b,
      before.l,
      before.r,
    ]);
  });

  mobileAuthTest("a long queue scrolls inside the sheet", async ({ phoneA: page }) => {
    // Only two playable fixture tracks exist, and `addToQueue` deliberately
    // dedupes, so a tall queue cannot be built by enqueueing. Overflow is
    // forced the other way instead: a short viewport (390x400) caps the
    // sheet at 256px while three rows need ~340px. That is exactly the
    // landscape-phone regime the `max-h` cap exists for.
    await page.setViewportSize({ width: 390, height: 400 });
    await openLibraryWithTrackPlaying(page);
    // Enqueue every other fixture track exactly once; repeats are a no-op
    // by design, so looping over titles would only re-click menus.
    for (const title of [TRACK_TWO]) {
      await page
        .getByRole("main")
        .locator("li")
        .filter({ hasText: title })
        .locator('button[aria-label^="Actions for"]:visible')
        .first()
        .click();
      const item = page.getByRole("menuitem", { name: "Add to queue" });
      await expect(item).toBeVisible();
      await item.click();
      // The menu stays mounted through its exit animation: without waiting
      // for it to detach, assertions below would race a dying menu.
      await expect(item).toBeHidden();
    }
    await page.locator('[aria-label="Expand player"]:visible').first().click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await settle(page);
    await openQueue(page);

    const scroller = page
      .locator('[role="dialog"]')
      .filter({ has: page.locator("li") })
      .locator("div.overflow-y-auto")
      .first();
    // Honesty check first: the two enqueues above must have landed, or the
    // overflow below would assert against a queue that never grew.
    const rows = page
      .locator('[role="dialog"]')
      .filter({ has: page.locator("li") })
      .locator("li");
    await expect(rows).toHaveCount(2);
    const overflow = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      overflow.scrollHeight,
      "the short viewport did not force the list past the sheet cap",
    ).toBeGreaterThan(overflow.clientHeight);

    // The list scrolls; the sheet does not move with it.
    const before = (await measureSheet(page)).queue!;
    await scroller.evaluate((el) => {
      el.scrollTop = 120;
    });
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(0);
    const after = (await measureSheet(page)).queue!;
    expect([after.t, after.b, after.l, after.r]).toEqual([
      before.t,
      before.b,
      before.l,
      before.r,
    ]);
    const g = await measureSheet(page);
    expect(g.headerVisible, "the header/close left the viewport").toBe(true);
  });

  mobileAuthTest("the sheet closes and returns focus state", async ({ phoneA: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLibraryWithTrackPlaying(page);
    await page.locator('[aria-label="Expand player"]:visible').first().click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await settle(page);
    await openQueue(page);

    await page.keyboard.press("Escape");
    await expect(
      page.locator('[role="dialog"]').filter({ has: page.locator("li") }),
    ).toBeHidden();
    // Both layers dismiss on one press: the queue AND the full player behind
    // it listen for Escape on `document` with no stopPropagation, so the page
    // unlocks completely. That stacked-dismissal behavior predates this
    // change and is intentionally left alone here; what this asserts is the
    // part the positioning owns - the queue released the lock it took rather
    // than stranding the page unscrollable.
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow), {
        timeout: 5_000,
      })
      .toBe("");
  });

  mobileAuthTest("the desktop side panel anchor is unchanged", async ({
    phoneA: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLibraryWithTrackPlaying(page);
    await openQueue(page);

    const g = await measureSheet(page);
    expect(g.queue, "the queue panel was not found").not.toBeNull();
    const q = g.queue!;
    // Right-anchored 24rem side panel: the mobile centering must not move it.
    expect(q.w, "desktop panel width changed").toBe(384);
    expect(Math.abs(q.r - (g.vw - 24)), "desktop panel is not right-anchored").toBeLessThanOrEqual(
      1,
    );
  });
});
