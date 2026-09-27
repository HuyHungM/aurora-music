/**
 * Menu geometry contract, verified in a real browser.
 *
 * A menu is `position: absolute` inside a `relative` wrapper, so it is
 * painted in the z-order of whatever contains it and clipped by whatever
 * scrolls above it. `position: absolute` on its own is not a positioning
 * decision: it says where the box is anchored, not whether the box survives
 * the trip. Every one of those four things - positioning context, clipping,
 * stacking, z-index - was wrong somewhere in this product, and the symptom
 * was always the same shape: the menu opened, and part of it was not there.
 * A row menu on the queue's last visible row lost 136px to the list's own
 * `overflow-y-auto`; the same menu on the search top result lost 120px of 162
 * to a decorative `overflow-hidden` on a card that never needed it.
 *
 * What a jsdom test cannot see is the part that actually broke. jsdom has no
 * box model, so a class-level assertion can prove a card does not say
 * `overflow-hidden` and nothing more. It cannot tell you the menu is 120px
 * taller than the card that clipped it, that the queue's scroller eats a
 * third of a surface, or that a whole menu is painting behind the panel's own
 * rows. Those are claims about resolved geometry, and they are asserted here,
 * from the boxes the engine actually computed.
 *
 * The measurement is deliberately the browser's own rather than a
 * re-implementation of it: walk the real ancestors, read the real computed
 * `overflow`, and compare the menu's rect against each of theirs. Then
 * hit-test every item, because "not clipped" and "actually on top" are
 * different claims and only the second one is what a user experiences - a
 * menu can be geometrically perfect and still be behind a sibling.
 *
 * Every assertion runs on `pageA`: the surfaces that matter here - library
 * rows, the queue, the row menu - only exist once there is a session, and a
 * geometry test that quietly ran signed-out would measure the empty state of
 * the very surfaces it names.
 */
import type { Page } from "@playwright/test";
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/** Phone width, set inside the test rather than by a project device: this
 *  spec also asserts desktop geometry, and one project cannot be both. */
const PHONE = { width: 390, height: 844 };

const MENU_ACTIONS = "Track actions";
const MENU_PICKER = "Add to playlist";

interface MenuAudit {
  rect: { top: number; right: number; bottom: number; left: number; height: number };
  /** Ancestors whose overflow box cuts into the menu, and by how much. */
  clippedBy: Array<{ by: string; cut: number }>;
  /** How far the menu leaves the viewport, per side. */
  outsideViewport: { top: number; right: number; bottom: number; left: number };
  /** Items whose centre is not the topmost element at that point, and what
   *  was on top of them instead. */
  coveredItems: Array<{ item: string; over: string }>;
  /** Items the pointer cannot reach because they are disabled. */
  unclickableItems: string[];
  /** Items the accessibility tree cannot see. */
  hiddenItems: string[];
  /** Whether a scrolling ancestor is still in the surface's chain. */
  inScrollContainer: boolean;
}

/**
 * Measures the open menu on the page.
 *
 * `cut` is how many pixels of the menu fall outside an ancestor's clip box,
 * summed over the four sides. Zero is the only passing value: a menu one
 * pixel short is a menu with an item the pointer cannot reach.
 */
async function auditMenu(page: Page, ariaLabel: string): Promise<MenuAudit> {
  return page.evaluate((label: string) => {
    const menu = document.querySelector(`[role="menu"][aria-label="${label}"]`);
    if (!menu) throw new Error(`no menu labelled "${label}" on screen`);
    const mr = menu.getBoundingClientRect();

    // Enough of an element to identify it in a failure message. A test that
    // says "something is on top" without saying what is on top makes the
    // reader do the debugging, and the whole point of hitting the pixels is
    // that the answer is the page's, not the test's.
    const describe = (el: Element | null): string => {
      if (!el) return "nothing";
      const role = el.getAttribute("role");
      const ariaLabel = el.getAttribute("aria-label");
      const cls = String(el.className ?? "")
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .join(".");
      return [
        el.tagName.toLowerCase(),
        role ? `[role=${role}]` : "",
        ariaLabel ? `[aria-label="${ariaLabel}"]` : "",
        cls ? `.${cls}` : "",
      ].join("");
    };

    const clippedBy: Array<{ by: string; cut: number }> = [];
    let inScrollContainer = false;
    for (let node = menu.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowY === "auto" || style.overflowY === "scroll") inScrollContainer = true;
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const r = node.getBoundingClientRect();
      const cut =
        Math.max(0, mr.bottom - r.bottom) +
        Math.max(0, mr.right - r.right) +
        Math.max(0, r.left - mr.left) +
        Math.max(0, r.top - mr.top);
      if (cut > 0) {
        const role = node.getAttribute("role");
        clippedBy.push({
          by: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${role ? `[role=${role}]` : ""}`,
          cut,
        });
      }
    }

    const coveredItems: Array<{ item: string; over: string }> = [];
    const unclickableItems: string[] = [];
    const hiddenItems: string[] = [];
    for (const item of Array.from(menu.querySelectorAll('[role="menuitem"]'))) {
      const r = item.getBoundingClientRect();
      const name = item.textContent?.trim() ?? "?";
      if (r.width === 0 || r.height === 0) {
        hiddenItems.push(name);
        continue;
      }
      // A disabled item is not supposed to take the click, and the menu says
      // so with `disabled:pointer-events-none` so the cursor does not pretend
      // otherwise. Hit-testing one returns its parent, which would otherwise
      // be reported as the surface covering itself.
      const disabled =
        (item as HTMLButtonElement).disabled === true ||
        item.getAttribute("aria-disabled") === "true" ||
        getComputedStyle(item).pointerEvents === "none";
      if (disabled) {
        unclickableItems.push(name);
        continue;
      }
      const topmost = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!topmost || !item.contains(topmost)) {
        coveredItems.push({ item: name, over: describe(topmost) });
      }
    }

    return {
      rect: { top: mr.top, right: mr.right, bottom: mr.bottom, left: mr.left, height: mr.height },
      clippedBy,
      outsideViewport: {
        top: Math.max(0, -mr.top),
        right: Math.max(0, mr.right - window.innerWidth),
        bottom: Math.max(0, mr.bottom - window.innerHeight),
        left: Math.max(0, -mr.left),
      },
      coveredItems,
      unclickableItems,
      hiddenItems,
      inScrollContainer,
    };
  }, ariaLabel);
}

/** Every claim a user would make about a menu, in one place. */
function expectHealthy(audit: MenuAudit, where: string) {
  expect(audit.clippedBy, `${where}: an ancestor clips the menu`).toEqual([]);
  expect(
    Object.values(audit.outsideViewport).reduce((a, b) => a + b, 0),
    `${where}: the menu leaves the viewport ${JSON.stringify(audit.outsideViewport)}`,
  ).toBe(0);
  expect(audit.coveredItems, `${where}: something paints over these items`).toEqual([]);
  expect(audit.hiddenItems, `${where}: these items have no box`).toEqual([]);
}

/**
 * A menu that is painted but hidden from the accessibility tree is not
 * usable, and `elementFromPoint` cannot see that failure: the pixels are
 * there, the roles are not. So the item count is read from the DOM and the
 * role query has to agree with it.
 */
async function expectItemsReachable(page: Page, label: string, where: string) {
  const inDom = await page
    .locator(`[role="menu"][aria-label="${label}"] [role="menuitem"]`)
    .count();
  expect(inDom, `${where}: the menu has items to reach`).toBeGreaterThan(0);
  await expect(
    page.getByRole("menu", { name: label }).getByRole("menuitem"),
    `${where}: menu items are in the accessibility tree`,
  ).toHaveCount(inDom);
}

/** Puts both fixture tracks in the queue. */
async function enqueueFixtureTracks(page: Page) {
  await page.goto("/e2e-library");
  await expect(page.getByRole("heading", { name: "E2E fixture library" })).toBeVisible();

  for (const title of [TRACK_ONE, TRACK_TWO]) {
    await page.getByRole("button", { name: `Actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(page.getByRole("menuitem", { name: "Add to queue" })).toHaveCount(0);
  }
}

/** Whether the queue can be opened at the current width. */
async function queueIsReachable(page: Page) {
  const upNext = page.locator('[aria-label="Up next"]:visible').first();
  if (await upNext.isVisible().catch(() => false)) return true;
  // Below `sm` the only route left is the full player, and the full player
  // only exists while something is playing.
  return page
    .locator('[aria-label="Expand player"]')
    .first()
    .isVisible()
    .catch(() => false);
}

/** Puts both fixture tracks in the queue and opens the panel. */
async function openQueueWithTracks(page: Page) {
  await enqueueFixtureTracks(page);
  await clickUpNext(page);
  const queue = page.getByRole("dialog", { name: "Queue" });
  await expect(queue).toBeVisible();
  return queue;
}

/**
 * Opens the queue from wherever the control currently lives.
 *
 * Above `sm` both the bar and the mini player carry an "Up next" button. Below
 * it both hide theirs, because a 390px-wide row of transport controls has no
 * room for a sixth icon, and the queue is reachable from the full player
 * instead. Reaching for the button directly therefore times out on a phone
 * for a reason that has nothing to do with the queue.
 */
async function clickUpNext(page: Page) {
  const visible = page.locator('[aria-label="Up next"]:visible').first();
  if (await visible.isVisible().catch(() => false)) {
    await visible.click();
    return;
  }
  await page.getByRole("button", { name: "Expand player" }).click();
  await page.locator('[role="dialog"][aria-modal="true"] [aria-label="Up next"]').click();
}

authTest("a library row menu is whole, on top, and inside the viewport", async ({ pageA }) => {
  await pageA.goto("/e2e-library");
  await pageA.getByRole("button", { name: `Actions for ${TRACK_TWO}` }).click();

  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();
  expectHealthy(await auditMenu(pageA, MENU_ACTIONS), "library row");
  await expectItemsReachable(pageA, MENU_ACTIONS, "library row");
});

authTest("the last row in the list still opens its menu whole", async ({ pageA }) => {
  // The last row is the worst case: the most room above it and the least
  // below. A menu that only works on the rows near the top is a menu that
  // works until it matters.
  await pageA.goto("/e2e-library");
  await pageA.getByRole("button", { name: /^Actions for / }).last().click();

  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();
  expectHealthy(await auditMenu(pageA, MENU_ACTIONS), "last library row");
});

authTest("a queue row menu escapes the queue's own scroller", async ({ pageA }) => {
  const queue = await openQueueWithTracks(pageA);
  await queue.getByRole("button", { name: /^Actions for / }).last().click();

  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();
  const audit = await auditMenu(pageA, MENU_ACTIONS);

  // The scroller is the whole reason this surface cannot be painted inside
  // the row it belongs to: the row menu is ~200px tall and the list is
  // shorter than that on a phone, so flipping cannot rescue it.
  expect(
    audit.inScrollContainer,
    "the surface is still inside the scroller it has to escape",
  ).toBe(false);

  expectHealthy(audit, "queue row");
  await expectItemsReachable(pageA, MENU_ACTIONS, "queue row");
});

authTest("the queue row menu left the list but not the panel", async ({ pageA }) => {
  // It escaped the scroller; it must not have escaped the dialog. A menu
  // portaled to <body> would drop out of the panel's focus trap and paint
  // behind the queue's own rows at every width.
  const queue = await openQueueWithTracks(pageA);
  await queue.getByRole("button", { name: /^Actions for / }).first().click();
  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();

  const insidePanel = await pageA.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    const panel = document.querySelector('[role="dialog"][aria-label="Queue"]');
    return !!menu && !!panel && panel.contains(menu);
  });
  expect(insidePanel).toBe(true);
});

authTest("the playlist picker, the tallest thing in the slot, is whole too", async ({ pageA }) => {
  const queue = await openQueueWithTracks(pageA);
  await queue.getByRole("button", { name: /^Actions for / }).last().click();
  await pageA.getByRole("menuitem", { name: MENU_PICKER }).click();

  await expect(pageA.getByRole("menu", { name: MENU_PICKER })).toBeVisible();
  expectHealthy(await auditMenu(pageA, MENU_PICKER), "playlist picker");
});

authTest("a click elsewhere in the queue dismisses the row menu", async ({ pageA }) => {
  const queue = await openQueueWithTracks(pageA);
  await queue.getByRole("button", { name: /^Actions for / }).first().click();
  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();

  // A row's own text: inside the panel, well away from the surface, and not
  // a control whose own behaviour could be mistaken for the dismissal.
  await queue.getByRole("listitem").first().locator("p").first().click();

  await expect(pageA.getByRole("menu")).toHaveCount(0);
  await expect(queue).toBeVisible();
});

authTest("Escape dismisses the row menu, returns focus, and leaves the panel open", async ({ pageA }) => {
  const queue = await openQueueWithTracks(pageA);
  const trigger = queue.getByRole("button", { name: /^Actions for / }).first();
  await trigger.click();
  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();

  await pageA.keyboard.press("Escape");
  await expect(pageA.getByRole("menu")).toHaveCount(0);
  await expect(queue).toBeVisible();
  await expect(trigger).toBeFocused();
});

authTest("scrolling the queue does not leave the menu floating", async ({ pageA }, testInfo) => {
  const queue = await openQueueWithTracks(pageA);
  const scroller = queue.locator(".overflow-y-auto");

  const scrollable = await scroller.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight + 1);
  // Honest about what ran: with two fixture tracks the list does not scroll,
  // and a dismissal test that measured nothing would pass for the wrong
  // reason. The geometry tests above do not depend on this one.
  testInfo.skip(!scrollable, "the fixture queue is not tall enough to scroll");

  await queue.getByRole("button", { name: /^Actions for / }).first().click();
  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();

  await scroller.evaluate((el: HTMLElement) => el.scrollBy(0, 40));
  await expect(pageA.getByRole("menu")).toHaveCount(0);
});

authTest("a queue row menu is whole on a phone-width sheet", async ({ pageA }, testInfo) => {
  // Below `lg` the queue is a modal bottom sheet anchored 9rem above the
  // bottom of the screen: the tightest vertical room any menu in this product
  // gets, and a sheet that still scrolls.
  await pageA.setViewportSize(PHONE);
  await enqueueFixtureTracks(pageA);

  // Below `sm` neither the bar nor the mini player shows an "Up next" button,
  // and the mini player only exists while something is playing - so with
  // unplayable fixtures the sheet is genuinely unreachable, not merely
  // awkward to open. Stated rather than worked around: a geometry claim about
  // a surface that could not be opened would be worth nothing.
  testInfo.skip(
    !(await queueIsReachable(pageA)),
    "the queue needs a playing track to be reachable below sm, and the fixture tracks are not playable",
  );

  await clickUpNext(pageA);
  const queue = pageA.getByRole("dialog", { name: "Queue" });
  await expect(queue).toBeVisible();
  await queue.getByRole("button", { name: /^Actions for / }).last().click();

  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();
  expectHealthy(await auditMenu(pageA, MENU_ACTIONS), "phone queue row");
});

authTest("a library row menu is whole on a phone-width list", async ({ pageA }) => {
  await pageA.setViewportSize(PHONE);
  await pageA.goto("/e2e-library");
  await pageA.getByRole("button", { name: `Actions for ${TRACK_TWO}` }).click();

  await expect(pageA.getByRole("menu", { name: MENU_ACTIONS })).toBeVisible();
  expectHealthy(await auditMenu(pageA, MENU_ACTIONS), "phone library row");
});
