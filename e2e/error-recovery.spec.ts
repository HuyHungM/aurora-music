import { test, expect } from "@playwright/test";
import { FIXTURE_A, fixtureUrl } from "./fixtures";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

test.describe("route error recovery", () => {
  test.skip(
    !LIVE,
    "Fixture route requires AURORA_E2E_LIVE_PLAYBACK=1 (no provider traffic needed).",
  );

  test("route failure shows the boundary while the player survives", async ({
    page,
  }) => {
    await page.goto(`${fixtureUrl(FIXTURE_A.providerTrackId)}?boom=1`);
    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Try again" }),
    ).toBeVisible();
    // The persistent player (owned by the layout above the boundary)
    // survives the route failure.
    await expect(
      page.getByRole("region", { name: "Player bar" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Back to home" }).click();
    await expect(page.getByRole("navigation").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("boundary retry is keyboard-operable and never harms the player", async ({
    page,
  }) => {
    await page.goto(`${fixtureUrl(FIXTURE_A.providerTrackId)}?boom=1`);
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await retry.focus();
    await page.keyboard.press("Enter");
    // Same URL still throws: the boundary persists instead of crashing,
    // and the persistent player bar is untouched throughout.
    await expect(
      page.getByRole("heading", { name: "Something went wrong" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("region", { name: "Player bar" }),
    ).toBeVisible();
  });
});

test.describe("offline indicator", () => {
  test("appears offline and clears on reconnect without touching playback", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    expect(await page.getByText("You're offline").count()).toBe(0);

    await context.setOffline(true);
    await expect(page.getByText("You're offline")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/internet connection/i),
    ).toBeVisible();
    // The banner never steals focus.
    expect(
      await page.evaluate(() => document.activeElement?.tagName),
    ).toBe("BODY");

    await context.setOffline(false);
    await expect(page.getByText("You're offline")).toHaveCount(0);
  });
});
