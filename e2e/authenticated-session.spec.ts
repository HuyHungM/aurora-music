/**
 * Authenticated session lifecycle journeys (Phase 30): establishment,
 * sign-out, expired/tampered session rejection, and proof that
 * authenticated state never leaks into unauthenticated contexts.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS, TEST_USERS, sessionCookieName } from "./auth/constants";
import config from "../playwright.config";

const BASE_URL = config.use?.baseURL ?? "http://127.0.0.1:3100";
const COOKIE_NAME = sessionCookieName(BASE_URL);
const TRACK_ONE = FIXTURE_TRACKS[0].title;

async function sessionCookieNames(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  const cookies = await page.context().cookies();
  return cookies.map((cookie) => cookie.name);
}

authTest.describe("authenticated session journeys", () => {
  authTest("session establishment: UI, cookie, and session endpoint agree", async ({
    pageA,
  }) => {
    await pageA.goto("/library");
    await expect(
      pageA.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();
    await expect(pageA.getByText("Your library is waiting")).toHaveCount(0);

    expect(await sessionCookieNames(pageA)).toContain(COOKIE_NAME);

    const response = await pageA.request.get("/api/auth/session");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      user?: { id?: string; email?: string };
    };
    expect(body.user?.email).toBe(TEST_USERS[0].email);
    expect(body.user?.id).toBeTruthy();
  });

  authTest("Journey 8a: sign out clears auth and mutations reject safely", async ({
    pageA,
  }) => {
    await pageA.goto("/library");
    await expect(
      pageA.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();

    await pageA.getByRole("button", { name: /sign out/i }).first().click();
    // Sign-out redirects home (fixed-target behavior); the shell is
    // signed out and the session cookie is cleared server-side.
    await expect(
      pageA.getByRole("heading", { name: "Welcome to Aurora" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.getByRole("button", { name: "Sign in" }).first(),
    ).toBeVisible();
    expect(await sessionCookieNames(pageA)).not.toContain(COOKIE_NAME);

    // Protected mutation after sign-out: the server action rejects via
    // requireUser, the LikeButton silently reverts — no claimed success.
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("button", {
        name: `Like ${TRACK_ONE}`,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole("button", { name: `Like ${TRACK_ONE}` }).click();
    await expect(
      pageA.getByRole("button", { name: `Like ${TRACK_ONE}` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageA.getByRole("main").getByRole("alert"),
    ).toHaveCount(0);

    await pageA.goto("/library");
    await expect(
      pageA.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  authTest("Journey 8b: expired session is rejected safely", async ({
    expiredPage,
  }) => {
    await expiredPage.goto("/library");
    await expect(
      expiredPage.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      expiredPage.getByRole("button", { name: "Sign in" }).first(),
    ).toBeVisible();

    const response = await expiredPage.request.get("/api/auth/session");
    expect(response.status()).toBe(200);
    const expiredBody = (await response.json()) as {
      user?: { id?: string };
    } | null;
    expect(expiredBody?.user?.id).toBeUndefined();

    await expiredPage.goto("/e2e-library");
    await expect(
      expiredPage.getByRole("button", { name: `Like ${TRACK_ONE}` }),
    ).toBeVisible({ timeout: 15_000 });
    await expiredPage.getByRole("button", { name: `Like ${TRACK_ONE}` }).click();
    await expect(
      expiredPage.getByRole("button", { name: `Like ${TRACK_ONE}` }),
    ).toBeVisible({ timeout: 15_000 });
  });

  authTest("Journey 8c: tampered session is rejected safely", async ({
    tamperedPage,
  }) => {
    await tamperedPage.goto("/library");
    await expect(
      tamperedPage.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible({ timeout: 15_000 });

    const tamperedResponse =
      await tamperedPage.request.get("/api/auth/session");
    expect(tamperedResponse.status()).toBe(200);
    const tamperedBody = (await tamperedResponse.json()) as {
      user?: { id?: string };
    } | null;
    expect(tamperedBody?.user?.id).toBeUndefined();

    await tamperedPage.goto("/e2e-library");
    await expect(
      tamperedPage.getByRole("button", { name: `Like ${TRACK_ONE}` }),
    ).toBeVisible({ timeout: 15_000 });
    await tamperedPage.getByRole("button", { name: `Like ${TRACK_ONE}` }).click();
    await expect(
      tamperedPage.getByRole("button", { name: `Like ${TRACK_ONE}` }),
    ).toBeVisible({ timeout: 15_000 });
  });

  authTest("no leakage: default context stays unauthenticated", async ({
    page,
  }) => {
    expect(await sessionCookieNames(page)).not.toContain(COOKIE_NAME);
    await page.goto("/library");
    await expect(
      page.getByRole("heading", { name: "Your library is waiting" }),
    ).toBeVisible();
    const response = await page.request.get("/api/auth/session");
    const leakBody = (await response.json()) as {
      user?: { id?: string };
    } | null;
    expect(leakBody?.user?.id).toBeUndefined();
  });
});
