import { test, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { FIXTURE_A, INVALID_ID, fixtureUrl, redactSecrets } from "./fixtures";
import {
  diagnosePlayback,
  expectMediaLoaded,
  expectPlaybackAdvancing,
  expectPlaybackPaused,
  formatDiagnosis,
  mediaCurrentTime,
  mediaDuration,
  readMediaState,
} from "./helpers/assertPlayback";

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
      // Attach the media diagnosis too. On failure this is the difference
      // between "playback broke somewhere" and a named stage plus the exact
      // element state at the moment it broke.
      const state = await readMediaState(page).catch(() => null);
      await testInfo.attach("playback-diagnosis.txt", {
        body: `${formatDiagnosis(diagnosePlayback(state, "Test failed"))}\ngooglevideo requests: ${mediaRequests}\n`,
        contentType: "text/plain",
      });
    }
  });

  /**
   * The seek control, for asserting that a CONTROL exists.
   *
   * Explicitly not a playback oracle. Every playback fact in this file comes
   * from `assertPlayback.ts`, which reads the media element; this locator only
   * ever answers "is there a seek control, and does it carry a range".
   */
  function seekSlider(page: Page) {
    return page.locator('input[aria-label="Seek"]').first();
  }

  async function playFixture(page: Page): Promise<void> {
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().click();

    // Real evidence, from the media element: the browser reached a loaded
    // state and the position actually moved. A Pause button merely means the
    // UI was told playback started.
    await expectMediaLoaded(page);
    await expectPlaybackAdvancing(page);
  }

  test("Scenario A: direct YouTube result plays real audio", async ({
    page,
  }) => {
    await playFixture(page);

    // Duration comes from the element's metadata, not from a slider's `max`
    // attribute: `max` is rendered from what the app believes, so it would be
    // a valid duration even for a stream that never loaded a byte.
    const duration = await mediaDuration(page);
    expect(duration).toBeGreaterThan(0);

    // The element must genuinely have been fed, and the network must have
    // carried the media. Either alone is insufficient - together they say the
    // bytes arrived AND the element consumed them.
    const state = await readMediaState(page);
    expect(state?.readyState ?? 0).toBeGreaterThanOrEqual(2);
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

    // Measured on the element. `expectPlaybackPaused` reports PLAYER_STATE_FAILURE
    // with the drift distance if the position moved anyway.
    await expectPlaybackPaused(page);
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

    // Re-arms from the CURRENT element position, so this fails if resume did
    // not actually restart the clock rather than merely clearing a flag.
    await expectPlaybackAdvancing(page);
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("Scenario D: seek moves currentTime toward the target", async ({
    page,
  }) => {
    await playFixture(page);

    // The slider is the correct instrument for a seek test - it is the control
    // under test. The VERDICT is read from the element: the target is only
    // accepted once the element's own currentTime arrives there.
    const slider = seekSlider(page);
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
      expect(Math.abs((await mediaCurrentTime(page)) - target)).toBeLessThanOrEqual(
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
    await expectMediaLoaded(page);
    await expectPlaybackAdvancing(page);

    await page.getByRole("button", { name: "Up next" }).first().click();
    await expect(page.getByRole("dialog", { name: "Queue" })).toBeVisible();
    await expect(
      page.getByText("E2E Fixture B"),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    const beforeNext = await mediaCurrentTime(page);
    await page.getByRole("button", { name: "Next track" }).first().click();
    await expect(page.getByText("E2E Fixture B").first()).toBeVisible({
      timeout: 30_000,
    });

    // The real anti-snapback check: a new track means a NEW element timeline,
    // so the position restarts near zero instead of continuing from A.
    // Previously this was a 3s sleep plus a text assertion, which a stale
    // in-place seek could have satisfied.
    await expect(async () => {
      const now = await mediaCurrentTime(page);
      expect(now).toBeLessThan(beforeNext);
    }).toPass({ timeout: 30_000 });
    await expectPlaybackAdvancing(page);
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
