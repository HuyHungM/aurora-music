/**
 * Autoplay control — placement, states and layout (the icon bugfix).
 *
 * Real browser, real session, real server. The unit suite proves the control
 * renders the right semantics; this file proves the things only a laid-out
 * page can answer:
 *
 *  - the control is REACHABLE at every width in the project's responsive range
 *    — in the player bar where the bar is shown, and in the full player where
 *    it is not, because the bar is `hidden lg:flex` and a control that only
 *    existed above 1024px would be unreachable on a phone;
 *  - it does not CLIP or overflow at any of those widths;
 *  - the touch target is at least 40px everywhere it is rendered;
 *  - the OFF and ON states differ by more than colour, and the tooltip and
 *    accessible name follow the state;
 *  - the queue panel offers the same control, not a second dialect.
 *
 * No pixel-diff assertions: a screenshot comparison breaks on font metrics
 * and would fail for reasons that have nothing to do with this control. The
 * screenshot is taken for a human to look at, and the assertions are on
 * geometry, semantics and computed style.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/**
 * The project's responsive range. 360/390/412 are the phone widths the design
 * was checked at, 768 the tablet, 1024 the `lg` breakpoint where the player
 * bar appears, and 1280/1440/1920 the desktop widths.
 */
const WIDTHS = [360, 390, 412, 768, 1024, 1280, 1440, 1920];

/** Below `lg` the player bar is `hidden`, so the control lives in the full player. */
const BAR_VISIBLE_FROM = 1024;

const autoplay = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /autoplay/i });

const bar = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Player bar" });

const queueDialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Queue" });

/**
 * Puts a real queue in place through real controls. Playback resolution is
 * expected to fail for fixture ids, so nothing here asserts audio — only that
 * the queue exists, which is what the continuation control acts on.
 */
async function startQueue(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-library");
  await expect(page.getByRole("heading", { name: "E2E fixture library" })).toBeVisible();
  await page.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();
  await page.getByRole("button", { name: `Actions for ${TRACK_TWO}` }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect(page.getByRole("menuitem", { name: "Add to queue" })).toHaveCount(0);
}

/** Opens whichever player surface owns the control at the current width. */
async function revealAutoplay(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const dialog = page.getByRole("dialog", { name: "Now playing" });

  if (width >= BAR_VISIBLE_FROM) {
    // The full player is `lg:hidden`, so above the breakpoint the bar owns the
    // control — but a dialog opened at a narrower width is still open, and it
    // sits over the bar. Leaving it there would test a control the listener
    // cannot actually reach.
    if (await dialog.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    await expect(bar(page)).toBeVisible();
    return;
  }

  // The mini player is the mobile transport; its expand affordance opens the
  // full player, which carries the same control. Already open from the
  // previous width in the loop.
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Expand player" }).click();
  }
  await expect(dialog).toBeVisible();
}

authTest.describe("autoplay control", () => {
  authTest("is reachable, unclipped and thumb-sized at every supported width", async ({
    pageA,
  }) => {
    await startQueue(pageA);

    for (const width of WIDTHS) {
      await revealAutoplay(pageA, width);
      const control = autoplay(pageA);
      await expect(control, `no autoplay control at ${width}px`).toBeVisible();

      const box = await control.boundingBox();
      expect(box, `no box at ${width}px`).not.toBeNull();
      // 40px is the project's own floor (WCAG 2.2 AA target minimum).
      expect(box!.width, `too narrow at ${width}px`).toBeGreaterThanOrEqual(40);
      expect(box!.height, `too short at ${width}px`).toBeGreaterThanOrEqual(40);

      // Fully inside the viewport, with room to spare: a control clipped by
      // its own bar is unusable and a screenshot would be the only clue.
      expect(box!.x, `clipped left at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box!.y, `clipped top at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(
        box!.x + box!.width,
        `clipped right at ${width}px`,
      ).toBeLessThanOrEqual(width);

      await pageA.screenshot({
        path: `test-results/autoplay-${width}.png`,
        fullPage: false,
      });
    }
  });

  authTest("reads OFF, then ON, and the two states differ by more than colour", async ({
    pageA,
  }) => {
    await startQueue(pageA);
    await revealAutoplay(pageA, 1280);
    const control = autoplay(pageA);

    // The state is ARRANGED, then asserted, rather than assumed. The fixture
    // preference persists between runs, so asserting "off" without putting it
    // into a known state first would be asserting the last run's luck.
    if ((await control.getAttribute("aria-pressed")) === "true") {
      await control.click();
    }
    await expect(control).toHaveAttribute("aria-pressed", "false");
    await expect(control).toHaveAttribute("aria-label", "Turn autoplay on");
    await expect(control).toHaveAttribute("title", "Autoplay: Off");

    // Park the pointer away from the control for the rest of the test. The
    // click below leaves it hovering, and a hover surface mixed into the
    // OFF/ON comparison would make the assertion pass for the wrong reason.
    await pageA.mouse.move(0, 0);
    const offBox = await control.boundingBox();
    const off = await control.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, shadow: s.boxShadow };
    });

    await control.click();

    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(control).toHaveAttribute("aria-label", "Turn autoplay off");
    await expect(control).toHaveAttribute("title", "Autoplay: On");
    const onBox = await control.boundingBox();
    const on = await control.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, shadow: s.boxShadow };
    });

    // Same control, same place: toggling must not move or resize the button.
    expect(onBox!.x).toBe(offBox!.x);
    expect(onBox!.y).toBe(offBox!.y);
    expect(onBox!.width).toBe(offBox!.width);

    // Not colour alone: the accent changes AND a ring appears, so the state
    // survives greyscale, high contrast and a future light theme.
    //
    // The two readings are already taken here, OFF before the click and ON
    // after, with the pointer never having moved: the click is a programmatic
    // activation, so `:hover` cannot be what separates them, and the ring can
    // only be the state.
    expect(on.color, "colour did not change").not.toBe(off.color);
    // Asserted on the accent layer rather than the whole computed value,
    // which also carries the UA's zero-alpha shadow layers.
    expect(on.shadow, "no accent ring while ON").toContain("oklab(");
    expect(off.shadow, "accent ring present while OFF").not.toContain("oklab(");

    // The state survives a reload: the preference is the account's, and the
    // control renders the coordinator, not a local copy that resets.
    await pageA.reload();
    await revealAutoplay(pageA, 1280);
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "true");

    // ...and back off again, so the fixture user is left as found.
    await autoplay(pageA).click();
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "false");
  });

  authTest("the queue panel offers the same control, not a second dialect", async ({
    pageA,
  }) => {
    await startQueue(pageA);
    await revealAutoplay(pageA, 1280);

    const inBar = autoplay(pageA);
    const barName = await inBar.getAttribute("aria-label");
    const barTitle = await inBar.getAttribute("title");
    const barPressed = await inBar.getAttribute("aria-pressed");
    const barGlyph = await inBar.locator("svg path").first().getAttribute("d");

    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialog = queueDialog(pageA);
    await expect(dialog).toBeVisible();

    // Exactly one, inside the panel — not a switch pill beside a decorative
    // icon, which is what this row used to be.
    const inPanel = dialog.getByRole("button", { name: /autoplay/i });
    await expect(inPanel).toHaveCount(1);

    // Same feature, same words, same glyph, same state.
    expect(await inPanel.getAttribute("aria-label")).toBe(barName);
    expect(await inPanel.getAttribute("title")).toBe(barTitle);
    expect(await inPanel.getAttribute("aria-pressed")).toBe(barPressed);
    expect(await inPanel.locator("svg path").first().getAttribute("d")).toBe(barGlyph);

    // And the panel says the state in words as well as colour, which is what
    // a greyscale or high-contrast reader has to go on. The expected word is
    // read from the control rather than assumed, because the fixture account's
    // preference persists between runs.
    const pressed = await inPanel.getAttribute("aria-pressed");
    await expect(dialog.getByText(pressed === "true" ? "On" : "Off", { exact: true })).toBeVisible();
  });

  authTest("is distinct from shuffle and repeat, which keep their own state", async ({
    pageA,
  }) => {
    await startQueue(pageA);
    await revealAutoplay(pageA, 1280);
    const controls = bar(pageA);
    await expect(controls).toBeVisible();

    const autoplayPaths = await autoplay(pageA).locator("svg path").evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("d")),
    );
    const shufflePaths = await controls
      .getByRole("button", { name: /shuffle/i })
      .locator("svg path")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d")));
    const repeatPaths = await controls
      .getByRole("button", { name: /repeat/i })
      .first()
      .locator("svg path")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d")));

    expect(autoplayPaths.length).toBeGreaterThan(0);
    expect(shufflePaths.length).toBeGreaterThan(0);
    expect(repeatPaths.length).toBeGreaterThan(0);
    expect(autoplayPaths.filter((d) => shufflePaths.includes(d!))).toEqual([]);
    expect(autoplayPaths.filter((d) => repeatPaths.includes(d!))).toEqual([]);

    // Three independent states, three independent controls. Toggling autoplay
    // must not touch repeat or shuffle, and each reports its own pressed
    // state.
    const repeat = controls.getByRole("button", { name: /repeat/i }).first();
    const shuffle = controls.getByRole("button", { name: /shuffle/i });
    // Repeat cycles off → all → one → off, so it is walked to OFF from
    // wherever it landed. The playback snapshot persists between runs, so
    // every state here is arranged rather than assumed.
    for (let i = 0; i < 3; i += 1) {
      if ((await repeat.getAttribute("aria-pressed")) === "true") {
        await repeat.click();
        await expect(repeat).not.toHaveAttribute("aria-pressed", "true");
      }
    }
    if ((await shuffle.getAttribute("aria-pressed")) === "true") {
      await shuffle.click();
      await expect(shuffle).toHaveAttribute("aria-pressed", "false");
    }
    if ((await autoplay(pageA).getAttribute("aria-pressed")) === "true") {
      await autoplay(pageA).click();
      await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "false");
    }
    await expect(repeat).toHaveAttribute("aria-pressed", "false");
    await expect(shuffle).toHaveAttribute("aria-pressed", "false");
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "false");

    await autoplay(pageA).click();
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "true");
    await expect(repeat).toHaveAttribute("aria-pressed", "false");
    await expect(shuffle).toHaveAttribute("aria-pressed", "false");

    await shuffle.click();
    await expect(shuffle).toHaveAttribute("aria-pressed", "true");
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "true");
    await expect(repeat).toHaveAttribute("aria-pressed", "false");

    // Leave the fixture user as found.
    await shuffle.click();
    await autoplay(pageA).click();
  });

  authTest("is reachable by keyboard, and never becomes a permanent spinner", async ({
    pageA,
  }) => {
    await startQueue(pageA);
    await revealAutoplay(pageA, 1280);
    const control = autoplay(pageA);

    // Tabbed to, not focused programmatically: Chromium only matches
    // `:focus-visible` for keyboard-driven focus, so `.focus()` would report
    // "no focus ring" for a control that has a perfectly good one.
    //
    // Focus starts from the top of the document so the search is a real
    // forward walk, and it gives up if the control is genuinely unreachable
    // rather than spinning for 40 tabs and reporting a misleading failure.
    await pageA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await pageA.locator("body").press("Tab");
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await pageA.keyboard.press("Tab");
      reached = await control.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "the control was not reachable by Tab").toBe(true);

    // A real focus indicator: an outline, a ring or a shadow. Which one is
    // `Button`'s business, not this test's — the assertion is that focusing it
    // changes the painted focus state at all.
    const focusPaint = await control.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
        ring: s.boxShadow !== "none" && s.boxShadow.includes("oklab("),
      };
    });
    expect(
      focusPaint.outline || focusPaint.ring,
      "focusing the control painted no focus indicator",
    ).toBe(true);

    // Arranged into OFF, because the fixture preference persists between runs
    // and the direction of each key press below is otherwise ambiguous.
    if ((await control.getAttribute("aria-pressed")) === "true") {
      await control.click();
    }
    await expect(control).toHaveAttribute("aria-pressed", "false");

    // Both activation keys drive the control, and the state is awaited after
    // each. The write is a server round trip and the control is disabled while
    // it is in flight, so a key pressed through the page during that window is
    // silently dropped — which reads as "the control ignores the keyboard"
    // while actually being a correct disabled button. Pressing through the
    // element, and waiting for it to be enabled again, keeps the two apart.
    const press = async (key: "Enter" | " ") => {
      await control.press(key);
      await expect(control).toBeEnabled();
    };
    await press("Enter");
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await press(" ");
    await expect(control).toHaveAttribute("aria-pressed", "false");

    // Nothing loops: the icon itself is never animated, and the generating
    // badge is absent whenever the coordinator is not generating.
    const spinning = await control.locator(".animate-spin").count();
    expect(spinning).toBe(0);
    const iconAnimated = await control.locator("svg").evaluate((el) =>
      getComputedStyle(el).animationName,
    );
    expect(["none", ""]).toContain(iconAnimated);
  });

  authTest("reflects the preference after a reload", async ({ pageA }) => {
    await startQueue(pageA);
    await revealAutoplay(pageA, 1280);

    // The persisted preference reaches the coordinator through a server round
    // trip that finishes long after mount, so a control that only listened for
    // "a coordinator appeared" would never learn the value. This is the
    // observable half of that: a reload must come back ON.
    // Arranged into a known state, because the preference persists.
    if ((await autoplay(pageA).getAttribute("aria-pressed")) === "true") {
      await autoplay(pageA).click();
    }
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "false");
    await autoplay(pageA).click();
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "true");

    await pageA.reload();
    await revealAutoplay(pageA, 1280);

    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "true");
    await expect(autoplay(pageA)).toHaveAttribute("aria-label", "Turn autoplay off");

    // Leave the fixture account as found.
    await autoplay(pageA).click();
    await expect(autoplay(pageA)).toHaveAttribute("aria-pressed", "false");
  });
});
