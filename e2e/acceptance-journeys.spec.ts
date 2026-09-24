import { test, expect } from "@playwright/test";

/**
 * Release-candidate acceptance journeys (Phase 29). Fully offline-safe:
 * no playback, no credentials, no provider keys required. Every test
 * asserts cross-boundary composition (route + auth + UI + player shell)
 * that unit tests cover only in isolation.
 *
 * Deliberately ungated: these run in every E2E invocation, including CI.
 * Live playback, provider search ranking, and authenticated mutations
 * remain covered by the gated live specs and DAL unit tests.
 */
test.describe("authentication acceptance", () => {
  test("unauthenticated library visit shows the sign-in CTA, never privileged UI", async ({
    page,
  }) => {
    await page.goto("/library");
    await expect(
      page.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible();
    // No playlist/likes content leaks to anonymous visitors, and no
    // application error renders. Scoped to main: Next.js renders its
    // own visually-hidden #__next-route-announcer__ (role=alert) at
    // the body level, which must not be mistaken for an app error.
    await expect(page.getByText("Liked music")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.getByRole("link", { name: "Back to home" }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("header reports honest sign-in state without claiming success", async ({
    page,
  }) => {
    await page.goto("/");
    const signIn = page.getByRole("button", { name: "Sign in" });
    const unavailable = page.getByText("Sign-in unavailable");
    await expect(signIn.or(unavailable).first()).toBeVisible();
    // Signed-out shell never renders a sign-out control.
    await expect(
      page.getByRole("button", { name: /sign out/i }),
    ).toHaveCount(0);
  });
});

test.describe("search acceptance", () => {
  test("a query without provider keys degrades gracefully, shell intact", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
    });
    await page.goto("/search?q=never%20gonna%20give%20you%20up");
    await expect(
      page.getByRole("heading", { name: "Search" }),
    ).toBeVisible();
    // Either live result groups (provider keys present) or a safe
    // empty/unavailable state (no keys, as in CI) — never a raw error
    // or stack trace. "Track results" is a labelled region, not text.
    await expect(
      page
        .getByRole("region", { name: "Track results" })
        .or(page.getByText(/No results for|Search is unavailable/)),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("navigation").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("track acceptance", () => {
  test("unknown track id renders the not-found boundary", async ({
    page,
  }) => {
    await page.goto("/track/definitely-bogus-track-id-xyz");
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("region", { name: "Player bar" }),
    ).toBeVisible();
  });
});

test.describe("cross-boundary journeys", () => {
  test("Journey A: home → search → library → home keeps one player, no errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible();

    await page.getByRole("navigation").first().getByRole("link", { name: "Search" }).click();
    await expect(page.getByLabel("Search tracks")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("navigation").first().getByRole("link", { name: "Library" }).click();
    await expect(
      page.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("navigation").first().getByRole("link", { name: "Home" }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible({ timeout: 15_000 });

    // Single PlayerHost across client-side navigations: no duplicate
    // engine, no duplicate Media Session wiring surface.
    await expect(
      page.getByRole("region", { name: "Player bar" }),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("reload keeps the shell with a single player and no stale snapshot", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible();
    // Playback state is intentionally in-memory: after reload there is
    // exactly one idle player bar, not a resurrected track.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("region", { name: "Player bar" }),
    ).toHaveCount(1);
    await expect(page.getByRole("navigation").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
