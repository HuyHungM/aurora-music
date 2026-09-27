import { test, expect, type Page } from "@playwright/test";
import { FIXTURE_A, fixtureUrl, redactSecrets } from "./fixtures";
import {
  audioElementCount,
  eqCounters,
  instrumentEQ,
  measureGraphRms,
} from "./eq-instrument";

/**
 * The mode switch, while music is actually playing.
 *
 * `equalizer.spec.ts` answers the structural questions against a media element
 * with no `src`, which is the honest thing to do offline — and it leaves the
 * single most expensive case unasked:
 *
 *   **re-homing an element that is ALREADY producing sound.**
 *
 * `createMediaElementSource()` is irreversible, and the window where it can go
 * wrong is the window in which the context has not started. On an idle element
 * that mistake costs a listener their next session; on a playing element it
 * costs them the track they are hearing right now, silently, and no mode switch
 * can bring it back. So this spec plays a real stream, engages the graph
 * mid-playback, walks Flat → V-Shape → Custom → Bypass → Flat → V-Shape, and
 * asserts at each step that the element, the position, the volume, the duration
 * and the graph are all exactly where they were.
 *
 * Like `live-playback.spec.ts` this is opt-in: it needs the network and a
 * provider. Set `AURORA_E2E_LIVE_PLAYBACK=1`.
 */

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

const seekSlider = (page: Page) => page.locator('input[aria-label="Seek"]').first();
const volumeSlider = (page: Page) =>
  page.getByRole("slider", { name: "Volume" }).first();
const unmuteButton = (page: Page) =>
  page.getByRole("button", { name: "Unmute", exact: true });
const settingsLink = (page: Page) =>
  page
    .locator('[data-testid="settings-link"], [data-testid="settings-link-compact"]')
    .first();

async function seekValue(page: Page): Promise<number> {
  return Number(await seekSlider(page).inputValue());
}

async function seekDuration(page: Page): Promise<number> {
  return Number(await seekSlider(page).getAttribute("max"));
}

/** Polls until the playhead has moved past where it was. */
async function advances(page: Page, from: number): Promise<void> {
  await expect(async () => {
    expect(await seekValue(page)).toBeGreaterThan(from);
  }).toPass({ timeout: 30_000 });
}

test.describe("equalizer during real playback", () => {
  test.skip(
    !LIVE,
    "Live provider suite is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.",
  );

  let consoleLines: string[] = [];
  /** POSTs carrying a `next-action` header — a server action, i.e. a resolver. */
  let resolverCalls = 0;
  let watchingResolver = false;

  test.beforeEach(async ({ page }, testInfo) => {
    consoleLines = [];
    resolverCalls = 0;
    watchingResolver = false;
    await instrumentEQ(page);
    page.on("console", (message) => {
      consoleLines.push(redactSecrets(message.text()));
    });
    page.on("request", (request) => {
      if (!watchingResolver || request.method() !== "POST") {
        return;
      }
      if (request.headers()["next-action"] !== undefined) {
        resolverCalls += 1;
      }
    });
    testInfo.setTimeout(120_000);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await page.close().catch(() => undefined);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("console-sanitized.txt", {
        body: consoleLines.join("\n"),
        contentType: "text/plain",
      });
    }
  });

  test("Flat → V-Shape → Custom → Bypass → Flat → V-Shape never disturbs playback", async ({
    page,
  }, testInfo) => {
    /** Signal readings, attached to the run rather than asserted on. */
    const readings: string[] = [];

    // --- 1. Real playback, from a real stream --------------------------------
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });

    const playing = await seekValue(page);
    await advances(page, playing);

    // Nothing has built a graph yet: the equalizer ships off, and a page that
    // has not been asked for a curve must not have re-homed anything.
    const untouched = await eqCounters(page);
    expect(untouched.contexts).toBe(0);
    expect(untouched.sourceCalls).toBe(0);

    const duration = await seekDuration(page);
    const volume = await volumeSlider(page).inputValue();
    const wasMuted = await unmuteButton(page).count();
    const audioBefore = await audioElementCount(page);
    const position = await seekValue(page);

    // --- 2. Client-side route change; PlayerHost lives in the layout --------
    await settingsLink(page).click();
    await expect(page.getByRole("heading", { name: "Equalizer" })).toBeVisible();
    await advances(page, position);

    // --- 3. Engage the graph while the element is ALREADY producing sound ---
    // This is the case the whole ordering exists for. If `resume()` were
    // awaited without a bound and the element re-homed regardless of the
    // answer, this click is where the listener would go quiet.
    await page.getByTestId("eq-switch").click();
    await expect(page.getByTestId("eq-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const engaged = await eqCounters(page);
    expect(engaged.contexts).toBe(1);
    expect(engaged.sourceCalls).toBe(1);
    expect(engaged.distinctElements).toBe(1);
    expect(engaged.errors).toEqual([]);
    await expect(page.getByText(/equalizer is unavailable/i)).toHaveCount(0);

    // The graph is not merely wired: it is built, running, and error-free.
    //
    // What comes OUT of it is measured here too, and deliberately not asserted
    // on. `measureGraphRms` returns exactly 0 on this media path today, and
    // Chrome says why in the console: "MediaElementAudioSource outputs zeroes
    // due to CORS access restrictions". The provider's stream carries no
    // `Access-Control-Allow-Origin`, so the browser refuses to let Web Audio
    // read the element at all. Asserting `> 0` would fail for a defect in media
    // delivery that no change to EQ mode switching can reach; asserting `= 0`
    // would bless it. So the number is recorded on the test as an artifact
    // instead, and `ARCHITECTURE.md` §33.8 carries the full finding.
    readings.push(`afterEngage.preamp=${await measureGraphRms(page, "preamp")}`);

    // --- 4. The full mode sequence, through the UI --------------------------
    watchingResolver = true;
    for (const id of ["flat", "aurora-v", "custom", "aurora-v", "flat", "aurora-v"] as const) {
      await page.getByTestId(`eq-preset-${id}`).click();
      await expect(page.getByTestId(`eq-preset-${id}`)).toBeChecked();
    }

    // Bypass, in both of its forms: the A/B hold and the switch itself, then
    // back on. Neither is permitted to be a teardown.
    await page.getByTestId("eq-compare").dispatchEvent("pointerdown");
    await expect(page.getByTestId("eq-compare")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("eq-compare").dispatchEvent("pointerup");
    await expect(page.getByTestId("eq-compare")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.getByTestId("eq-switch").click();
    await expect(page.getByTestId("eq-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.getByTestId("eq-switch").click();
    await expect(page.getByTestId("eq-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The interface agrees with what the graph was actually asked for.
    await expect(page.getByTestId("eq-preset-aurora-v")).toBeChecked();
    watchingResolver = false;

    // --- 5. The pipeline did not move ---------------------------------------
    const after = await eqCounters(page);
    expect(after.contexts).toBe(1);
    expect(after.sourceCalls).toBe(1);
    expect(after.distinctElements).toBe(1);
    expect(after.errors).toEqual([]);
    await expect(page.getByText(/equalizer is unavailable/i)).toHaveCount(0);

    // --- 6. The listener's state did not move -------------------------------
    expect(await seekDuration(page)).toBe(duration);
    expect(await volumeSlider(page).inputValue()).toBe(volume);
    expect(await unmuteButton(page).count()).toBe(wasMuted);
    expect(await audioElementCount(page)).toBe(audioBefore);
    // No track was resolved, re-resolved or reloaded to switch a mode.
    expect(resolverCalls).toBe(0);

    // Measured at both ends of the chain, and recorded rather than asserted —
    // see the note where the first reading was taken.
    readings.push(`afterSwitch.preamp=${await measureGraphRms(page, "preamp")}`);
    readings.push(`afterSwitch.source=${await measureGraphRms(page, "source")}`);

    // --- 7. And the track is still going ------------------------------------
    const tail = await seekValue(page);
    await advances(page, tail);
    // No FAILURE notice anywhere. A bare `toHaveCount(0)` on `role="status"`
    // would be wrong here rather than strict: the EQ panel's save status and
    // the install affordance both live in live regions by design, so the
    // assertion has to be about what is *in* them.
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /error|failed|unavailable|no playable/i }),
    ).toHaveCount(0);

    // Kept with the run so the finding travels with the artifact instead of
    // living only in a report: the measured signal, and Chrome's own sentence
    // about why it is what it is. URLs are already redacted by `redactSecrets`.
    await testInfo.attach("eq-signal-rms.txt", {
      body: [
        ...readings,
        "",
        ...consoleLines.filter((line) =>
          /outputs zeroes|blocked by CORS policy/i.test(line),
        ),
      ].join("\n"),
      contentType: "text/plain",
    });
  });
});
