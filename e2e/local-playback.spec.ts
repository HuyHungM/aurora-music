import { expect, test } from "@playwright/test";

/**
 * The LOCAL playback path, proven through the real media element.
 *
 * WHY THIS SPEC EXISTS. Local playback was reported broken with
 * `playback_recovery_failed`, `category: "source"`, and no native detail — and
 * every component of the path was individually correct: the resolver mapped a
 * MIME, the object-URL ring kept the live URL, the engine assigned `src` and
 * called `load()`, and recovery minted a FRESH object URL each round. Nothing
 * asserted that the browser would accept any of it, so the failure was invisible
 * until a real file met a real browser.
 *
 * What actually blocked it was `media-src https:` in the CSP: local tracks are
 * played as `blob:` object URLs, and Chromium refuses a blocked media source
 * with `MediaError.code === 4` and "Media load rejected by URL safety check" —
 * indistinguishable, in the old log, from a corrupt file.
 *
 * WHAT IS ASSERTED. Real media state and nothing cosmetic. A test that checked
 * for a Pause button or a seek slider would pass on a stream that never played,
 * which is precisely the failure mode that hid this bug; `duration` only has a
 * value once the container has been demuxed and metadata parsed, and
 * `currentTime` only advances if bytes are actually being decoded.
 *
 * The bytes come from the browser's own encoder via `MediaRecorder`, because the
 * File System Access API needs a real folder picker and a user gesture. Every
 * other link in the chain is production code.
 */

const FIXTURE_ROUTE = "/e2e-offline";

/** Generates real, decodable audio in the page and returns it as a byte array. */
async function recordRealAudio(page: import("@playwright/test").Page): Promise<number[]> {
  return page.evaluate(async () => {
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const recorder = new MediaRecorder(dest.stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    await new Promise((r) => setTimeout(r, 1200));
    recorder.stop();
    await stopped;
    osc.stop();
    await ctx.close();
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
}

interface DemuxedState {
  readyState: number | null;
  duration: number;
  errorCode: number | null;
  errorMessage: string | null;
}

/**
 * Polls until the element has actually DEMUXED the source, then returns it.
 *
 * WHY THIS IS NOT A SINGLE READ. The harness settles `__auroraLocalPlay` on the
 * `play` event, which fires when playback is REQUESTED — before the container has
 * been parsed. A diagnostics read taken at that instant legitimately reports
 * `readyState: 0`. Measured while offline: 0 at settle, then HAVE_ENOUGH_DATA
 * with a real parsed duration within half a second. Sampling an instant asserts
 * a race; the condition is the thing under test.
 */
const waitForDemuxed = (page: import("@playwright/test").Page, timeout = 20_000) =>
  page
    .waitForFunction(
      () => {
        const read = (window as unknown as {
          __auroraLocalDiagnostics?: () => {
            readyState: number | null;
            duration: number;
            errorCode: number | null;
            errorMessage: string | null;
          } | null;
        }).__auroraLocalDiagnostics;
        const state = read?.();
        if (!state) return false;
        // A failure settles the wait too, so the caller asserts on the reason.
        if (state.errorCode !== null || state.errorMessage !== null) return true;
        return (state.readyState ?? 0) >= 1 && state.duration > 0;
      },
      undefined,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);

const readDemuxed = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const read = (window as unknown as {
      __auroraLocalDiagnostics?: () => DemuxedState | null;
    }).__auroraLocalDiagnostics;
    return read?.() ?? null;
  });

test.describe("local file playback", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_ROUTE);
    await page.waitForFunction(() => "__auroraLocalRegister" in window);
  });

  test("plays a real local file: media decodes and currentTime advances", async ({
    page,
  }) => {
    const bytes = await recordRealAudio(page);
    expect(bytes.length).toBeGreaterThan(0);

    const result = await page.evaluate(async (data) => {
      const w = window as unknown as {
        __auroraLocalRegister: (s: {
          bytes: number[];
          name: string;
          type?: string;
        }) => { size: number };
        __auroraLocalPlay: (t?: number) => Promise<{
          outcome: string;
          diagnostics: Record<string, unknown> | null;
        }>;
      };
      // Named exactly like the file in the original report.
      w.__auroraLocalRegister({ bytes: data, name: "videoplayback.opus", type: "" });
      const played = await w.__auroraLocalPlay(8000);
      return {
        outcome: played.outcome,
        sourceScheme: played.diagnostics?.sourceScheme ?? null,
        errorCode: played.diagnostics?.errorCode ?? null,
        errorMessage: played.diagnostics?.errorMessage ?? null,
      };
    }, bytes);

    // Local playback is a blob: source, and the resolver produced one.
    expect(result.sourceScheme).toBe("blob");
    // It must NOT fail the way the reported bug did.
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.outcome).not.toBe("error");

    // HAVE_METADATA and a parsed duration: the container was opened and the
    // demuxer ran, rather than merely bytes having arrived. Polled, not sampled —
    // see `waitForDemuxed`.
    expect(await waitForDemuxed(page)).toBe(true);
    const demuxed = await readDemuxed(page);
    expect(demuxed?.errorCode ?? null).toBeNull();
    expect(demuxed?.errorMessage ?? null).toBeNull();
    expect(demuxed?.readyState ?? 0).toBeGreaterThanOrEqual(1);
    expect(demuxed?.duration ?? 0).toBeGreaterThan(0);

    // And the element is genuinely rendering audio, not sitting ready. This is
    // the assertion that could not pass on a stream that never played.
    const advanced = await page
      .waitForFunction(
        () => {
          const read = (window as unknown as {
            __auroraLocalDiagnostics?: () => { currentTime: number } | null;
          }).__auroraLocalDiagnostics;
          return (read?.()?.currentTime ?? 0) > 0.05;
        },
        undefined,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(advanced).toBe(true);
  });

  test("plays the same local track twice without exhausting its source", async ({
    page,
  }) => {
    const bytes = await recordRealAudio(page);

    const outcomes = await page.evaluate(async (data) => {
      const w = window as unknown as {
        __auroraLocalRegister: (s: {
          bytes: number[];
          name: string;
          type?: string;
        }) => void;
        __auroraLocalPlay: (t?: number) => Promise<{
          outcome: string;
          diagnostics: { readyState: number | null; errorCode: number | null };
        }>;
      };
      w.__auroraLocalRegister({ bytes: data, name: "repeat.opus", type: "" });
      const results: Array<{
        outcome: string;
        readyState: number | null;
        errorCode: number | null;
      }> = [];
      for (let i = 0; i < 3; i += 1) {
        const played = await w.__auroraLocalPlay(8000);
        // Poll INSIDE the page: the element must be demuxed before the next
        // playback mints another URL, which is the whole point of this spec.
        const settled = await new Promise<{ readyState: number | null; errorCode: number | null }>(
          (done) => {
            const deadline = Date.now() + 15_000;
            const tick = () => {
              const read = (window as unknown as {
                __auroraLocalDiagnostics?: () => {
                  readyState: number | null;
                  errorCode: number | null;
                  errorMessage: string | null;
                  duration: number;
                } | null;
              }).__auroraLocalDiagnostics;
              const state = read?.();
              if (!state || Date.now() > deadline) {
                done({ readyState: state?.readyState ?? null, errorCode: state?.errorCode ?? null });
                return;
              }
              if (state.errorCode !== null || state.errorMessage !== null) {
                done({ readyState: state.readyState, errorCode: state.errorCode });
                return;
              }
              if ((state.readyState ?? 0) >= 1 && state.duration > 0) {
                done({ readyState: state.readyState, errorCode: state.errorCode });
                return;
              }
              setTimeout(tick, 100);
            };
            tick();
          },
        );
        results.push({ outcome: played.outcome, ...settled });
      }
      return results;
    }, bytes);

    // The object-URL ring keeps only the two most recent URLs, so a third
    // playback is the case where a stale URL would be handed to the element.
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.errorCode).toBeNull();
      expect(outcome.outcome).not.toBe("error");
      // HAVE_METADATA each time, once the demuxer has actually had it.
      expect(outcome.readyState).toBeGreaterThanOrEqual(1);
    }
  });

  test("plays a real local file with the browser genuinely offline", async ({
    page,
    context,
  }) => {
    // THE OFFLINE CLAIM, in a real browser. Everything else in this file proves
    // that local bytes reach the element; this proves they do so with NO
    // connectivity at all, which is the requirement that actually matters.
    //
    // `context.setOffline(true)` is not a stub: Chromium drops every network
    // request AND flips `navigator.onLine`, so a playback path that secretly
    // needed the network would fail here rather than quietly pass. The page is
    // loaded FIRST, because the app shell legitimately needs the network once —
    // what is under test is what happens after connectivity is gone.
    const bytes = await recordRealAudio(page);
    await context.setOffline(true);

    const attempted: string[] = [];
    page.on("request", (request) => {
      attempted.push(request.url());
    });

    const result = await page.evaluate(async (data) => {
      const w = window as unknown as {
        __auroraLocalRegister: (s: { bytes: number[]; name: string; type?: string }) => void;
        __auroraLocalPlay: (t?: number) => Promise<{
          outcome: string;
          diagnostics: Record<string, unknown> | null;
        }>;
        __auroraLocalDiagnostics: () => Record<string, unknown> | null;
      };
      w.__auroraLocalRegister({ bytes: data, name: "offline.opus", type: "" });
      const played = await w.__auroraLocalPlay(15_000);
      return { onLine: navigator.onLine, played };
    }, bytes);

    // The browser really is offline; this is not `navigator.onLine` pretended.
    expect(result.onLine).toBe(false);
    expect(result.played.outcome).not.toBe("error");
    expect(result.played.diagnostics?.sourceScheme).toBe("blob");
    expect(result.played.diagnostics?.errorCode ?? null).toBeNull();

    // WAIT for the demuxer rather than sampling the instant the harness settled.
    // See `waitForDemuxed`: `play` fires before the container is parsed.
    expect(await waitForDemuxed(page)).toBe(true);

    // Real decoding, not a ready-but-silent element.
    const advanced = await page
      .waitForFunction(
        () => {
          const read = (window as unknown as {
            __auroraLocalDiagnostics?: () => { currentTime: number } | null;
          }).__auroraLocalDiagnostics;
          return (read?.()?.currentTime ?? 0) > 0.05;
        },
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(advanced).toBe(true);

    // And the element ended in the state real decoding produces.
    const final = await readDemuxed(page);
    expect(final?.readyState ?? 0).toBeGreaterThanOrEqual(1);
    expect(final?.duration ?? 0).toBeGreaterThan(0);
    expect(final?.errorCode ?? null).toBeNull();
    expect(final?.errorMessage ?? null).toBeNull();

    // NOTHING REACHED THE NETWORK. A `blob:` URL is the local file itself and
    // Playwright reports it as a request, so it is excluded explicitly; every
    // other entry would be a dependency the local path should not have had —
    // and with `setOffline(true)` each one would also have failed the playback.
    expect(attempted.filter((url) => !url.startsWith("blob:"))).toEqual([]);
  });

  test("an unplayable file still fails cleanly, with a usable diagnosis", async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const w = window as unknown as {
        __auroraLocalRegister: (s: { bytes: number[]; name: string; type?: string }) => void;
        __auroraLocalPlay: (t?: number) => Promise<{ outcome: string }>;
      };
      // Zero bytes: a real, genuinely unplayable local file.
      w.__auroraLocalRegister({ bytes: [], name: "empty.mp3", type: "audio/mpeg" });
      await w.__auroraLocalPlay(5000);
    });

    // WAIT for the terminal media error rather than trusting the harness's
    // settle. The harness settles on the FIRST of play / playing /
    // loadedmetadata / error, and a zero-byte blob can reach `play` before the
    // decoder rejects it — which is exactly what happened here: the settle
    // reported "playing" while the element was already failing. The condition
    // under test is that the failure is reported, so wait for it and then read
    // what the element actually said.
    const reported = await page
      .waitForFunction(
        () => {
          const read = (window as unknown as {
            __auroraLocalDiagnostics?: () => {
              errorCode: number | null;
              errorMessage: string | null;
            } | null;
          }).__auroraLocalDiagnostics;
          const state = read?.();
          return Boolean(state && (state.errorCode !== null || state.errorMessage !== null));
        },
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(reported).toBe(true);

    const failure = await page.evaluate(() => {
      const read = (window as unknown as {
        __auroraLocalDiagnostics?: () => {
          errorCode: number | null;
          errorMessage: string | null;
        } | null;
      }).__auroraLocalDiagnostics;
      return read?.() ?? null;
    });

    // Genuinely invalid input must still be reported, not swallowed. This is
    // the guard against "fixing" the bug by making failures silent.
    expect(failure?.errorCode).toBe(4);
    // The distinguishing part. While CSP was blocking every blob: source this
    // reported "Media load rejected by URL safety check", identical to the
    // local-file bug itself; it now names the real cause.
    expect(failure?.errorMessage).toContain("Format error");
    expect(failure?.errorMessage).not.toContain("URL safety check");
  });
});