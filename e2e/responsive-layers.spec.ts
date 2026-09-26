/**
 * Phase 48 — responsive and localised layout guards.
 *
 * §40 requires every positioned component to be checked at 360/390/412/
 * 768/820/1024/1280/1440/1920, and §42 requires both `vi` and `en` because
 * translated text changes the dimensions everything else is measured
 * against. Those are not the kind of requirements a screenshot catches: the
 * failures are silent, sub-pixel-ish, and only appear at one or two widths.
 * So they are asserted numerically here, in a loop, on every run.
 *
 * WHAT IS ASSERTED, AND WHY THESE THINGS
 *
 * 1. No horizontal overflow. Fixed elements that reach the right edge, and
 *    the `w-[calc(100vw-2rem)]` style full-width panels, are where a
 *    viewport-width mistake shows up first.
 *
 * 2. The bottom stack is ordered. The bottom navigation owns the viewport
 *    bottom on mobile; the mini player sits directly on top of it. These are
 *    two `fixed` elements with no common parent, so nothing but geometry
 *    keeps them from overlapping — and when they did overlap, the player
 *    covered the navigation's top 34px including its border.
 *
 * 3. Content can be scrolled clear of the player. This is the one that
 *    catches a forgotten bottom padding. The measurement scrolls to the very
 *    bottom and then asks whether the last content element's bottom edge is
 *    above the player's top edge — i.e. whether the user can actually see it.
 *    A container taller than the viewport makes this non-trivial, which is
 *    the point: it is the real question, not "is the padding big enough".
 *
 * EVERY SELECTOR HERE IS CHOSEN NOT TO DEPEND ON THE LOCALE, and that is
 * not tidiness — it is a bug this file already had. `role="region"` and
 * `nav`-outside-an-`aside` are structural; the obvious alternatives
 * (`getByRole("region", { name: "Mini player" })`,
 * `nav[aria-label="Main navigation"]`) are not, and both bite:
 *
 *   - The player's accessible name is translated, so a locale test that
 *     measures by name cannot find the thing it is measuring.
 *   - `NavList` renders its OWN `<nav aria-label={t("nav.main")}>`, so the
 *     sidebar's navigation and the bottom navigation carry the same label.
 *     A naive `querySelector` returns the sidebar's, which is `display:none`
 *     on mobile and therefore reports the bottom navigation as missing at
 *     every mobile width.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import type { Page } from "@playwright/test";

const TRACK_ONE = FIXTURE_TRACKS[0].title;

/** The nine widths the mission requires every surface to be checked at. */
const WIDTHS = [360, 390, 412, 768, 820, 1024, 1280, 1440, 1920];

/** Tailwind's `lg` breakpoint, where the shell swaps player chrome. */
const LG = 1024;

/**
 * The one visible player surface, and the bottom navigation.
 *
 * `MiniPlayer` and `PlayerBar` are the only `role="region"` elements in the
 * app and they are mutually exclusive across the `lg` breakpoint, so exactly
 * one is ever laid out. The bottom navigation is the visible `<nav>` that is
 * NOT inside the sidebar's `<aside>`.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const laidOut = (el: Element) => {
      const r = el.getBoundingClientRect();
      // Tailwind `display:none` yields a zero rect.
      return r.width > 0 || r.height > 0;
    };

    const regions = Array.from(
      document.querySelectorAll('[role="region"]'),
    ).filter(laidOut);

    const navs = Array.from(document.querySelectorAll("nav")).filter(
      (el) =>
        laidOut(el) &&
        // Not the sidebar's.
        !el.closest("aside") &&
        // Not a nested one. `app-shell` wraps `<NavList>` in a `<nav>`, and
        // `NavList` renders its own `<nav>`; both carry `t("nav.main")`, the
        // inner one is laid out, and counting without this reports two
        // navigations on mobile when there is one.
        !el.parentElement?.closest("nav"),
    );

    const main = document.querySelector("main");
    const lastContent = main?.lastElementChild ?? null;

    // Scroll to the very end so the bottom padding is actually exercised.
    window.scrollTo(0, document.body.scrollHeight);

    const top = (el: Element | undefined) =>
      el ? el.getBoundingClientRect().top : null;

    const doc = document.documentElement;
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      /** How many player surfaces are laid out. Must be exactly one. */
      playerSurfaces: regions.length,
      playerTop: top(regions[0]),
      playerHeight: regions[0]?.getBoundingClientRect().height ?? 0,
      navCount: navs.length,
      navTop: top(navs[0]),
      navHeight: navs[0]?.getBoundingClientRect().height ?? 0,
      lastContentBottom: lastContent
        ? lastContent.getBoundingClientRect().bottom
        : Number.NaN,
    };
  });
}

async function openLibraryWithTrackPlaying(page: Page) {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: `Play ${TRACK_ONE}` })
    .click();
  // The player only mounts once something is playing, so this is the
  // precondition for every measurement below.
  await expect(page.locator('[role="region"]')).toHaveCount(2);
}

/**
 * The language the app is actually running in, read from a translated string.
 *
 * Probed rather than assumed because the locale is SHARED MUTABLE STATE. The
 * E2E user is a single database row, and `getRequestLocale` resolves the
 * authenticated account's saved preference FIRST — ahead of the cookie, ahead
 * of the default. So the language switcher writes a durable preference, and a
 * test that switches language and fails before switching back leaves every
 * later test rendering in the wrong language. Which is exactly what happened
 * while writing this file: a later test timed out on
 * `getByRole("button", { name: "Play Aurora E2E Track One" })` — a locator
 * that looks correct and is, in English.
 *
 * The switcher's own `aria-label` is a translated string, so it is a probe
 * that works in either language and needs no hardcoded expectation elsewhere.
 */
async function activeLanguage(page: Page): Promise<string> {
  // Scoped to whichever switcher is actually LAID OUT, not to the banner and
  // not to a specific one. Both the header and the sidebar render a
  // `LocaleSwitcher`, and Phase 54 made the header's compact copy `lg:hidden`
  // precisely because the sidebar footer already carries the full one from
  // `lg` up — two identical controls in the busiest region of the shell at
  // once is a defect. So the visible control is the header's below `lg` and
  // the sidebar's at `lg` and above, and the probe follows whichever it is.
  //
  // The two earlier ways of writing this were both wrong in a way that only
  // showed up at one end of the range: `.first()` picked the sidebar's copy,
  // which is in the DOM but unclickable below `lg` (the aside is
  // `hidden lg:flex`, and it precedes the header in the source), and scoping
  // to the banner found nothing at all once the header's copy was hidden.
  return (await page
    .locator('[data-testid="locale-switcher"]:visible')
    .getAttribute("aria-label")) ?? "";
}

async function setLanguage(page: Page, option: "en" | "vi") {
  await page.locator('[data-testid="locale-switcher"]:visible').click();
  // Both switchers render their own full list of options, so this one DOES
  // need `:visible` — only the copy inside the dropdown that was just opened
  // is laid out.
  const target = page.locator(`[data-testid="locale-option-${option}"]:visible`);
  await expect(target).toBeVisible();
  await target.click();
  // Switching is instant by design (cookie written synchronously, server
  // parts refreshed, no reload) — assert it closed rather than sleeping.
  await expect(target).toHaveCount(0);
}

authTest.describe("responsive layout and the player stack", () => {
  /*
   * Repair the inherited locale before every test. Costs one navigation and
   * makes each test independent of whatever a locale test left behind, rather
   * than letting a contaminated account surface as an unrelated timeout three
   * tests later.
   */
  authTest.beforeEach(async ({ pageA }) => {
    await pageA.goto("/e2e-library");
    if ((await activeLanguage(pageA)) !== "Language") {
      await setLanguage(pageA, "en");
    }
    expect(
      await activeLanguage(pageA),
      "could not restore English; a later test would fail for the wrong reason",
    ).toBe("Language");
  });

  for (const width of WIDTHS) {
    authTest(`${width}px: no overflow, ordered bottom stack, reachable content`, async ({
      pageA,
    }) => {
      await pageA.setViewportSize({ width, height: 900 });
      await openLibraryWithTrackPlaying(pageA);

      const m = await measure(pageA);
      const isDesktop = width >= LG;

      expect(
        m.overflowX,
        `${width}px: content overflows horizontally by ${m.overflowX}px`,
      ).toBeLessThanOrEqual(0);

      // Never two player surfaces at once: the bar is `hidden lg:flex` and
      // the mini player is `lg:hidden`, so the breakpoint swaps them. Two at
      // a time would mean two competing stacks over the content.
      expect(
        m.playerSurfaces,
        `${width}px: expected exactly one player surface`,
      ).toBe(1);

      if (isDesktop) {
        expect(
          m.navCount,
          `${width}px: bottom navigation should be gone on desktop`,
        ).toBe(0);
      } else {
        expect(
          m.navCount,
          `${width}px: bottom navigation missing`,
        ).toBe(1);

        // The two are siblings pinned to the same edge, so geometry is the
        // only thing keeping them apart. The mini player's bottom must be
        // at or above the navigation's top — the check that would have
        // caught it painting over the navigation's top 34px.
        expect(
          m.playerTop! + m.playerHeight,
          `${width}px: the player overlaps the bottom navigation by ${Math.round(
            m.playerTop! + m.playerHeight - m.navTop!,
          )}px`,
        ).toBeLessThanOrEqual(m.navTop! + 1);
      }

      expect(
        m.lastContentBottom,
        `${width}px: content is hidden behind the player`,
      ).toBeLessThanOrEqual(m.playerTop! + 1);
    });
  }

  authTest("Vietnamese copy does not break the layout the English copy fits", async ({
    pageA,
  }) => {
    // §42. Vietnamese is the long case: it is what actually exposes a
    // truncation or wrapping bug that `en` hides, because the strings are
    // longer and the diacritics change measured widths.
    //
    // Playback is started FIRST, while the app is still English. The obvious
    // arrangement — switch, then re-load the library at each width — cannot
    // work: `openLibraryWithTrackPlaying` locates the play button by its
    // English accessible name ("Play <track>"), which does not exist in
    // Vietnamese ("Phát <track>"), so it times out on a locator that is
    // correct in the language the test just left. Switching does not reload,
    // and playback lives in a store rather than in the component tree, so the
    // player stays mounted and resizing alone is enough to change the layout.
    await openLibraryWithTrackPlaying(pageA);

    try {
      await setLanguage(pageA, "vi");
      expect(await activeLanguage(pageA)).not.toBe("Language");

      for (const width of [360, 412, 820, 1440]) {
        await pageA.setViewportSize({ width, height: 900 });

        const m = await measure(pageA);
        expect(
          m.overflowX,
          `vi @ ${width}px: horizontal overflow of ${m.overflowX}px`,
        ).toBeLessThanOrEqual(0);
        expect(
          m.playerSurfaces,
          `vi @ ${width}px: expected exactly one player surface`,
        ).toBe(1);
        expect(
          m.lastContentBottom,
          `vi @ ${width}px: content is hidden behind the player`,
        ).toBeLessThanOrEqual(m.playerTop! + 1);
      }
    } finally {
      // Unconditional, and that is the whole point. A `finally` after the
      // loop — or no restore at all — is what leaked Vietnamese into the
      // shared account the first time this test was written, and the
      // resulting failures pointed at locators in unrelated tests.
      await setLanguage(pageA, "en");
      expect(await activeLanguage(pageA)).toBe("Language");
    }
  });

  authTest("the queue panel stays inside the viewport at every mobile width", async ({
    pageA,
  }) => {
    // The queue is a `fixed` panel with a viewport-relative width and a
    // viewport-relative bottom offset that has to clear BOTH the mini player
    // and the navigation. It is the easiest surface in the app to push off
    // screen, and the easiest to push behind the player.
    for (const width of [360, 390, 412]) {
      await pageA.setViewportSize({ width, height: 844 });
      await openLibraryWithTrackPlaying(pageA);

      // Below `sm` the "Up next" control lives in the FULL PLAYER, not the
      // player bar (Phase 54). The player bar is `hidden lg:flex` and the
      // mini player carries no queue control at phone widths, so the full
      // player is opened first and the queue is opened from inside it. This
      // used to be a single `click()` on a button that is no longer rendered
      // here, which is why the spec could not find it.
      await pageA.locator('[aria-label="Expand player"]:visible').first().click();
      const fullPlayer = pageA.locator('[role="dialog"][aria-modal="true"]');
      await expect(fullPlayer).toBeVisible();
      await fullPlayer.locator('[aria-label="Up next"]').click();

      const queue = pageA.getByRole("dialog", { name: "Queue" });
      await expect(queue).toBeVisible();

      const box = (await queue.boundingBox())!;
      const viewport = pageA.viewportSize()!;
      expect(
        box.x,
        `${width}px: queue starts off-screen to the left`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        box.x + box.width,
        `${width}px: queue overflows the right edge`,
      ).toBeLessThanOrEqual(viewport.width + 1);
      expect(
        box.y + box.height,
        `${width}px: queue overflows the bottom edge`,
      ).toBeLessThanOrEqual(viewport.height + 1);

      // And it must clear the player chrome, not tuck under it.
      const m = await measure(pageA);
      expect(
        box.y + box.height,
        `${width}px: queue runs under the player`,
      ).toBeLessThanOrEqual(m.playerTop! + 1);
    }
  });
});
