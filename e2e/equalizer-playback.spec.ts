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
 * WHAT IT NOW ASSERTS, and why the answer is "nothing is built". This spec used
 * to require `contexts === 1` and `sourceCalls === 1`, and passed — on a graph
 * that output silence. The provider's stream is cross-origin and serves no
 * `Access-Control-Allow-Origin`, so a `MediaElementAudioSourceNode` over it
 * yields zeroes by specification, and Chrome said so in the console on every
 * run. The number was recorded as an artifact because neither `> 0` nor `= 0`
 * was an honest assertion.
 *
 * So the provider's own stream is now the REFUSAL case: the graph declines
 * before taking the one-way door, the interface says the stream rather than the
 * browser is at fault, the playhead keeps moving, and Chrome's sentence about
 * zeroes never appears. The positive case — a graph that really is built and
 * really does process audio — is `equalizer-audible.spec.ts`, which serves a
 * CORS-clean response so the browser is allowed to answer.
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

    // The graph must NOT be built here, and the reason is the whole point of
    // this spec having been rewritten.
    //
    // It used to assert `contexts === 1` and `sourceCalls === 1`, then record
    // `measureGraphRms` as an artifact because the number was exactly 0. That
    // was a graph which was structurally perfect, running, and completely
    // silent: the provider's stream is cross-origin and carries no
    // `Access-Control-Allow-Origin`, so `MediaElementAudioSourceNode` outputs
    // zeroes by specification. The old assertions passed on the defect.
    //
    // So the contract inverted. A source the browser is not allowed to read is
    // now refused BEFORE the one-way door, and the two halves that follow are
    // what a listener actually gets: a notice that names the stream, and their
    // music, still going.
    const engaged = await eqCounters(page);
    expect(engaged.contexts).toBe(0);
    expect(engaged.sourceCalls).toBe(0);
    expect(engaged.distinctElements).toBe(0);
    expect(engaged.errors).toEqual([]);

    await expect(page.getByText(/this stream cannot be read/i)).toBeVisible();
    // The browser is not the problem, and saying so would send a listener to
    // update a browser that is working exactly as specified.
    await expect(
      page.getByText(/this browser cannot process audio/i),
    ).toHaveCount(0);

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
    // Every one of those switches is a configuration change, and every one is
    // pushed at the graph. None of them may open the door either.
    const after = await eqCounters(page);
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
    expect(after.distinctElements).toBe(0);
    expect(after.errors).toEqual([]);
    await expect(page.getByText(/this stream cannot be read/i)).toBeVisible();

    // --- 6. The listener's state did not move -------------------------------
    expect(await seekDuration(page)).toBe(duration);
    expect(await volumeSlider(page).inputValue()).toBe(volume);
    expect(await unmuteButton(page).count()).toBe(wasMuted);
    expect(await audioElementCount(page)).toBe(audioBefore);
    // No track was resolved, re-resolved or reloaded to switch a mode.
    expect(resolverCalls).toBe(0);

    // There is no graph to measure, and that is the measurement: `-1` is what
    // `measureGraphRms` returns when the node it would tap was never created.
    // Recording it keeps the contrast with the old run — where the same call
    // returned a real number that meant silence — legible in the artifact.
    readings.push(`afterEngage.preamp=${await measureGraphRms(page, "preamp")}`);
    readings.push(`afterSwitch.preamp=${await measureGraphRms(page, "preamp")}`);

    // --- 7. And the track is still going ------------------------------------
    const tail = await seekValue(page);
    await advances(page, tail);

    // The assertion this spec was rewritten for. Chrome printed this sentence
    // on every previous run, and it is only reachable through an element that
    // has been re-homed into a graph it is not allowed to feed. With the door
    // shut, the browser never has cause to say it.
    const zeroing = consoleLines.filter((line) => /outputs zeroes/i.test(line));
    expect(zeroing).toEqual([]);

    // No FAILURE notice anywhere. A bare `toHaveCount(0)` on `role="status"`
    // would be wrong here rather than strict: the EQ panel's save status and
    // the install affordance both live in live regions by design, so the
    // assertion has to be about what is *in* them. The equalizer's own notice
    // is a stream notice, which is why the filter does not exclude it.
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /error|failed|unavailable|no playable/i }),
    ).toHaveCount(0);

    // Kept with the run so the finding travels with the artifact instead of
    // living only in a report. URLs are already redacted by `redactSecrets`.
    await testInfo.attach("eq-signal-rms.txt", {
      body: [
        "source: the provider's cross-origin stream carries no",
        "Access-Control-Allow-Origin, so Web Audio may not read it.",
        "The graph declines before the one-way door; the readings below are -1",
        "because the node they would have tapped was never created.",
        ...readings,
        "",
        ...zeroing,
      ].join("\n"),
      contentType: "text/plain",
    });
  });
});
