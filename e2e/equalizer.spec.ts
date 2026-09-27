import { test, expect, type Page } from "@playwright/test";
import { env } from "node:process";
import { eqCounters, instrumentEQ } from "./eq-instrument";

/** Where the fixture serves the application; used for the locale cookie. */
const baseURL = env.E2E_BASE_URL ?? null;

/**
 * Equalizer acceptance (Phase 53 addendum).
 *
 * Every other test of this feature runs in jsdom, which has no working
 * `AudioContext` and no media element — so the unit and component suites
 * necessarily drive a fake. That fake is good for the properties that are
 * about *structure* (does a preset change rebuild the graph, does a failure
 * ever touch the element, are parameters ramped rather than stepped), and it is
 * structurally incapable of answering the two questions that matter most here:
 *
 *   **Does a real browser actually build this graph, and does it do so once?**
 *
 * `createMediaElementSource()` is irreversible. In a real browser it is a real
 * re-homing of a real element, and the failure mode if the ordering in
 * `ARCHITECTURE.md` §33.2 were wrong is silence, not an exception. jsdom would
 * happily report a pass. So this spec runs the real thing in Chromium and
 * instruments the two APIs that cannot be observed from the DOM:
 * `AudioContext` construction and `createMediaElementSource` calls.
 *
 *   **And does it refuse to build one at all when the music would go quiet?**
 *
 * The element here has no `src`, which is exactly the state of a listener who
 * opens Settings before pressing play. A graph opened now would be re-homing an
 * element whose NEXT source nobody has looked at — and a source the browser is
 * not allowed to read is a graph that outputs silence. So the contract this
 * spec pins is the deferral: nothing is allocated, the door stays shut, and the
 * interface reports nothing, because nothing is wrong.
 *
 * The other half — a graph that really does build, really does process audio,
 * and really does change the sound — needs an element that is loading bytes
 * from a source the browser may read. That is `equalizer-audible.spec.ts`.
 *
 * Fully offline-safe: no playback is started, no track is resolved, no
 * credentials are needed.
 */

/** Open Settings and switch the equalizer on. */
async function enableEQ(page: Page): Promise<void> {
  await page.goto("/settings");
  const toggle = page.getByTestId("eq-switch");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}

/** The declared preamp figure shown beside the presets. */
function declaredPreamp(page: Page) {
  return page.getByTestId("eq-declared-preamp");
}

test.describe("equalizer (Settings → Audio)", () => {
  test.beforeEach(async ({ page }) => {
    await instrumentEQ(page);
  });

  test("Settings → Audio offers the equalizer, off by default", async ({
    page,
  }) => {
    await page.goto("/settings");

    await expect(
      page.getByRole("heading", { name: "Equalizer" }),
    ).toBeVisible();
    const toggle = page.getByTestId("eq-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("eq-preset-aurora-v")).toBeHidden();

    // Off means the graph is never built: enabling it is the moment the one-way
    // door is taken, and a page that has not been asked for a curve must not
    // have re-homed the audio element.
    const before = await eqCounters(page);
    expect(before.contexts).toBe(0);
    expect(before.sourceCalls).toBe(0);
  });

  test("does not open the one-way door while there is nothing to play", async ({
    page,
  }) => {
    await enableEQ(page);

    // The sharpest assertion in the spec, and it is a negative one. There is no
    // source on the element, so there is nothing to have checked, so the graph
    // has no business existing: no context, no filters, and above all no
    // re-homing — because a re-homing now would be a bet on a source that has
    // not been chosen yet, and the wrong bet is silence with no way back.
    const after = await eqCounters(page);
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
    expect(after.errors).toEqual([]);

    // And it says nothing, because nothing is wrong. The graph is waiting for a
    // source, not reporting a failure — a notice here would put an error in
    // front of a listener whose equalizer is perfectly healthy.
    await expect(page.getByText(/unavailable|cannot be read/i)).toHaveCount(0);
  });

  test("waiting for a source is not waiting forever, and never allocates", async ({
    page,
  }) => {
    await enableEQ(page);

    // Preset changes while the graph is deferred must not turn a deferral into
    // an engagement. Each of these is a configuration change, and the store
    // pushes every one of them at the graph.
    for (const id of ["flat", "aurora-v", "custom"] as const) {
      await page.getByTestId(`eq-preset-${id}`).click();
      await expect(page.getByTestId(`eq-preset-${id}`)).toBeChecked();
    }
    await page.getByTestId("eq-advanced-toggle").click();
    await page.getByTestId("eq-band-1000").fill("6");

    const after = await eqCounters(page);
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
    expect(after.errors).toEqual([]);
    await expect(page.getByText(/unavailable|cannot be read/i)).toHaveCount(0);
  });

  test("a custom curve applies to the configuration, and the preamp follows it", async ({
    page,
  }) => {
    await enableEQ(page);
    await expect(declaredPreamp(page)).toHaveText("Preamp: -3.5 dB");

    await page.getByTestId("eq-advanced-toggle").click();
    // §9: moving a band drops the preset's declared preamp into automatic, so
    // the figure can never be a stale -3.5 sitting under a +6 dB boost.
    await page.getByTestId("eq-band-62").fill("6");
    await expect(page.getByTestId("eq-preset-custom")).toBeChecked();
    await expect(page.getByTestId("eq-preamp-auto")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Which is not the same as a band reaching a filter: there is no filter,
    // and that is the correct state for an element with no source.
    const after = await eqCounters(page);
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
    expect(after.errors).toEqual([]);
  });

  test("turning the equalizer off and on again never builds anything", async ({
    page,
  }) => {
    await enableEQ(page);

    // The A/B hold is a transient, and the switch is a switch. Neither may
    // allocate a context, and neither may report a failure.
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

    const off = await eqCounters(page);
    expect(off.contexts).toBe(0);
    expect(off.sourceCalls).toBe(0);
    expect(off.errors).toEqual([]);
  });

  test("the equalizer persists and survives a reload", async ({ page }) => {
    await enableEQ(page);
    await page.getByTestId("eq-advanced-toggle").click();
    await page.getByTestId("eq-band-125").fill("-4.5");
    await expect(page.getByTestId("eq-band-125")).toHaveValue("-4.5");

    // The immediate-cookie sink: written synchronously, so it is present before
    // the debounced account write could have run.
    const cookie = await page.evaluate(() => document.cookie);
    expect(cookie).toContain("aurora-eq=");

    await page.reload();
    const toggle = page.getByTestId("eq-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("eq-advanced-toggle").click();
    await expect(page.getByTestId("eq-band-125")).toHaveValue("-4.5");
  });

  test("reaches no playback control, and adds no second audio element", async ({
    page,
  }) => {
    await page.goto("/settings");
    const audioBefore = await page.evaluate(
      () => document.querySelectorAll("audio").length,
    );

    await enableEQ(page);
    await page.getByTestId("eq-advanced-toggle").click();
    // One move in each region, so the curve is demonstrably hand-edited rather
    // than a preset nobody touched.
    for (const frequency of [31, 250, 4000]) {
      await page.getByTestId(`eq-band-${frequency}`).fill("3");
    }
    await page.getByTestId("eq-preamp-auto").click();

    const audioAfter = await page.evaluate(
      () => document.querySelectorAll("audio").length,
    );
    expect(audioAfter).toBe(audioBefore);

    // §31/§32 by observation: no transport control anywhere on the page, and no
    // second media element appeared as a side effect of configuring a curve.
    await expect(
      page.getByRole("main").getByRole("button", { name: /^(play|pause|next|previous|skip)$/i }),
    ).toHaveCount(0);
    const after = await eqCounters(page);
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
  });

  test("is keyboard operable end to end", async ({ page }) => {
    await enableEQ(page);
    await page.getByTestId("eq-advanced-toggle").click();

    // A native range input, so arrow keys step it — the platform's behaviour,
    // which is the whole reason this is an `input[type=range]` and not a div.
    const band = page.getByTestId("eq-band-1000");
    await band.focus();
    await expect(band).toBeFocused();
    const before = Number(await band.inputValue());
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(async () => Number(await band.inputValue()))
      .toBeGreaterThan(before);

    // And the value is announced as a signed decibel figure, not as a number
    // that means nothing spoken aloud.
    const announced = await band.getAttribute("aria-valuetext");
    expect(announced).toMatch(/[+-]\d+(\.\d+)? dB/);
  });

  test("renders in Vietnamese with no raw translation key", async ({
    page,
    context,
  }) => {
    // The locale is a cookie, not a path segment - the app has no `/vi` routes -
    // and the project's default is `vi`, so the English fixture pins `en`. This
    // test pins it back the other way through the same mechanism a listener uses.
    await context.addCookies([
      {
        name: "aurora-locale",
        value: "vi",
        url: baseURL ?? "http://127.0.0.1:3100",
      },
    ]);

    await page.goto("/settings");
    await page.getByTestId("eq-switch").click();
    await page.getByTestId("eq-advanced-toggle").click();

    await expect(page.getByRole("heading", { name: "Bộ cân bằng" })).toBeVisible();
    const text = (await page.locator("main").innerText()) ?? "";
    expect(text).not.toMatch(/\beq\.[a-zA-Z]/);
    expect(text).not.toMatch(/\bsettings\.[a-zA-Z]/);
  });
});
