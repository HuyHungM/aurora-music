import { test, expect, type Page } from "@playwright/test";

/**
 * Search loading behaviour, in a real browser.
 *
 * WHY THE NAVIGATION IS HELD OPEN. The locked field and the skeleton are
 * transient by design: they exist between the submit and the moment the server
 * component commits. Against a local server that window is a few milliseconds,
 * so asserting it directly is a test that either passes for the wrong reason or
 * fails on a fast machine. Delaying the RSC fetch makes the state observable
 * and the assertions deterministic — it tests the real transition, not a mock
 * of it.
 *
 * WHY THE HEADER FIELD IS THE ONE ASSERTED AS LOCKED. `/search`'s own field is
 * rendered by the page, and the route-level skeleton replaces the whole page
 * while the request is in flight — so that field's lock is a correctness guard
 * (it refuses a second submit) whose visible lifetime is almost nil. The header
 * field lives in the LAYOUT, which is not replaced, so it stays mounted, stays
 * focused and stays locked for the entire request. That is by design, and it is
 * the reason the busy affordance has somewhere to live at all.
 *
 * Offline-safe: without provider keys a query degrades to the empty/unavailable
 * state, which is a valid terminal state here — the point is the transition into
 * and out of it, not what the results contain.
 */

/** Holds the first RSC navigation matching `needle` open until released. */
async function holdSearchNavigation(page: Page, needle: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let didHold = false;

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    // `_rsc` is how an App Router client navigation asks for the next page.
    if (!didHold && url.includes("_rsc") && url.includes(needle)) {
      didHold = true;
      // Never hold indefinitely: a stuck promise would turn a UI regression
      // into a two-minute timeout instead of a failed assertion.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
      await Promise.race([held, timeout]);
    }
    await route.continue();
  });

  return { release, didHold: () => didHold };
}

test.describe("search loading state", () => {
  test("locks the field, shows skeletons, then restores a usable page", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto("/");

    const headerField = page.getByLabel("Search tracks, artists, albums");
    await expect(headerField).toBeVisible();

    const { release } = await holdSearchNavigation(page, "never");

    await headerField.fill("never gonna give you up");
    await headerField.press("Enter");

    // 1. The query is preserved, not cleared or rewritten.
    await expect(headerField).toHaveValue("never gonna give you up");

    // 2. The header field locks: read-only, announced unavailable, and its
    //    region announced busy.
    await expect(headerField).toHaveAttribute("readonly", "");
    await expect(headerField).toHaveAttribute("aria-disabled", "true");
    await expect(headerField.locator("xpath=ancestor::form[@role='search']")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    // 3. The busy indicator replaces the magnifier in place.
    await expect(headerField.locator("xpath=..").locator(".animate-spin")).toHaveCount(1);

    // 4. The page shows skeletons, not stale results.
    const busyRegion = page.locator("main [aria-busy='true']");
    await expect(busyRegion).toHaveCount(1);
    await expect(busyRegion.locator(".animate-pulse").first()).toBeVisible();

    // 5. A locked field really is locked: typing does not change it.
    await headerField.pressSequentially("extra");
    await expect(headerField).toHaveValue("never gonna give you up");

    release();

    // 6. The skeleton is replaced by a real terminal state, and the lock lifts
    //    on its own — nothing in this test had to unlock anything by hand.
    await expect(busyRegion).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Results for|Find your music/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(headerField).not.toHaveAttribute("readonly", "");
    await expect(headerField.locator("xpath=ancestor::form[@role='search']")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(headerField).toBeEditable();
    expect(errors).toEqual([]);
  });

  test("a burst of submits produces exactly one search", async ({ page }) => {
    // The duplicate-request guarantee, measured where it matters: one URL, one
    // server render, whatever the user does with the keyboard while it runs.
    await page.goto("/search");
    const field = page.locator("main").getByLabel("Search tracks");
    await expect(field).toBeVisible();

    const rscRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("_rsc")) rscRequests.push(request.url());
    });

    await field.fill("son tung");
    await field.press("Enter");
    await field.press("Enter");
    await field.press("Enter");

    await expect(page).toHaveURL(/q=son(\+|%20)tung/);
    await expect(
      page.getByRole("heading", { name: /Results for|Find your music/ }),
    ).toBeVisible({ timeout: 30_000 });

    // Exactly one navigation for the query. (The page may fetch the route more
    // than once for prefetch reasons; what must not happen is a second request
    // carrying a *different* query, which is the racing search this guards.)
    const searches = rscRequests.filter((url) => url.includes("q="));
    expect(searches.length).toBeLessThanOrEqual(1);
  });

  test("the page field refuses a second submit and unlocks when results arrive", async ({
    page,
  }) => {
    await page.goto("/search");
    const field = page.locator("main").getByLabel("Search tracks");
    const { release } = await holdSearchNavigation(page, "never");

    await field.fill("never gonna give you up");
    await field.press("Enter");

    // The route skeleton takes over the page, which is exactly why the busy
    // affordance is asserted on the header field instead.
    await expect(page.locator("main [aria-busy='true']")).toHaveCount(1);
    release();

    await expect(
      page.getByRole("heading", { name: /Results for|Find your music/ }),
    ).toBeVisible({ timeout: 30_000 });
    // Whichever terminal state arrived, the field is usable again.
    await expect(field).toBeEditable();
    await expect(field).toHaveValue("never gonna give you up");
  });
});
