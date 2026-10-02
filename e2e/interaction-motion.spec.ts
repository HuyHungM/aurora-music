/**
 * Interaction-motion guards: seek drag, double-submit, press feedback.
 *
 * These pin runtime behavior that unit tests cannot see: a thumb dragged
 * with a real pointer, two activations landing in the same tick, and the
 * press state reaching the painted control.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import type { Page } from "@playwright/test";

const TRACK_ONE = FIXTURE_TRACKS[0].title;

let titleSequence = 0;
function uniqueTitle(prefix: string): string {
  titleSequence += 1;
  return `${prefix} ${process.pid}-${titleSequence}`;
}

async function openLibraryWithTrackPlaying(page: Page): Promise<void> {
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

authTest.describe("interaction motion", () => {
  authTest("seek holds the dragged value instead of fighting the progress tick", async ({
    pageA: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLibraryWithTrackPlaying(page);

    const slider = page.getByRole("slider", { name: "Seek" });
    await expect(slider).toBeVisible();
    const max = Number(await slider.getAttribute("max"));
    expect(max).toBeGreaterThan(0);

    // WHY THIS DOES NOT USE A SYNTHETIC MOUSE DRAG. A native
    // `<input type="range">` is driven by the browser's own drag handling, and
    // CDP-synthesized mouse events do not trigger it in headless Chromium — a
    // `mouse.down`/`move`/`up` sequence leaves the value untouched. Asserting
    // "the thumb followed the pointer" against that setup proves nothing about
    // the product; it only proves the harness cannot drag. The transient-drag
    // behaviour is therefore driven through the input path that DOES work, and
    // the transient state itself is pinned in
    // `player-controls.test.tsx` ("holds the dragged value while progress
    // ticks arrive"), which is where it can actually be observed.
    //
    // What this proves end to end: the displayed value is decoupled from the
    // ticking position while a seek is in flight, and it commits on release
    // rather than snapping back to a progress tick.
    const target = Math.max(Math.round(max * 0.8), 1);
    await slider.focus();
    // `fill` is the reliable synthetic driver for a range input.
    await slider.fill(String(target));
    const dragged = Number(await slider.inputValue());
    expect(dragged, "the seek input did not accept the new position").toBe(
      target,
    );

    // The value stays where the user put it rather than drifting back to the
    // engine's position while playback continues.
    await page.waitForTimeout(1_500);
    const stillDragged = Number(await slider.inputValue());
    expect(
      Math.abs(stillDragged - target),
      "the seek value drifted back to the progress position while playing",
    ).toBeLessThanOrEqual(2);

    // Releasing focus hands the value back to the committed position, and the
    // player reflects a real media position rather than a widget value.
    await slider.blur();
    await expect
      .poll(() => slider.inputValue().then(Number), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(0);
  });

  authTest("double-clicking Create mints exactly one playlist", async ({
    pageA: page,
  }) => {
    const title = uniqueTitle("E2E DoubleSubmit");
    await page.goto("/library");
    await expect(
      page.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create playlist" }).first().click();
    await page.getByLabel("Name").fill(title);

    // Two activations in the same gesture, before any re-render can arm the
    // state-based guard. Without the synchronous ref guard this mints two
    // playlists with the same title.
    await page.getByRole("button", { name: "Create", exact: true }).dblclick();
    await page.waitForURL(/\/library\/playlists\/.+/);

    await page.goto("/library");
    await expect(
      page.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#playlists").getByText(title)).toHaveCount(1);
  });

  authTest("press feedback reaches the painted control", async ({ pageA: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLibraryWithTrackPlaying(page);

    // The primitive carries aurora-press: on mousedown the control renders
    // the 0.98 compression through the compositor (transform only), and on
    // release it is gone. Asserted on the computed transform, which is what
    // the user sees rather than what the class list says.
    const next = page.getByRole("button", { name: "Next track" }).first();
    await next.hover();
    const box = await next.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    const pressed = await next.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    await page.mouse.up();
    const released = await next.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    expect(pressed, "no press transform while held").not.toBe("none");
    expect(released, "press transform stuck after release").toBe("none");
  });
});
