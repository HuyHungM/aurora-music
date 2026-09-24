import { test, expect } from "@playwright/test";
import { FIXTURE_A, fixtureUrl } from "./fixtures";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

test.describe("live playback on a mobile viewport", () => {
  test.skip(
    !LIVE,
    "Live provider suite is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.",
  );
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("mini player stays reachable and audio progresses", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().tap();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });
    // MiniPlayer is the small-screen surface; the (visually hidden)
    // desktop seek input still exposes numeric progress.
    await expect(
      page.getByRole("region", { name: "Mini player" }),
    ).toBeVisible();
    const slider = page.locator('input[aria-label="Seek"]').first();
    const t0 = Number(await slider.inputValue());
    await expect(async () => {
      expect(Number(await slider.inputValue())).toBeGreaterThan(t0);
    }).toPass({ timeout: 30_000 });
  });
});
