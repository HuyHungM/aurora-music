import { test, expect } from "@playwright/test";

/**
 * PWA / installable-web-app verification (Phase 20 shell, Phase 51 identity,
 * install flow and safe areas). Fully offline-safe: no YouTube, no
 * credentials, no playback required. Runs in every E2E invocation.
 */

interface ManifestResponse {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  orientation: string;
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  shortcuts?: Array<{ name: string; short_name: string; url: string }>;
}

const OFFLINE_COPY = {
  vi: {
    title: "Bạn đang ngoại tuyến",
    body: /kết nối internet/i,
  },
  en: {
    title: "You're offline",
    body: /internet connection/i,
  },
} as const;

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
    const manifest = (await response.json()) as ManifestResponse;
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

  test("manifest carries a stable identity and a degrading display chain", async ({
    page,
  }) => {
    // RULE 13/16/19/21: one canonical identity, an id that never drifts, a
    // display chain that ends at `browser`, and no orientation lock.
    await page.goto("/");
    const manifest = (await (
      await page.request.get("/manifest.webmanifest")
    ).json()) as ManifestResponse;

    expect(manifest.id).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).not.toMatch(/[?#]/);
    expect(manifest.display_override[0]).toBe("standalone");
    expect(manifest.display_override).toContain("browser");
    expect(manifest.orientation).toBe("any");
    expect(manifest.dir).toBe("ltr");
    expect(manifest.lang).toBe("vi");
    expect(manifest.categories).toContain("music");
  });

  test("manifest ships a real maskable icon and only live shortcuts", async ({
    page,
  }) => {
    // RULE 24/45: the maskable entry must be a distinct asset, and every
    // shortcut must land on a route that exists.
    await page.goto("/");
    const manifest = (await (
      await page.request.get("/manifest.webmanifest")
    ).json()) as ManifestResponse;

    const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
    const any = manifest.icons.filter((icon) => icon.purpose !== "maskable");
    expect(maskable.length).toBe(1);
    expect(any.length).toBeGreaterThan(0);
    expect(maskable[0].src).not.toBe(any[0].src);

    expect(manifest.shortcuts?.length ?? 0).toBeGreaterThan(0);
    for (const shortcut of manifest.shortcuts ?? []) {
      const target = await page.request.get(shortcut.url);
      // A redirect to sign-in still proves the route exists; a 404 does not.
      expect(target.status(), `${shortcut.url} resolves`).toBeLessThan(400);
    }
  });

  test("declares a viewport that lets safe-area insets resolve", async ({
    page,
  }) => {
    // RULE 27: without viewport-fit=cover every env(safe-area-inset-*) in the
    // shell, player and queue resolves to 0 on iOS.
    await page.goto("/");
    const content = await page.locator('meta[name="viewport"]').getAttribute(
      "content",
    );
    expect(content).toContain("width=device-width");
    expect(content).toContain("viewport-fit=cover");
  });

  test("declares iOS installed-mode metadata", async ({ page }) => {
    // RULE 26: capable + title + status bar style, all through the
    // framework's current metadata API. Next.js 16 emits
    // `mobile-web-app-capable` for `capable`; that is the spelling iOS
    // Safari honours, so the framework-native output is the correct one.
    await page.goto("/");
    await expect(
      page.locator('meta[name="mobile-web-app-capable"]'),
    ).toHaveAttribute("content", "yes");
    await expect(
      page.locator('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Aurora");
    await expect(
      page.locator('meta[name="apple-mobile-web-app-status-bar-style"]'),
    ).toHaveAttribute("content", "black-translucent");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });

  test("page metadata states the same identity as the manifest", async ({
    page,
    context,
  }) => {
    // RULE 13/48: the tab title, the description and the launcher must never
    // describe the product differently. Every route keeps its own page label
    // and gains the canonical app name through the layout title template.
    //
    // The two descriptions are compared BY LOCALE, not as bare strings, and the
    // reason is a real design decision rather than a test convenience. The
    // manifest is a single static document that must not vary per request, so
    // its description is pinned to the shipped default locale (`vi`) - see
    // `APP_DESCRIPTION_BY_MANIFEST_LOCALE` and the `manifest.ts` comment. The
    // page's `<meta name="description">` follows the visitor's locale. Those
    // are the SAME sentence in two languages; comparing them literally asserts
    // that a Vietnamese-launcher app may not be described in English on an
    // English visit, which is the opposite of the intent.
    //
    // So: pin the visitor to the manifest's locale and require exact equality
    // (this is the assertion that would catch a hand-edited manifest drifting
    // away from the shared dictionary), then pin them apart and require the
    // page to use the other translation of that same product.
    //
    // The expected strings are duplicated rather than imported because
    // Playwright runs without the `@` path alias; `OFFLINE_COPY` above sets
    // the precedent in this file.
    const DESCRIPTIONS = {
      vi: "Nghe và khám phá âm nhạc cùng Aurora",
      en: "Stream and discover music with Aurora",
    } as const;

    const manifest = (await (
      await page.request.get("/manifest.webmanifest")
    ).json()) as ManifestResponse;
    const readDescription = async (): Promise<string | null> =>
      page.locator('meta[name="description"]').getAttribute("content");

    // The absolute origin, spelled out as the sibling offline test does, so the
    // cookie is scoped to the app rather than to `baseURL`'s default.
    const origin = "http://127.0.0.1:3100";

    // Locale-independent identity must match exactly, in every locale. Read
    // AFTER the first navigation: a locator evaluated on `about:blank` never
    // resolves, and that mistake is indistinguishable from a missing meta tag.
    await context.addCookies([
      { name: "aurora-locale", value: "vi", url: origin },
    ]);
    await page.goto("/");
    await expect(page).toHaveTitle("Home · Aurora Music");
    const applicationName = await page
      .locator('meta[name="application-name"]')
      .getAttribute("content");
    expect(applicationName).toBe(manifest.name);
    expect(await readDescription()).toBe(manifest.description);
    expect(manifest.description).toBe(DESCRIPTIONS.vi);

    // A different locale yields the other translation, not a different product.
    await context.addCookies([
      { name: "aurora-locale", value: "en", url: origin },
    ]);
    await page.goto("/");
    expect(await readDescription()).toBe(DESCRIPTIONS.en);
    expect(manifest.description).not.toBe(DESCRIPTIONS.en);
    // And the name is unaffected by the switch.
    expect(
      await page.locator('meta[name="application-name"]').getAttribute("content"),
    ).toBe(manifest.name);
  });

  test("every route carries the app name in its title", async ({ page }) => {
    // RULE 13: no route may present itself as a second, differently-branded
    // product in the tab strip.
    for (const route of ["/search", "/radio", "/library"]) {
      await page.goto(route);
      await expect(page).toHaveTitle(/· Aurora Music$/);
    }
  });

  test("app-config exposes safe metadata and no secrets", async ({ page }) => {
    // RULE 86/89: one unauthenticated configuration contract, and every
    // deep link it advertises is a real route.
    await page.goto("/");
    const response = await page.request.get("/api/app-config");
    expect(response.status()).toBe(200);
    const config = (await response.json()) as Record<string, unknown>;

    expect(config.appName).toBe("Aurora Music");
    expect(config.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.platform).toBe("web");
    expect(config.supportedLocales).toEqual(["vi", "en"]);
    const capabilities = config.capabilities as Record<string, unknown>;
    expect(capabilities.offlineAudio).toBe(false);
    expect(capabilities.pushNotifications).toBe(false);

    const serialized = JSON.stringify(config);
    for (const secret of ["DATABASE_URL", "AUTH_SECRET", "process.env"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("never shows a dead install control", async ({ page }) => {
    // RULE 64: the affordance must not appear unless the browser can actually
    // install. Headless Chromium does not fire beforeinstallprompt, so
    // nothing may be offered.
    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Cài đặt$|^Install$/ })).toHaveCount(0);
  });

  test("security headers survive the PWA work", async ({ page }) => {
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

  test("startup survives an origin with no service worker API", async ({
    page,
  }) => {
    // The other half of the registration contract, and the half that a
    // secure-context CI host can never reach by navigating on its own.
    //
    // `navigator.serviceWorker` is a [SecureContext] interface: on a plain-HTTP
    // origin (a LAN/IP host such as http://192.168.1.32:3000, and the
    // production deployment served over http://) the property is not exposed
    // at all — `"serviceWorker" in navigator` is false and the container is
    // `undefined`. Deleting the prototype property reproduces exactly that
    // API surface while still running the real production bundle.
    //
    // This is a regression test for a real crash, not a hypothetical. The
    // source guarded with `if (!container) return undefined`, which is
    // correct TypeScript and which unit tests pass — but the production
    // compiler eliminated that branch as dead code, so the shipped bundle
    // evaluated `typeof container.register` on `undefined` and threw
    // `TypeError: Cannot read properties of undefined (reading 'register')`
    // out of a root-layout effect. That unmounted the tree: PlayerHost logged
    // `app_initialized`, crashed, logged `app_shutdown`, and re-mounted in a
    // loop until the page was unusable. Nothing but the built bundle can
    // catch that, which is why this test exists here and not in vitest.
    await page.addInitScript(() => {
      delete (Navigator.prototype as unknown as Record<string, unknown>)
        .serviceWorker;
    });

    const pageErrors: string[] = [];
    const consoleLines: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => consoleLines.push(message.text()));

    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();

    // The page really is running with the API absent.
    expect(await page.evaluate(() => "serviceWorker" in navigator)).toBe(false);
    expect(await page.evaluate(() => typeof navigator.serviceWorker)).toBe(
      "undefined",
    );

    // PlayerHost stays alive: it initialized and was never shut down.
    await expect
      .poll(
        () =>
          consoleLines.filter((line) =>
            line.includes('"event":"app_initialized"'),
          ).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    expect(
      consoleLines.filter((line) => line.includes('"event":"app_shutdown"')),
    ).toEqual([]);

    // No uncaught exception of any kind, and specifically not the
    // `reading 'register'` failure this test exists to prevent.
    expect(pageErrors).toEqual([]);
    expect(
      consoleLines.filter(
        (line) => line.includes("register") && line.includes("TypeError"),
      ),
    ).toEqual([]);
  });

  test("offline reload serves the built-in fallback, not music", async ({
    page,
    context,
  }) => {
    // RULE 47, stated as the guarantee that actually matters: a visitor whose
    // language is Vietnamese is NEVER shown English offline text.
    //
    // This test used to assert the stronger claim "with no locale cookie the
    // fallback is Vietnamese", and it passed — but only because the feature was
    // broken. The worker used to read the `aurora-locale` cookie off the
    // navigation request, and Chromium does not expose that header to a service
    // worker, so the answer was the shipped default for everyone, in every
    // language. The worker is now told the locale by the page (which can read
    // it), so a visitor with no cookie but an `Accept-Language` of English is
    // correctly served English. Asserting the default for that visitor would
    // now be asserting the bug.
    //
    // So the locale is pinned explicitly, which is what makes the assertion
    // about the guarantee rather than about a browser default.
    await context.addCookies([
      { name: "aurora-locale", value: "vi", url: "http://127.0.0.1:3100" },
    ]);
    await page.goto("/");
    await expect(page.getByRole("navigation").first()).toBeVisible();

    // Phase 49. The reload below only reaches the service worker if the worker
    // is already activated AND controlling this page. `goto` returns as soon
    // as the document is parsed, which is before registration completes, and
    // `sw.js` reaches `clients.claim()` a tick later — so going offline first
    // races the worker's activation. When the race is lost the reload goes to
    // the network and Playwright throws `ERR_INTERNET_DISCONNECTED`, which
    // fails the test without ever exercising the fallback it is asserting.
    // Observed once in a full-suite run and never in isolated runs, which is
    // the signature of a load-dependent race rather than a product defect.
    // The assertions below are unchanged; only the precondition is now
    // explicit instead of assumed.
    await expect(async () => {
      const controlled = await page.evaluate(
        () => navigator.serviceWorker?.controller != null,
      );
      expect(controlled).toBe(true);
    }).toPass({ timeout: 30_000 });

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText(OFFLINE_COPY.vi.title)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(OFFLINE_COPY.vi.body)).toBeVisible();
      // The English copy must be absent, not merely unfound by a broad match.
      await expect(page.getByText(OFFLINE_COPY.en.title)).toHaveCount(0);
      // No promise of offline music anywhere in the fallback.
      await expect(page.getByText(/offline music|phát ngoại tuyến/i)).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });

  test("offline fallback follows the visitor's language", async ({
    page,
    context,
  }) => {
    // RULE 47: the worker reads the locale cookie off the navigation request,
    // so a visitor who chose English gets an English notice.
    await context.addCookies([
      {
        name: "aurora-locale",
        value: "en",
        url: "http://127.0.0.1:3100",
      },
    ]);
    await page.goto("/");
    await expect(async () => {
      const controlled = await page.evaluate(
        () => navigator.serviceWorker?.controller != null,
      );
      expect(controlled).toBe(true);
    }).toPass({ timeout: 30_000 });

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText(OFFLINE_COPY.en.title)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await context.setOffline(false);
    }
  });
});
