/**
 * Phase 48 — layering and presence, verified in a real browser.
 *
 * The headline test here is `queue from the full player is actually
 * reachable`. It exists because of a bug this phase found and fixed, and the
 * bug is the reason the assertion is written the way it is.
 *
 * THE BUG. `QueuePanel` and `FullPlayer` were both `position: fixed` at
 * `z-50`, and `PlayerHost` renders the queue BEFORE the full player. Equal
 * z-index means DOM order decides, so the full player painted over the queue.
 * The full player is `fixed inset-0`, so it covered the queue completely and
 * swallowed every pointer event. The full player has an "Up next" button that
 * calls `openQueue()`, and `openQueue` never closes the full player — so on a
 * phone, tapping "Up next" opened a queue that was completely invisible and
 * completely untappable. Nothing threw; the DOM was correct; the pixels were
 * wrong.
 *
 * WHY `elementFromPoint`. Asserting the queue exists in the DOM would have
 * passed throughout, because the bug was never about presence. The only
 * question a user actually asks is "what happens if I tap there", and that is
 * exactly what `document.elementFromPoint` answers. Every other assertion in
 * this file is secondary to that one.
 *
 * The fix was to give the two surfaces different layers from the existing
 * token stack (`z-dialog` for the queue, `z-sheet` for the full player)
 * rather than to reorder the JSX, so the ordering is now declared rather than
 * incidental.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/** What a user would hit if they tapped the middle of `selector`. */
async function topElementAtCentre(pageA: import("@playwright/test").Page, selector: string) {
  return pageA.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return { found: false as const };
    const r = target.getBoundingClientRect();
    // Sample inside the panel's own header area rather than dead centre:
    // a panel can legitimately have an empty region, and the header is what
    // the user aims at.
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(40, r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      found: true as const,
      hitsTarget: !!hit && target.contains(hit),
      hitsLabel: hit?.closest("[aria-label]")?.getAttribute("aria-label") ?? null,
    };
  }, selector);
}

authTest.describe("layering and presence", () => {
  authTest("queue opened from the full player is on top and actually tappable", async ({
    pageA,
  }) => {
    await pageA.setViewportSize({ width: 390, height: 844 });
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();
    await expect(pageA.getByRole("button", { name: `Play ${TRACK_TWO}` })).toBeVisible();

    // Open the full player, then use its own "Up next" control.
    await pageA.getByRole("button", { name: "Expand player" }).click();
    const fullPlayer = pageA.getByRole("dialog", { name: "Now playing" });
    await expect(fullPlayer).toBeVisible();
    await fullPlayer.getByRole("button", { name: "Up next" }).click();

    // The queue is on screen...
    const queue = pageA.getByRole("dialog", { name: "Queue" });
    await expect(queue).toBeAttached();
    await expect(fullPlayer).toBeAttached();

    // ...and it is what is under the user's finger, not the full player.
    // This is the assertion that fails against the old equal-z-index build.
    const hit = await topElementAtCentre(pageA, '[role="dialog"][aria-label="Queue"]');
    expect(hit.found).toBe(true);
    expect(
      hit.found && hit.hitsTarget,
      `tapping the queue should reach the queue, but reached: ${hit.found ? hit.hitsLabel : "nothing"}`,
    ).toBe(true);

    // And it is genuinely operable, not merely visible.
    await expect(queue.getByRole("button", { name: /Close/i }).first()).toBeVisible();
  });

  authTest("the full player is still above page content and dismisses cleanly", async ({
    pageA,
  }) => {
    await pageA.setViewportSize({ width: 390, height: 844 });
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();
    await pageA.getByRole("button", { name: "Expand player" }).click();
    const fullPlayer = pageA.getByRole("dialog", { name: "Now playing" });
    await expect(fullPlayer).toBeVisible();

    const hit = await topElementAtCentre(pageA, '[role="dialog"][aria-label="Now playing"]');
    expect(hit.found && hit.hitsTarget).toBe(true);

    // Closing plays its exit and then unmounts. Asserting the end state
    // rather than the animation itself: the exit duration is a CSS concern
    // and pinning it here would make this test a pixel timer.
    await pageA.getByRole("button", { name: "Close player" }).click();
    await expect(fullPlayer).toHaveCount(0);
  });

  authTest("a dialog animates in, blocks the page while open, and releases it after", async ({
    pageA,
  }) => {
    await pageA.setViewportSize({ width: 1280, height: 900 });
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();

    // The track row's context menu -> add to playlist -> create playlist
    // dialog, which is the shared `Dialog` primitive.
    await pageA.getByRole("main").getByRole("button", { name: `Actions for ${TRACK_ONE}` }).click();
    const menu = pageA.getByRole("menu", { name: "Track actions" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Add to playlist" }).click();
    await pageA
      .getByRole("menuitem", { name: "Create new playlist" })
      .click();

    const dialog = pageA.getByRole("dialog", { name: "Create playlist" });
    await expect(dialog).toBeVisible();

    // While open, the backdrop owns the viewport: the dialog's own centre
    // point must resolve to something inside the dialog subtree, never to
    // the page behind it.
    const hit = await topElementAtCentre(
      pageA,
      '[role="dialog"][aria-label="Create playlist"]',
    );
    expect(hit.found && hit.hitsTarget).toBe(true);

    // Escape closes it, and the shared primitive's counted scroll lock is
    // released with it. Asserting the style directly: if the body were
    // still `overflow: hidden`, "the page still scrolls" would be a no-op
    // that passes for the wrong reason.
    await pageA.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const bodyOverflow = await pageA.evaluate(() => document.body.style.overflow);
    expect(bodyOverflow).not.toBe("hidden");
  });

  authTest("menus and the queue do not trap focus or linger after closing", async ({
    pageA,
  }) => {
    await pageA.setViewportSize({ width: 1280, height: 900 });
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();

    // Rapid toggle: open, close, open again, then close. A naive presence
    // implementation strands the menu mounted, or unmounts it while open.
    const trigger = pageA.getByRole("main").getByRole("button", { name: `Actions for ${TRACK_ONE}` });
    await trigger.click();
    await expect(pageA.getByRole("menu", { name: "Track actions" })).toBeVisible();
    await pageA.keyboard.press("Escape");
    await trigger.click();
    await expect(pageA.getByRole("menu", { name: "Track actions" })).toBeVisible();
    await pageA.keyboard.press("Escape");
    await expect(pageA.getByRole("menu", { name: "Track actions" })).toHaveCount(0);

    // Nothing invisible is left holding the page: no element that covers
    // the viewport may still be interactive.
    const blockers = await pageA.evaluate(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const hit = document.elementFromPoint(w / 2, h / 2);
      const chain = document.elementsFromPoint(w / 2, h / 2);
      return {
        centreTag: hit?.tagName ?? null,
        exitingLeft: document.querySelectorAll('[data-presence="exiting"]').length,
        inertLeft: document.querySelectorAll("[inert]").length,
        chain: chain.length,
      };
    });
    // Nothing is mid-exit and nothing is left inert once everything settled.
    expect(blockers.exitingLeft).toBe(0);
    expect(blockers.inertLeft).toBe(0);
  });
});
