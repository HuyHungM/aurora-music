import type { Page } from "@playwright/test";

/**
 * Counters for the two Web Audio APIs no DOM observation can see.
 *
 * Extracted from `equalizer.spec.ts` because the same question is asked in two
 * places: once without playback (does a preset change rebuild the graph?) and
 * once during playback (does switching modes while music is playing rebuild it
 * or re-home the element a second time?). Two copies would be two descriptions
 * of one contract, and they would drift.
 *
 * Fully offline-safe: nothing here needs a track, a network or a credential.
 */

/** Instrument `AudioContext` construction and `createMediaElementSource`. */
export async function instrumentEQ(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counters = {
      contexts: 0,
      sourceCalls: 0,
      elements: [] as unknown[],
      errors: [] as string[],
      context: null as unknown,
      sourceNode: null as unknown,
      preampNode: null as unknown,
    };
    (window as unknown as { __eq: typeof counters }).__eq = counters;

    const Native = window.AudioContext;
    if (Native) {
      class CountingContext extends Native {
        constructor(...args: ConstructorParameters<typeof Native>) {
          super(...args);
          counters.contexts += 1;
          counters.context = this;
        }
        override createMediaElementSource(
          element: HTMLMediaElement,
        ): MediaElementAudioSourceNode {
          counters.sourceCalls += 1;
          counters.elements.push(element);
          const node = super.createMediaElementSource(element);
          counters.sourceNode = node;
          return node;
        }
        override createGain(): GainNode {
          const node = super.createGain();
          // The equalizer builds exactly one gain — the preamp — and it is the
          // last thing wired to `destination`, so this is the point where the
          // curve leaves the graph. Only the FIRST one is kept: a test that
          // samples the graph creates its own nodes on the same context, and
          // those must not displace it.
          if (counters.preampNode === null) {
            counters.preampNode = node;
          }
          return node;
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
export async function eqCounters(page: Page): Promise<{
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

/** The visible number of `<audio>` elements in the document. */
export async function audioElementCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("audio").length);
}

/**
 * Peak RMS measured at a point inside the live graph, over ~1.5 seconds.
 *
 * WHY THIS EXISTS. Everything else in these specs can be satisfied by a graph
 * that is built, wired and error-free while producing **nothing at the
 * speakers**: `ARCHITECTURE.md` §33.8 names the case — a
 * `MediaElementAudioSourceNode` over a CORS-cross-origin stream whose response
 * lacks CORS headers outputs silence by specification — and records it as the
 * one defect in this feature that no test in the repository could see.
 *
 * This is the test that sees it. The analyser is a side branch of the node
 * under test, and its output goes through a zero-gain node into `destination`
 * — the zero is what makes the branch part of the rendering graph (an
 * analyser with nothing downstream is never pulled and reads 0 regardless) and
 * what keeps it inaudible. Real decoded audio therefore comes back as a
 * number well above zero; a CORS-blocked or disconnected element comes back
 * as exactly 0.
 *
 * Returns `-1` when the graph is not there to measure, so a missing graph
 * fails as "not built" at the counter assertions rather than here.
 */
export async function measureGraphRms(
  page: Page,
  which: "source" | "preamp",
): Promise<number> {
  return page.evaluate(async (target) => {
    const box = (window as unknown as { __eq?: unknown }).__eq as {
      context?: unknown;
      sourceNode?: unknown;
      preampNode?: unknown;
    } | null;
    const context = box?.context as AudioContext | undefined;
    const tapped = (
      target === "source" ? box?.sourceNode : box?.preampNode
    ) as AudioNode | undefined;
    if (!context || !tapped || context.state !== "running") {
      return -1;
    }

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    // `new GainNode(context)`, not `context.createGain()`: the instrumentation
    // wraps `createGain` to find the preamp, and this scratch node must not
    // look like one.
    const sink = new GainNode(context);
    sink.gain.value = 0;
    tapped.connect(analyser);
    analyser.connect(sink);
    sink.connect(context.destination);

    const buffer = new Float32Array(analyser.fftSize);
    const read = (): number => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const value = buffer[i] ?? 0;
        sum += value * value;
      }
      return Math.sqrt(sum / buffer.length);
    };
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // Three windows spread over ~1.5 s, so a single quiet passage in the
    // music cannot be mistaken for silence from the graph.
    await pause(500);
    let peak = read();
    await pause(500);
    peak = Math.max(peak, read());
    await pause(500);
    peak = Math.max(peak, read());

    tapped.disconnect(analyser);
    analyser.disconnect();
    sink.disconnect();
    return peak;
  }, which);
}
