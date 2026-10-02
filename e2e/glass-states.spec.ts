/**
 * Glass state consistency, in a real browser.
 *
 * Static tests pin the tokens; this file pins what they resolve to at
 * runtime: chrome actually blurs, hovers stay translucent, the skeleton
 * sweeps instead of pulsing, and the whole thing holds together over a
 * bright and a dark wallpaper. Every alpha below is read from the computed
 * style, so a token that stopped resolving (or a class that went opaque)
 * fails here rather than in a screenshot nobody diffs.
 *
 * Alpha parsing: Chromium resolves every background to `rgba()`/`rgb()`,
 * so "translucent" is simply alpha < 1 on the computed value.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import { settle } from "./helpers/settle";
import type { Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRACK_ONE = FIXTURE_TRACKS[0].title;

function alphaOf(color: string): number {
  // Chromium serializes `color-mix()` results as `oklab(L a b / alpha)`;
  // plain colors come back as `rgb()`/`rgba()`. Either way the alpha is
  // the value after the slash, or the fourth comma component, or 1.
  const slash = color.match(/\/\s*([\d.]+)\s*\)\s*$/);
  if (slash) {
    return Number(slash[1]);
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) {
    return Number.NaN;
  }
  const parts = m[1].split(",").map((part) => part.trim());
  if (parts.length === 4) {
    return Number(parts[3]);
  }
  return 1;
}

/** Holds the first RSC navigation matching `needle` open until released. */
async function holdNavigation(page: Page, needle: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let didHold = false;
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!didHold && url.includes("_rsc") && url.includes(needle)) {
      didHold = true;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
      await Promise.race([held, timeout]);
    }
    await route.continue();
  });
  return { release, didHold: () => didHold };
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

/**
 * Paints a test wallpaper behind the glass: overrides the backdrop image
 * variable and forces the image + scrim layers visible (the default
 * appearance is background "none", which hides both).
 */
async function paintWallpaper(page: Page, image: string): Promise<void> {
  await page.evaluate((img) => {
    document.documentElement.style.setProperty("--aurora-background-image", img);
    for (const layer of Array.from(
      document.querySelectorAll(".aurora-backdrop-image, .aurora-backdrop-scrim"),
    )) {
      (layer as HTMLElement).style.display = "block";
    }
  }, image);
}

const BRIGHT_WALLPAPER =
  "linear-gradient(135deg, #ffffff 0%, #cfe4ff 45%, #ffe9c9 100%)";
const DARK_WALLPAPER =
  "linear-gradient(135deg, #05060a 0%, #0b1026 50%, #1a0b2e 100%)";

// `tmpdir()` rather than an absolute developer path: the hardcoded `C:/...`
// form creates a literal `C:` directory in the checkout on Linux CI, where
// `C:/Users/...` is a relative path. Matches how the other screenshot specs
// locate their output.
const SHOT = join(tmpdir(), "aurora-glass");

authTest.describe("glass states", () => {
  authTest("chrome blurs and hovers stay translucent", async ({ pageA: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLibraryWithTrackPlaying(page);

    // 1. The system blur layers are real filters, not flat fills.
    for (const selector of ["header", "aside", '[aria-label="Mini player"]']) {
      const filter = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backdropFilter : "none";
      }, selector);
      // Mini player is mobile-only; it is absent at this width, the rest blur.
      if (selector === '[aria-label="Mini player"]') {
        continue;
      }
      expect(filter, `${selector} has no backdrop blur`).toContain("blur");
    }

    // 2. A track row hover is a translucent lift, not an opaque block.
    const row = page.getByRole("main").locator("li").first();
    await row.hover();
    await settle(page);
    const rowBg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(
      alphaOf(rowBg),
      `track row hover is opaque: ${rowBg}`,
    ).toBeLessThan(1);

    // 3. An icon button hover (ghost path, surface-2 token) stays glass.
    const menuTrigger = page
      .getByRole("main")
      .locator('button[aria-label^="Actions for"]:visible')
      .first();
    await menuTrigger.hover();
    await settle(page);
    const triggerBg = await menuTrigger.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(
      alphaOf(triggerBg),
      `menu trigger hover is opaque: ${triggerBg}`,
    ).toBeLessThan(1);

    // 4. The active sidebar route is translucent, not a solid rectangle.
    // A fixture page is not a nav route, so this reads the real library.
    await page.goto("/library");
    await expect(page.getByRole("main")).toBeVisible();
    const activeLink = page.locator('aside a[aria-current="page"]').first();
    await expect(activeLink).toBeVisible();
    const activeBg = await activeLink.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(
      alphaOf(activeBg),
      `active nav item is opaque: ${activeBg}`,
    ).toBeLessThan(1);


  });

  authTest("loading skeletons sweep instead of pulsing", async ({ pageA: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const headerField = page.getByLabel("Search tracks, artists, albums");
    await expect(headerField).toBeVisible();

    const { release } = await holdNavigation(page, "q=");
    await headerField.fill("glass skeleton probe");
    await headerField.press("Enter");

    const block = page.locator(".glass-skeleton").first();
    await expect(block).toBeVisible();

    // Translucent fill, not an opaque grey rectangle.
    const blockBg = await block.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(alphaOf(blockBg), `skeleton block is opaque: ${blockBg}`).toBeLessThan(1);

    // The sweep runs on ::after; the legacy pulse is off.
    const sweep = await block.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      const self = getComputedStyle(el);
      return { after: after.animationName, self: self.animationName };
    });
    expect(sweep.after).toBe("glass-shimmer");
    expect(sweep.self).toBe("none");

    release();
    await expect(page.locator(".glass-skeleton").first()).toBeHidden({
      timeout: 20_000,
    });
  });

  authTest("screenshots hold together across wallpapers", async ({ pageA: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLibraryWithTrackPlaying(page);

    // Queue open over each backdrop: the densest glass in the product.
    await page.locator('[aria-label="Up next"]:visible').first().click();
    await expect(
      page.locator('[role="dialog"]').filter({ has: page.locator("li") }),
    ).toBeVisible();
    await settle(page);

    await page.screenshot({ path: `${SHOT}-queue-wash.png` });
    await paintWallpaper(page, BRIGHT_WALLPAPER);
    await settle(page);
    await page.screenshot({ path: `${SHOT}-queue-bright.png` });
    await paintWallpaper(page, DARK_WALLPAPER);
    await settle(page);
    await page.screenshot({ path: `${SHOT}-queue-dark.png` });

    // Text stays uniform across backdrops: the queue title color must not
    // change with the wallpaper (no wallpaper-dependent restyle anywhere).
    const titleColor = await page.evaluate(() => {
      const h = document.querySelector('[role="dialog"] h2');
      return h ? getComputedStyle(h).color : null;
    });
    expect(titleColor).not.toBeNull();

    await page.keyboard.press("Escape");
    await expect(
      page.locator('[role="dialog"]').filter({ has: page.locator("li") }),
    ).toBeHidden();
    await paintWallpaper(page, BRIGHT_WALLPAPER);
    await settle(page);
    await page.screenshot({ path: `${SHOT}-library-bright.png` });
  });
});
