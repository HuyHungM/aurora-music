import { test, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { FIXTURE_A, INVALID_ID, fixtureUrl, redactSecrets } from "./fixtures";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

test.describe("live playback (YouTube fixture)", () => {
  test.skip(
    !LIVE,
    "Live provider suite is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.",
  );

  let consoleLines: string[] = [];
  let mediaRequests = 0;

  test.beforeEach(async ({ page }, testInfo: TestInfo) => {
    consoleLines = [];
    mediaRequests = 0;
    page.on("console", (message) => {
      consoleLines.push(redactSecrets(message.text()));
    });
    page.on("request", (request) => {
      if (request.url().includes("googlevideo")) {
        mediaRequests += 1;
      }
    });
    testInfo.setTimeout(120_000);
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    // Cleanup: stop any leaked audio so tests stay isolated.
    await page.close().catch(() => undefined);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("console-sanitized.txt", {
        body: consoleLines.join("\n"),
        contentType: "text/plain",
      });
    }
  });

  function seekSlider(page: Page) {
    return page.locator('input[aria-label="Seek"]').first();
  }

  async function seekValue(page: Page): Promise<number> {
    return Number(await seekSlider(page).inputValue());
  }

  async function playFixture(page: Page): Promise<void> {
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().click();
    // Real evidence, not just a clicked button: the Pause control appears
    // (playing event reached the UI) and the position advances.
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });
    const t0 = await seekValue(page);
    await expect(async () => {
      expect(await seekValue(page)).toBeGreaterThan(t0);
    }).toPass({ timeout: 30_000 });
  }

  test("Scenario A: direct YouTube result plays real audio", async ({
    page,
  }) => {
    await playFixture(page);
    const duration = Number(
      await page
        .locator('input[aria-label="Seek"]')
        .first()
        .getAttribute("max"),
    );
    expect(duration).toBeGreaterThan(0);
    expect(mediaRequests).toBeGreaterThan(0);
  });

  test("Scenario C: pause stops progress without errors or retries", async ({
    page,
  }) => {
    await playFixture(page);
    await page.getByRole("button", { name: /^Pause / }).first().click();
    await expect(
      page.getByRole("button", { name: /^Play / }).first(),
    ).toBeVisible();
    const t0 = await seekValue(page);
    await page.waitForTimeout(2500);
    const t1 = await seekValue(page);
    expect(Math.abs(t1 - t0)).toBeLessThanOrEqual(1.5);
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("Scenario C: resume advances again without duplicate errors", async ({
    page,
  }) => {
    await playFixture(page);
    await page.getByRole("button", { name: /^Pause / }).first().click();
    await page.getByRole("button", { name: /^Play / }).first().click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible();
    const t0 = await seekValue(page);
    await expect(async () => {
      expect(await seekValue(page)).toBeGreaterThan(t0);
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("Scenario D: seek moves currentTime toward the target", async ({
    page,
  }) => {
    await playFixture(page);
    const slider = await seekSlider(page);
    const max = Number(await slider.getAttribute("max"));
    expect(max).toBeGreaterThan(60);
    const target = Math.min(30, Math.floor(max - 10));
    await slider.evaluate((element: HTMLInputElement, value: number) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, target);
    await expect(async () => {
      expect(Math.abs((await seekValue(page)) - target)).toBeLessThanOrEqual(
        8,
      );
    }).toPass({ timeout: 30_000 });
  });

  test("Scenario E: queue A+B, next transitions without stale playback", async ({
    page,
  }) => {
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "E2E play collection" }).click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Up next" }).first().click();
    await expect(page.getByRole("dialog", { name: "Queue" })).toBeVisible();
    await expect(
      page.getByText("E2E Fixture B"),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Next track" }).first().click();
    await expect(page.getByText("E2E Fixture B").first()).toBeVisible({
      timeout: 30_000,
    });
    // No snapback to A: the stale resolution stays dead.
    await page.waitForTimeout(3000);
    expect(
      await page.getByTestId("e2e-status").textContent(),
    ).toContain("E2E Fixture B");
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("Scenario F: deterministic failure surfaces a sanitized error", async ({
    page,
  }) => {
    await page.goto(fixtureUrl(INVALID_ID));
    await page.getByRole("button", { name: /^Play / }).first().click();
    const status = page.getByRole("status");
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status).toContainText(
      /unavailable|no playable stream|playback info failed/i,
    );
    const text = (await status.textContent()) ?? "";
    expect(text).not.toMatch(/googlevideo|http/i);
    // Failed track stays current; queue intact; nothing plays.
    await expect(
      page.getByRole("button", { name: /^Play / }).first(),
    ).toBeVisible();
    // Explicit user retry re-attempts through the facade and fails
    // deterministically again — bounded, without loops or queue damage.
    await page.getByRole("button", { name: "Retry playback" }).click();
    await expect(status).toContainText(
      /unavailable|no playable stream|playback info failed/i,
    );
    await expect(
      page.getByRole("button", { name: /^Play / }).first(),
    ).toBeVisible();
  });

  test("repeat-one smoke: toggle holds the queue without errors", async ({
    page,
  }) => {
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "E2E play collection" }).click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });

    const repeat = page
      .getByRole("button", { name: /^Repeat/ })
      .first();
    await repeat.click();
    await repeat.click();
    await expect(repeat).toHaveAccessibleName(/one/i);

    await page.getByRole("button", { name: "Up next" }).first().click();
    await expect(page.getByRole("dialog", { name: "Queue" })).toBeVisible();
    await expect(page.getByText("2 tracks")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("shuffle smoke: toggling keeps every queued item", async ({
    page,
  }) => {
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "E2E play collection" }).click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });

    await page
      .getByRole("button", { name: /shuffle/i })
      .first()
      .click();
    await page.getByRole("button", { name: "Up next" }).first().click();
    await expect(page.getByRole("dialog", { name: "Queue" })).toBeVisible();
    await expect(page.getByText("2 tracks")).toBeVisible();
    await expect(page.getByText("E2E Fixture B")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("security: no secrets, no proxy, no persisted media URLs", async ({
    page,
    context,
  }) => {
    await playFixture(page);
    // No open proxy for arbitrary URLs.
    const probe = await page.request.get(
      "/api/proxy?url=https://example.com/x.mp3",
    );
    expect(probe.status()).toBe(404);
    // No media URLs or secrets persisted in web storage or cookies.
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(storage).not.toMatch(/googlevideo|api_key|secret|token/i);
    const cookies = await context.cookies();
    expect(
      cookies.filter((cookie) => /googlevideo|token|session/i.test(cookie.name)),
    ).toEqual([]);
    expect(
      cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join(";"),
    ).not.toMatch(/googlevideo/i);
  });
});
