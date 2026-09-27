import { test, expect, type Page, type Route } from "@playwright/test";
import { FIXTURE_A, fixtureUrl, redactSecrets } from "./fixtures";
import { audioElementCount, eqCounters, instrumentEQ, measureGraphRms } from "./eq-instrument";

/**
 * The half of the equalizer nobody could hear, made audible.
 *
 * `ARCHITECTURE.md` §33.8 recorded the defect this file exists to close: a
 * `MediaElementAudioSourceNode` over a cross-origin stream whose response
 * carries no `Access-Control-Allow-Origin` outputs **zeroes by specification**.
 * Measured on Aurora's own provider stream, the graph was perfect and silent —
 * ten filters at the right gains, preamp at the right linear value, context
 * `running`, element healthy — and an analyser read exactly 0 at both the
 * source node and the preamp.
 *
 * That measurement could not become a passing test, because the provider's
 * stream genuinely does not allow it, and asserting `= 0` would bless the
 * silence. So this spec supplies its own media: Playwright fulfils the stream
 * request from a locally generated tone, and the element is made to ask for it
 * the way a CORS-capable one would — by setting `crossOrigin` before the source
 * is assigned, so a CORS-mode request is issued and a successful check is
 * actually performed.
 *
 * THAT SHIM IS LOAD-BEARING AND DELIBERATE. A first version of this file served
 * `Access-Control-Allow-Origin: *` and nothing else, and the gate still refused
 * the source — correctly, and for a reason worth stating plainly: the media
 * element issues a **no-CORS** request unless `crossOrigin` is set, so with no
 * opt-in there is no CORS check to pass, and a `MediaElementAudioSourceNode`
 * over such a resource is specified to output zeroes however the server
 * answered. The header alone is not permission. The shim below sets the
 * attribute ahead of the engine's own `src` assignment, which is the only way
 * to reach the state a CORS-capable media path would put the element in.
 *
 * It is a test-only emulation of a capability media delivery does not have yet
 * (see `docs/scope-boundaries.md`); nothing in `src/` sets `crossOrigin`, and
 * nothing here claims Aurora's own stream is readable.
 *
 * What that buys is the question every other equalizer test in the repository
 * is structurally unable to ask:
 *
 *   **Is the equalizer actually doing anything to the sound?**
 *
 * The assertions are about measured RMS, in this order:
 *
 *   1. the graph engages, and the signal at the source node is not zero;
 *   2. Aurora V-Shape's signal is measurably quieter than Flat's, which is the
 *      preamp doing its declared job rather than something being muted;
 *   3. returning to Flat returns the level to where it started.
 *
 * A curve that was silently discarded, or a preamp that was silently zero, or a
 * graph that was wired but fed nothing, fails all three. Nothing here asserts
 * that audio is "audible" in any way a machine cannot measure: it asserts that
 * real decoded samples arrive, and that the configured numbers change them.
 *
 * The second half of the file is the mirror image, and it is the regression
 * that matters most: the SAME tone, with the element's CORS opt-in removed and
 * the header removed with it, must leave the one-way door shut and the music
 * playing.
 *
 * Opt-in like every other live spec, because the fixture ROUTE is gated on
 * `AURORA_E2E_LIVE_PLAYBACK=1`. The provider's MEDIA never leaves the
 * machine: the stream request is intercepted and answered here, so this needs
 * the resolver's keyless InnerTube call and nothing else — no credentials, and
 * not one byte of audio from the provider.
 */

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

const SAMPLE_RATE = 8_000;
/**
 * Long enough that the audio cannot run out mid-measurement.
 *
 * This number is load-bearing and was found by a failure rather than chosen for
 * taste. The spec takes three RMS windows of ~1.5 s each, with preset changes
 * and settling time between them, plus the fixture's own resolve-and-buffer
 * before the first one. A tone shorter than that total measures its own
 * FOOTER: playback ends, the graph is still connected and still correct, and
 * the analyser honestly reports 0 — which fails the round-trip assertion with
 * a ratio of 1 and says nothing at all about the equalizer.
 *
 * So the audio has to outlast the measurement, and comfortably so. Sixty
 * seconds at 8 kHz mono 16-bit is 960 KB generated in memory, which is a
 * rounding error against a Node process and about four times the worst case.
 */
const SECONDS = 60;
const TONE_HZ = 440;
const AMPLITUDE = 0.5;

/**
 * A 16-bit mono PCM WAV, generated rather than shipped.
 *
 * A real audio file in `public/` would be a binary in a repository whose public
 * assets are an explicit allowlist, and this file exists to be measured rather
 * than listened to. The tone is a fundamental plus two partials so the filter
 * chain has something to act on at more than one frequency.
 */
function toneWav(): Buffer {
  const samples = SAMPLE_RATE * SECONDS;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  const partials: ReadonlyArray<readonly [number, number]> = [
    [TONE_HZ, 1],
    [TONE_HZ * 2, 0.4],
    [TONE_HZ * 3, 0.2],
  ];
  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (const [hz, level] of partials) {
      value += level * Math.sin(2 * Math.PI * hz * t);
    }
    const peak = Math.max(...partials.map(([, level]) => level)) * 1.6;
    buffer.writeInt16LE(
      Math.max(-1, Math.min(1, value / peak)) * AMPLITUDE * 32_767,
      44 + i * 2,
    );
  }
  return buffer;
}

/**
 * Answers every stream request with `body`, honouring `Range`.
 *
 * RANGE MATTERS. A media element asks for bytes; answering a ranged request
 * with a 200 and a whole body is tolerated by some elements and stalls others,
 * and a stalled element would make this spec report a media problem as an
 * audio-processing one. `Accept-Ranges` is advertised for the same reason.
 */
function serveStream(route: Route, body: Buffer, cors: boolean): Promise<void> {
  const header = route.request().headers()["range"];
  const headers: Record<string, string> = {
    "content-type": "audio/wav",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  if (cors) {
    // The single header that decides whether Web Audio may read the element.
    headers["access-control-allow-origin"] = "*";
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": String(end - start + 1),
      },
      body: body.subarray(start, end + 1),
    });
  }
  return route.fulfill({
    status: 200,
    headers: { ...headers, "content-length": String(body.length) },
    body,
  });
}

/**
 * Make every media element request its source in CORS mode.
 *
 * A `HTMLMediaElement` with no `crossOrigin` attribute issues a **no-CORS**
 * request, so no CORS check is ever performed and a `MediaElementAudioSourceNode`
 * over the result is specified to output zeroes regardless of the response
 * headers. Setting the attribute therefore is not a trick to get past the gate;
 * it is the only way to reach the state a CORS-capable media path puts the
 * element in, which is the state this spec is trying to measure.
 *
 * It has to be installed BEFORE the engine assigns `src`, so this wraps the
 * property rather than touching the element after the fact — a `src` set and
 * only then attributed has already been requested, and Chrome will not
 * re-attribute it. The setter records `crossOrigin` and then performs the
 * original assignment, so the attribute is in place at request time.
 *
 * TEST-ONLY. `src/` does not set `crossOrigin` anywhere, and adding it there
 * would break every stream that plays today (without the server's header the
 * element fails to load at all), which is why the emulation belongs here.
 */
async function optElementsIntoCors(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = HTMLMediaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    if (!descriptor?.get || !descriptor.set) {
      return;
    }
    const { get, set } = descriptor;
    Object.defineProperty(proto, "src", {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get(this: HTMLMediaElement) {
        return get.call(this);
      },
      set(this: HTMLMediaElement, value: string) {
        this.crossOrigin = "anonymous";
        set.call(this, value);
      },
    });
  });
}

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
  await expect(
    page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Play / }).first().click();
  await expect(
    page.getByRole("button", { name: /^Pause / }).first(),
  ).toBeVisible({ timeout: 60_000 });
}

async function enableEQ(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-link"], [data-testid="settings-link-compact"]').first().click();
  await expect(page.getByRole("heading", { name: "Equalizer" })).toBeVisible();
  await page.getByTestId("eq-switch").click();
  await expect(page.getByTestId("eq-switch")).toHaveAttribute("aria-checked", "true");
}

async function choosePreset(page: Page, id: "flat" | "aurora-v"): Promise<void> {
  await page.getByTestId(`eq-preset-${id}`).click();
  await expect(page.getByTestId(`eq-preset-${id}`)).toBeChecked();
  // One ramp is 30 ms; the RMS windows below are 1.5 s each, so this is only
  // about not measuring the tail of the previous curve.
  await page.waitForTimeout(400);
}

test.describe("equalizer audio, on a source the browser is allowed to read", () => {
  test.skip(!LIVE, "Live fixture route is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.");
  test.setTimeout(180_000);

  let consoleLines: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleLines = [];
    await instrumentEQ(page);
    page.on("console", (message) => {
      consoleLines.push(redactSecrets(message.text()));
    });
  });

  test("V-Shape processes real audio, and Flat is an identity", async ({ page }) => {
    const body = toneWav();
    let served = 0;
    // The element opted into CORS (see `optElementsIntoCors`), so this is a
    // CORS-mode request and a successful check is a real, performed check.
    await optElementsIntoCors(page);
    await page.route(/googlevideo\.com/, async (route) => {
      served += 1;
      await serveStream(route, body, true);
    });

    await openFixture(page);
    await enableEQ(page);

    // The door opened, exactly once, on the application's own element.
    const engaged = await eqCounters(page);
    expect(engaged.contexts).toBe(1);
    expect(engaged.sourceCalls).toBe(1);
    expect(engaged.distinctElements).toBe(1);
    expect(engaged.errors).toEqual([]);
    await expect(page.getByText(/cannot be read|unavailable/i)).toHaveCount(0);
    expect(served).toBeGreaterThan(0);

    // --- Flat: unity through the live graph ---------------------------------
    await choosePreset(page, "flat");
    const flat = await measureGraphRms(page, "preamp");
    // The headline number. It is 0 whenever the element is CORS-blocked, and
    // this is the assertion that would have caught that as a failure instead of
    // a note in a document.
    expect(flat).toBeGreaterThan(0.01);
    // The same signal at the source node, so the number is not an artefact of
    // where the tap was attached.
    expect(await measureGraphRms(page, "source")).toBeGreaterThan(0.01);

    // --- V-Shape: the same audio, measurably quieter ------------------------
    // Aurora V-Shape's automatic headroom is about -4.3 dB, so its output must
    // be around 0.61 of Flat's. A curve that was applied to nothing, or a
    // preamp that had been written as 0, would land at or above Flat instead.
    await choosePreset(page, "aurora-v");
    const vShape = await measureGraphRms(page, "preamp");
    expect(vShape).toBeGreaterThan(0.01);
    expect(vShape).toBeLessThan(flat * 0.85);

    // --- Flat again: the level returns, and nothing rebuilt -----------------
    await choosePreset(page, "flat");
    const flatAgain = await measureGraphRms(page, "preamp");
    // Asserted rather than left to the ratio below, because "the audio ran out"
    // and "the equalizer is wrong" fail this spec identically and mean opposite
    // things. The tone is 60 s and the whole spec takes well under a minute of
    // it, so a zero here is a defect, not an exhausted file.
    expect(flatAgain).toBeGreaterThan(0.01);
    // Within 20%: a round trip that lost or doubled the level would be a
    // different defect, and one that rebuilt the graph would have thrown by
    // now, because the element can only be re-homed once.
    expect(Math.abs(flatAgain - flat) / flat).toBeLessThan(0.2);

    const after = await eqCounters(page);
    expect(after.contexts).toBe(1);
    expect(after.sourceCalls).toBe(1);
    expect(after.distinctElements).toBe(1);
    expect(after.errors).toEqual([]);
    // Chrome's sentence about zeroes must not be here. If it is, the element
    // was tainted despite the header, and every number above is meaningless.
    expect(consoleLines.filter((line) => /outputs zeroes/i.test(line))).toEqual([]);
  });

  test("the same audio without CORS leaves the music playing and the door shut", async ({
    page,
  }) => {
    // The regression this whole change exists to prevent, as a browser test.
    // Identical tone, identical product path, one CORS opt-in removed - and the
    // outcome flips from "processed" to "declined, still audible".
    //
    // NOTE WHAT IS AND IS NOT CHANGED. No `crossOrigin`, so the element issues
    // a no-CORS request and no CORS check is performed at all; the header is
    // also absent, so even a check could not have passed. This is the state
    // Aurora's own provider stream is in, which is why the equalizer is refused
    // on it in production rather than silently producing nothing.
    const body = toneWav();
    await page.route(/googlevideo\.com/, async (route) => {
      await serveStream(route, body, false);
    });

    await openFixture(page);
    // The document-visible count, so "declining added a second path" is a claim
    // this spec can actually make. The engine's own element is not in the DOM,
    // which is why the position is read through the player rather than here.
    const audioBefore = await audioElementCount(page);
    const volume = await page
      .getByRole("slider", { name: "Volume" })
      .first()
      .inputValue();

    await enableEQ(page);

    // The notice names the STREAM, and says the music is fine.
    await expect(page.getByText(/this stream cannot be read/i)).toBeVisible();
    await expect(page.getByText(/still plays normally/i)).toBeVisible();
    await expect(page.getByText(/this browser cannot process audio/i)).toHaveCount(0);

    const after = await eqCounters(page);
    // No context, no re-homing, no exception. The element is untouched and is
    // playing straight to the speakers, which is the whole point.
    expect(after.contexts).toBe(0);
    expect(after.sourceCalls).toBe(0);
    expect(after.errors).toEqual([]);

    // And the music is genuinely still playing: the position advances, the
    // listener is not muted, and their volume is the one they set. A graph that
    // had been opened passes every DOM-level check above and fails these.
    const seek = page.locator('input[aria-label="Seek"]').first();
    const from = Number(await seek.inputValue());
    await expect(async () => {
      expect(Number(await seek.inputValue())).toBeGreaterThan(from);
    }).toPass({ timeout: 30_000 });
    expect(
      await page.getByRole("button", { name: "Unmute", exact: true }).count(),
    ).toBe(0);
    expect(
      await page.getByRole("slider", { name: "Volume" }).first().inputValue(),
    ).toBe(volume);
    expect(consoleLines.filter((line) => /outputs zeroes/i.test(line))).toEqual([]);

    // Exactly as many audio elements as before: declining is not a second path.
    expect(await audioElementCount(page)).toBe(audioBefore);
  });
});
