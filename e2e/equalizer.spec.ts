import { test, expect, type Page } from "@playwright/test";
import { env } from "node:process";

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
 * structurally incapable of answering the question that matters most here:
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
 * Fully offline-safe: no playback is started, no track is resolved, no
 * credentials are needed. The graph engages on a media element with no `src`,
 * which is exactly what happens for a listener who switches the equalizer on
 * before playing anything.
 */

/** Instrument the two irreversible APIs before any application code runs. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Counters {
      contexts: number;
      sourceCalls: number;
      elements: unknown[];
      errors: string[];
    }
    const counters: Counters = {
      contexts: 0,
      sourceCalls: 0,
      elements: [],
      errors: [],
    };
    (window as unknown as { __eq: Counters }).__eq = counters;

    const Native = window.AudioContext;
    if (Native) {
      class CountingContext extends Native {
        constructor(...args: ConstructorParameters<typeof Native>) {
          super(...args);
          counters.contexts += 1;
        }
        override createMediaElementSource(
          element: HTMLMediaElement,
        ): MediaElementAudioSourceNode {
          counters.sourceCalls += 1;
          counters.elements.push(element);
          return super.createMediaElementSource(element);
        }
      }
      window.AudioContext =
        CountingContext as unknown as typeof window.AudioContext;
    }

    // A throw here is the failure the whole ordering exists to prevent, so it is
    // recorded rather than merely logged: an exception that only appears in the
    // console is easy to miss and fatal to the listener.
    window.addEventListener("error", (event) => {
      counters.errors.push(String(event.message));
    });
    window.addEventListener("unhandledrejection", (event) => {
      counters.errors.push(String(event.reason));
    });
  });
}

/** The counters the init script installed. */
async function counters(page: Page): Promise<{
  contexts: number;
  sourceCalls: number;
  distinctElements: number;
  errors: string[];
}> {
  return page.evaluate(() => {
    const c = (window as unknown as {
      __eq: {
        contexts: number;
        sourceCalls: number;
        elements: unknown[];
        errors: string[];
      };
    }).__eq;
    return {
      contexts: c.contexts,
      sourceCalls: c.sourceCalls,
      distinctElements: new Set(c.elements).size,
      errors: c.errors,
    };
  });
}

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
    await instrument(page);
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
    const before = await counters(page);
    expect(before.contexts).toBe(0);
    expect(before.sourceCalls).toBe(0);
  });

  test("a real browser builds the graph once, and reports no failure", async ({
    page,
  }) => {
    await enableEQ(page);

    // The sharpest assertion in the spec. If `engage()` had failed, the panel
    // would be showing the "unavailable" notice, and the reason would be
    // invisible to every other suite in the repository.
    await expect(page.getByText(/equalizer is unavailable/i)).toHaveCount(0);

    const after = await counters(page);
    expect(after.contexts).toBe(1);
    expect(after.sourceCalls).toBe(1);
    expect(after.errors).toEqual([]);
  });

  test("cycling every preset never rebuilds the graph", async ({ page }) => {
    await enableEQ(page);

    // The §32 failure this guards is a preset change that tears the graph down
    // and rebuilds it. In a real browser that means a second irreversible
    // re-homing of an element that has already been re-homed, which throws —
    // and if it did not throw it would mean a second context and a second clock.
    const before = await counters(page);

    for (const id of ["flat", "aurora-v", "custom", "aurora-v", "flat"] as const) {
      await page.getByTestId(`eq-preset-${id}`).click();
      await expect(page.getByTestId(`eq-preset-${id}`)).toBeChecked();
    }

    const after = await counters(page);
    expect(after.contexts).toBe(before.contexts);
    expect(after.sourceCalls).toBe(before.sourceCalls);
    // Identity, not just a count: every call was on the SAME element, so the
    // engine's element was reused rather than a second one created.
    expect(after.distinctElements).toBe(before.distinctElements);
    expect(after.errors).toEqual([]);
    await expect(page.getByText(/equalizer is unavailable/i)).toHaveCount(0);
  });

  test("a custom curve applies without rebuilding, and the preamp follows it", async ({
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

    const after = await counters(page);
    expect(after.contexts).toBe(1);
    expect(after.sourceCalls).toBe(1);
    expect(after.errors).toEqual([]);
  });

  test("bypass is unity, not a disconnect — the graph stays built", async ({
    page,
  }) => {
    await enableEQ(page);
    const engaged = await counters(page);
    expect(engaged.sourceCalls).toBe(1);

    // The A/B hold is the only transient, and it must not be a teardown.
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

    // And the switch is not either: turning the equalizer off leaves the
    // element inside a live, unity-gain graph rather than disconnecting it.
    await page.getByTestId("eq-switch").click();
    await expect(page.getByTestId("eq-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    const off = await counters(page);
    expect(off.contexts).toBe(1);
    expect(off.sourceCalls).toBe(1);
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
    const after = await counters(page);
    expect(after.contexts).toBe(1);
    expect(after.sourceCalls).toBe(1);
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
