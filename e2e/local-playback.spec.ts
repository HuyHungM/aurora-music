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
        // The decisive assertion: the browser demuxed the object URL and
        // reported HAVE_METADATA, which it only does after parsing the
        // container. A CSP-blocked source pins readyState at 0 with errorCode 4.
        //
        // Sampled as >= 1 rather than >= 2 on purpose. `loadedmetadata` is the
        // event this waits on, and Chromium reports exactly that state at the
        // moment it fires, climbing to HAVE_ENOUGH_DATA as `play()` proceeds.
        // Demanding >= 2 here asserts on how far the fetch happened to have got
        // at an instant when metadata was already proven, and failed against a
        // genuinely working player.
        readyState: Number(played.diagnostics?.readyState ?? -1),
        errorCode: played.diagnostics?.errorCode ?? null,
        errorMessage: played.diagnostics?.errorMessage ?? null,
        sourceScheme: played.diagnostics?.sourceScheme ?? null,
        duration: Number(played.diagnostics?.duration ?? 0),
      };
    }, bytes);

    // Local playback is a blob: source, and the resolver produced one.
    expect(result.sourceScheme).toBe("blob");
    // It must NOT fail the way the reported bug did.
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.outcome).not.toBe("error");
    // HAVE_METADATA: the container was opened and parsed.
    expect(result.readyState).toBeGreaterThanOrEqual(1);
    // A parsed duration is proof the demuxer ran, not merely that bytes arrived.
    expect(result.duration).toBeGreaterThan(0);

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
        results.push({
          outcome: played.outcome,
          readyState: played.diagnostics.readyState,
          errorCode: played.diagnostics.errorCode,
        });
      }
      return results;
    }, bytes);

    // The object-URL ring keeps only the two most recent URLs, so a third
    // playback is the case where a stale URL would be handed to the element.
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.errorCode).toBeNull();
      expect(outcome.outcome).not.toBe("error");
      // HAVE_METADATA each time: see the note in the first test.
      expect(outcome.readyState).toBeGreaterThanOrEqual(1);
    }
  });

  test("an unplayable file still fails cleanly, with a usable diagnosis", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __auroraLocalRegister: (s: {
          bytes: number[];
          name: string;
          type?: string;
        }) => void;
        __auroraLocalPlay: (t?: number) => Promise<{
          outcome: string;
          diagnostics: { errorCode: number | null; errorMessage: string | null };
        }>;
      };
      // Zero bytes: a real, genuinely unplayable local file.
      w.__auroraLocalRegister({ bytes: [], name: "empty.mp3", type: "audio/mpeg" });
      const played = await w.__auroraLocalPlay(5000);
      return {
        outcome: played.outcome,
        errorCode: played.diagnostics.errorCode,
        errorMessage: played.diagnostics.errorMessage,
      };
    });

    // Genuinely invalid input must still be reported, not swallowed. This is
    // the guard against "fixing" the bug by making failures silent.
    expect(result.outcome).toBe("error");
    expect(result.errorCode).toBe(4);
    // The distinguishing part. While CSP was blocking every blob: source this
    // reported "Media load rejected by URL safety check", identical to the
    // local-file bug itself; it now names the real cause.
    expect(result.errorMessage).toContain("Format error");
    expect(result.errorMessage).not.toContain("URL safety check");
  });
});