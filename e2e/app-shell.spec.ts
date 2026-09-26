import { test, expect } from "@playwright/test";

/**
 * Application shell acceptance (Phase 29). Fully offline-safe: no
 * playback, no credentials, no provider dependence beyond what the
 * pages themselves tolerate. Proves navigation landmarks, empty
 * states, and the 404 boundary render deterministically.
 */
test.describe("app shell", () => {
  test("home exposes landmarks, heading, and navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    for (const name of ["Home", "Search", "Library", "Radio"]) {
      await expect(
        page.getByRole("navigation").first().getByRole("link", { name }),
      ).toBeVisible();
    }
  });

  test("search without a query shows the empty state, not an error", async ({
    page,
  }) => {
    await page.goto("/search");
    // Scoped to main: the global header search is a separate landmark;
    // this asserts the page-level search input is visible.
    await expect(page.getByRole("main").getByLabel("Search tracks")).toBeVisible();
    await expect(page.getByText("Search the catalog")).toBeVisible();
    // Scoped to main: Next.js renders its own visually-hidden
    // #__next-route-announcer__ (role=alert) at the body level, which
    // must not be mistaken for an application error.
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  });

  test("unknown routes render the not-found boundary", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-route-xyz");
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to home" }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
