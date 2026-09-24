import { test, expect } from "@playwright/test";

/**
 * PWA application-shell smoke (Phase 20). Fully offline-safe: no YouTube,
 * no credentials, no playback required. Runs in every E2E invocation.
 */
test.describe("pwa application shell", () => {
  test("manifest is discoverable, valid, and serves icons", async ({
    page,
  }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="manifest"]')
      .first()
      .getAttribute("href");
    expect(href).toBe("/manifest.webmanifest");

    const response = await page.request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    expect(manifest.name).toBe("Aurora Music");
    expect(manifest.short_name).toBe("Aurora");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#08070d");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of manifest.icons) {
      const iconResponse = await page.request.get(icon.src);
      expect(iconResponse.status()).toBe(200);
      expect(iconResponse.headers()["content-type"] ?? "").toContain(
        "image/png",
      );
    }
  });

  test("serves security headers compatible with playback", async ({
    page,
  }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"] ?? "").toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("service worker registers without breaking startup", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
    });
    await page.goto("/");
    await expect(async () => {
      const registered = await page.evaluate(() =>
        navigator.serviceWorker
          .getRegistration()
          .then((registration) => registration !== undefined),
      );
      expect(registered).toBe(true);
    }).toPass({ timeout: 30_000 });
    // App shell renders with the worker active.
    await expect(page.getByRole("navigation").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("offline reload serves the built-in fallback, not music", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("You're offline")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(/internet connection/i)).toBeVisible();
      await expect(page.getByText(/offline music/i)).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});
