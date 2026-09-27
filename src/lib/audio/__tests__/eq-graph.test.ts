/**
 * The audio graph's behaviour, driven by a fake Web Audio implementation.
 *
 * WHY A FAKE AND NOT A BROWSER. The properties that matter here - that a preset
 * change does not rebuild the graph, that a parameter change is ramped rather
 * than stepped, that bypass is unity rather than a disconnect, that a failure
 * never touches the media element, that the context is created exactly once -
 * are all *structural*. None of them is a property of the audio, and all of
 * them are observable from the node graph. jsdom has no working `AudioContext`
 * at all, so a fake is the only way to test them, and they are precisely the
 * claims addendum §28, §29 and §33 make.
 *
 * THE FAKE IS FAITHFUL ABOUT THE TWO THINGS THAT MATTER. It records every
 * scheduled automation event rather than collapsing to a final value, because
 * "did it ramp" is a question about the schedule and not about the destination.
 * And `createMediaElementSource` THROWS, because that is what a browser does
 * when the element cannot be re-homed, and the order-of-operations guarantee
 * this file exists to defend is only meaningful if the throw is real.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  EqGraph,
  EQ_RAMP_SECONDS,
  resetEqGraphForTests,
  getEqGraph,
  setEqElementResolver,
} from "@/lib/audio/eq-graph";
import {
  AURORA_V_SHAPE,
  FLAT_BANDS,
  cloneBands,
  effectiveGraphState,
  selectPreset,
  setBandGain,
} from "@/lib/audio/eq";

/* ==========================================================================
   THE FAKE

   It lives in `fake-web-audio.ts` alongside these tests, so that `eq-store`
   can prime the same graph singleton and prove the whole chain - an action,
   through the store, into an `AudioParam` - rather than half of it.
   ========================================================================== */

import { FakeContext, fakeAudioElement } from "./fake-web-audio";

const element = fakeAudioElement();

function harness(
  options: {
    element?: unknown | null;
    sourceThrows?: boolean;
    resumeTimeoutMs?: number;
  } = {},
): {
  context: FakeContext;
  contextsCreated: () => number;
  gesture: () => void;
  graph: EqGraph;
  reasons: string[];
} {
  const reasons: string[] = [];
  const context = new FakeContext();
  context.sourceThrows = options.sourceThrows ?? false;
  // COUNTED, NOT MERELY HELD. This harness used to derive the figure from an
  // array that nothing ever pushed to after the first element, so it reported
  // `1` no matter how many times `createContext` actually ran - which made
  // "creates the AudioContext exactly once" (§26) impossible to fail, and made
  // the no-second-engagement guarantee untestable.
  let created = 0;
  // A gesture source of our own, because this suite runs in Node: there is no
  // `document` here to dispatch on, and a retry path that only ever worked
  // against a real DOM would be the one part of the fix with no coverage.
  let gestureHandler: (() => void) | null = null;
  const graph = new EqGraph({
    createContext: () => {
      created += 1;
      return context;
    },
    getElement: () => ("element" in options ? options.element : element),
    onUnsupported: (reason) => reasons.push(reason),
    resumeTimeoutMs: options.resumeTimeoutMs,
    onUserGesture: (handler) => {
      gestureHandler = handler;
      return () => {
        if (gestureHandler === handler) {
          gestureHandler = null;
        }
      };
    },
  });
  const gesture = (): void => {
    const handler = gestureHandler;
    // Detached first, exactly as the graph's own handler does, so a listener
    // left subscribed after `dispose()` would still be reachable here.
    gestureHandler = null;
    handler?.();
  };
  return { context, contextsCreated: () => created, gesture, graph, reasons };
}

/** Polls a condition set by asynchronous work started outside `await`. */
async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const vShapeState = effectiveGraphState({
  ...selectPreset("aurora-v"),
  enabled: true,
});

/* ==========================================================================
   ENGAGEMENT
   ========================================================================== */

describe("engaging the graph", () => {
  it("builds exactly ten filters and one preamp gain, chained in order", async () => {
    const { graph, context } = harness();
    await expect(graph.engage(vShapeState)).resolves.toBe(true);

    expect(context.filters).toHaveLength(10);
    expect(context.gains).toHaveLength(1);
    expect(graph.nodeCount).toBe(10);

    // 31 Hz first, 16 kHz last, each feeding the next.
    expect(context.filters[0]!.frequency.value).toBe(31);
    expect(context.filters[9]!.frequency.value).toBe(16_000);
    for (let i = 0; i < 9; i += 1) {
      expect(context.filters[i]!.connections[0]).toBe(context.filters[i + 1]!);
    }
    // The last filter feeds the preamp, and the preamp feeds the destination.
    expect(context.filters[9]!.connections[0]).toBe(context.gains[0]!);
    expect(context.gains[0]!.connections[0]).toBe(context.destination);
  });

  it("creates the AudioContext exactly once, however many times it is asked", async () => {
    // Addendum §26, §27. A second context is a second audio path.
    const { graph, contextsCreated } = harness();
    await graph.engage(vShapeState);
    await graph.engage(vShapeState);
    await graph.engage(vShapeState);
    expect(contextsCreated()).toBe(1);
    expect(graph.isEngaged).toBe(true);
  });

  it("re-homes the canonical element, and only that element", async () => {
    // §26. The graph must never create or seek an audio element of its own.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    expect(context.sourcedElement).toBe(element);
    expect(context.sourceCalls).toBe(1);
  });

  it("resumes the context from a gesture path without ever calling play", async () => {
    // Addendum §34: the context may start suspended on iOS, and resuming it is
    // not playback, so it cannot trip an autoplay policy.
    const { graph, context } = harness();
    expect(context.state).toBe("suspended");
    await graph.engage(vShapeState);
    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe("running");
  });

  it("never re-homes the element into a context that cannot be resumed", async () => {
    // THE SILENCE BUG, AND THE GUARD THAT REMOVES IT.
    //
    // The old contract asserted that a failed resume still engaged - "the
    // graph is wired correctly and will start on the next gesture". It will
    // not: nothing in this feature ever calls `resume()` again, and `engage()`
    // does not rebuild once the graph reports itself engaged. Re-homing into a
    // suspended context routes the element into something that produces no
    // sound, permanently, and no mode switch can bring it back.
    //
    // So the door stays shut. The element is never touched, the inert chain is
    // discarded, and the attempt is deferred rather than recorded as a
    // failure - a suspended context is an ordinary lifecycle state, not a
    // browser that lacks Web Audio.
    const { graph, context } = harness();
    context.resume = async () => {
      throw new Error("NotAllowedError");
    };

    await expect(graph.engage(vShapeState)).resolves.toBe(false);

    expect(graph.isEngaged).toBe(false);
    expect(context.sourceCalls).toBe(0);
    expect(context.sourcedElement).toBeNull();
    expect(context.closeCalls).toBe(1);
    // Deferred, not broken: the interface must not report the EQ unsupported.
    expect(graph.isAwaitingGesture).toBe(true);
    expect(graph.unsupportedReason).toBeNull();
    // And the listener's audio was never at risk - it kept playing directly.
    expect(graph.health().contextState).toBe("none");
  });

  it("engages on the next gesture once the browser allows the context", async () => {
    const { context, gesture, graph } = harness();
    let allowed = false;
    context.resume = async () => {
      if (!allowed) {
        throw new Error("NotAllowedError");
      }
      context.state = "running";
    };

    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(context.sourceCalls).toBe(0);

    allowed = true;
    gesture();
    await until(() => graph.isEngaged);

    expect(graph.isAwaitingGesture).toBe(false);
    expect(context.sourceCalls).toBe(1);
    expect(context.filters[0]!.gain.value).toBe(2.5);
  });

  it("never starts a second engagement while one is in flight", async () => {
    // §18. The store pushes on EVERY configuration change and does not await
    // the result, and the first engagement always has to wait - on `resume()`.
    // A second engagement begun in that window builds a second context and a
    // second chain, then loses the race for the element and reports
    // `no-source`, which `decline()` stores PERMANENTLY: the equalizer would
    // be dead for the rest of the page's life.
    const { graph, context, contextsCreated } = harness({ resumeTimeoutMs: 20 });
    context.resume = () => new Promise<void>(() => undefined);

    const first = graph.engage(vShapeState);
    const second = graph.engage(vShapeState);

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(contextsCreated()).toBe(1);
    expect(graph.isAwaitingGesture).toBe(true);
    expect(graph.unsupportedReason).toBeNull();
  });
});

/* ==========================================================================
   THE ONE-WAY DOOR - failures must never cost the listener their audio
   ========================================================================== */

describe("declining to engage", () => {
  it("reports no-element and does not create a context at all", async () => {
    // The EQ must not fall back to an element of its own; a second audio path
    // is worse than no equalizer.
    const { graph, context, reasons } = harness({ element: null });
    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(reasons).toEqual(["no-element"]);
    expect(context.filters).toHaveLength(0);
    expect(context.sourceCalls).toBe(0);
    expect(graph.isEngaged).toBe(false);
  });

  it("reports no-web-audio when the constructor throws, leaving the element alone", async () => {
    const { graph, reasons } = harness();
    graph["deps"].createContext = () => {
      throw new Error("Web Audio is unavailable");
    };
    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(reasons).toEqual(["no-web-audio"]);
    expect(graph.unsupportedReason).toBe("no-web-audio");
  });

  it("never re-homes the element when building the chain throws mid-way", async () => {
    // The ordering guarantee: the element is the LAST thing touched. If filter
    // construction fails, playback is exactly as it was.
    const { graph, context, reasons } = harness();
    let created = 0;
    const original = context.createBiquadFilter.bind(context);
    context.createBiquadFilter = () => {
      created += 1;
      if (created === 4) {
        throw new Error("allocation failed");
      }
      return original();
    };
    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(context.sourceCalls).toBe(0);
    expect(context.sourcedElement).toBeNull();
    expect(reasons).toEqual(["no-web-audio"]);
  });

  it("never re-homes the element when createMediaElementSource itself throws", async () => {
    // §33's hardest case: a browser that refuses the element. The element keeps
    // playing directly, and the inert chain is discarded rather than left
    // dangling.
    const { graph, context, reasons } = harness({ sourceThrows: true });
    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(reasons).toEqual(["no-source"]);
    expect(context.sourcedElement).toBeNull();
    expect(context.closeCalls).toBe(1);
    // Nothing is left connected to a destination that nothing feeds.
    for (const filter of context.filters) {
      expect(filter.disconnectCount).toBeGreaterThan(0);
    }
  });

  it("does not retry after a decline", async () => {
    // A decline is a decision, not a transient error. Retrying would risk the
    // one-way door being opened on a later attempt under worse conditions.
    const { graph, context } = harness({ element: null });
    await graph.engage(vShapeState);
    await graph.engage(vShapeState);
    await graph.engage(vShapeState);
    expect(context.filters).toHaveLength(0);
  });
});

/* ==========================================================================
   CHANGING THE CURVE WITHOUT REBUILDING
   ========================================================================== */

describe("preset changes update parameters, never the graph (addendum §28)", () => {
  beforeEach(() => {
    resetEqGraphForTests();
  });

  it("writes to the same ten nodes when the preset changes", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);

    const flat = effectiveGraphState({ ...selectPreset("flat"), enabled: true });
    graph.apply(flat);

    // Same objects. No node was created, destroyed or reconnected.
    expect(context.filters).toHaveLength(10);
    expect(context.gains).toHaveLength(1);
    expect(context.sourceCalls).toBe(1);
    expect(context.filters[0]!.connections[0]).toBe(context.filters[1]!);
    expect(context.filters[0]!.gain.value).toBe(0);
    expect(context.filters[0]!.disconnectCount).toBe(0);
  });

  it("restores the complete curve on the way back to Aurora V-Shape", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.apply(effectiveGraphState({ ...selectPreset("flat"), enabled: true }));
    graph.apply(vShapeState);

    expect(context.filters.map((f) => f.gain.value)).toEqual(
      AURORA_V_SHAPE.map((b) => b.gain),
    );
    // -3.5 dB in linear amplitude, not 3.5.
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-3.5 / 20), 6);
  });

  it("points an ALREADY BUILT graph at the new configuration", async () => {
    // THE MODE-SWITCH DEFECT.
    //
    // `engage()` used to return `this.engaged` as soon as the graph existed,
    // silently dropping the state it was handed - and the store routes every
    // enabled-state change through `engage()` and nowhere else. A preset
    // switch, a band drag, an A/B release and an EQ re-enable therefore
    // updated the interface and nothing else: the audio kept whatever curve it
    // already had, and after a bypass it stayed flat for the rest of the
    // session. Being BUILT and being TOLD the current curve are two different
    // questions, and this is the second one.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    expect(context.filters[0]!.gain.value).toBe(2.5);

    const flat = effectiveGraphState({ ...selectPreset("flat"), enabled: true });
    await expect(graph.engage(flat)).resolves.toBe(true);

    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (flat.preampDb / 20), 6);
    // Same ten nodes, same context, one re-homing: nothing was rebuilt (§28).
    expect(context.filters).toHaveLength(10);
    expect(context.sourceCalls).toBe(1);
    expect(context.closeCalls).toBe(0);
  });

  it("carries a dragged band into the graph without touching anything else", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    const custom = setBandGain(selectPreset("aurora-v"), 1, 6);
    graph.apply(effectiveGraphState({ ...custom, enabled: true }));

    expect(context.filters[1]!.gain.value).toBe(6);
    expect(context.filters[0]!.gain.value).toBe(2.5);
    expect(context.filters).toHaveLength(10);
    expect(context.closeCalls).toBe(0);
  });

  it("ignores an apply() before engagement rather than throwing", () => {
    const { graph } = harness();
    expect(() => graph.apply(vShapeState)).not.toThrow();
  });

  it("survives a configuration with a different number of bands", async () => {
    // Defensive: a short list must not leave stale gains behind, and a long one
    // must not write past the end.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.apply({ bands: [{ frequency: 100, gain: 3, q: 1 }], preampDb: 0 });
    expect(context.filters[0]!.gain.value).toBe(3);
    graph.apply({
      bands: Array.from({ length: 40 }, (_, i) => ({
        frequency: 20 * 2 ** i,
        gain: 1,
        q: 1,
      })),
      preampDb: -3,
    });
    expect(context.filters[9]!.gain.value).toBe(1);
    expect(context.filters).toHaveLength(10);
  });
});

/* ==========================================================================
   SMOOTHING
   ========================================================================== */

describe("parameter smoothing (addendum §29)", () => {
  it("cancels, anchors, then ramps - in that order, every time", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    const param = context.filters[1]!.gain;
    param.events.length = 0;

    graph.apply(
      effectiveGraphState({
        ...setBandGain(selectPreset("aurora-v"), 1, -4),
        enabled: true,
      }),
    );

    const kinds = param.events.map((e) => e.kind);
    // A ramp with no anchor ramps from whatever the last event left, which on a
    // fresh gain is 0 - an audible full-scale jump on the first drag.
    expect(kinds).toEqual(["cancel", "set", "ramp"]);
    const [, set, rampEvent] = param.events;
    expect(set!.value).toBe(3.0);
    expect(rampEvent!.value).toBe(-4);
    expect(rampEvent!.time - set!.time).toBeCloseTo(EQ_RAMP_SECONDS, 6);
  });

  it("ramps by a short, inaudible amount", () => {
    // 30 ms: long enough to avoid a click, short enough to feel responsive.
    expect(EQ_RAMP_SECONDS).toBeGreaterThanOrEqual(0.01);
    expect(EQ_RAMP_SECONDS).toBeLessThanOrEqual(0.1);
  });

  it("does not ramp a value that is already there", async () => {
    // Re-applying the same curve must not stack schedules; a dragged slider
    // otherwise ends up chasing a queue of stale targets.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    const param = context.filters[3]!.gain;
    param.events.length = 0;
    graph.apply(vShapeState);
    expect(param.events.filter((e) => e.kind === "ramp")).toHaveLength(0);
  });

  it("smooths the filter sweep as well as the gain", async () => {
    // A centre frequency that jumps while the gain is already moving is audible
    // in a way that smoothing only one of the two would not fix.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    const param = context.filters[0]!.frequency;
    param.events.length = 0;
    graph.apply({ ...vShapeState, bands: [{ frequency: 40, gain: 1, q: 1 }] });
    expect(param.events.map((e) => e.kind)).toEqual(["cancel", "set", "ramp"]);
  });

  it("refuses a non-finite value instead of putting NaN in an AudioParam", async () => {
    // Web Audio throws on a NaN param rather than treating it as silence, so a
    // guard is load-bearing rather than defensive decoration.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    const named = context.filters[0]!.gain;
    const unnamed = context.filters[2]!.gain;
    named.events.length = 0;
    unnamed.events.length = 0;

    // A one-band list: index 0 carries the NaN, and indices 1-9 are absent.
    graph.apply({
      bands: [{ frequency: 125, gain: Number.NaN, q: 1 }],
      preampDb: Number.NaN,
    });

    // The NaN gain is not scheduled at all.
    expect(named.events).toHaveLength(0);
    expect(named.value).toBe(2.5);
    // A band the list does not mention is actively zeroed, never left boosted.
    expect(unnamed.value).toBe(0);
    // And a NaN preamp resolves to unity rather than to NaN.
    expect(Number.isNaN(context.gains[0]!.gain.value)).toBe(false);
    expect(context.gains[0]!.gain.value).toBe(1);
  });
});

/* ==========================================================================
   BYPASS
   ========================================================================== */

describe("bypass is unity through the live graph (addendum §12)", () => {
  it("sets every band and the preamp to neutral without disconnecting", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.bypass();

    expect(context.filters.every((f) => f.gain.value === 0)).toBe(true);
    expect(context.gains[0]!.gain.value).toBe(1);
    // Nothing was torn down. This is not an optimisation: the element's audio
    // only reaches the speakers by travelling through these nodes, so
    // disconnecting here would be silence, not a bypass.
    expect(context.filters.every((f) => f.disconnectCount === 0)).toBe(true);
    expect(context.gains[0]!.disconnectCount).toBe(0);
    expect(context.closeCalls).toBe(0);
    expect(context.sourceCalls).toBe(1);
  });

  it("keeps the filter frequencies, so a re-enable is instant", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.bypass();
    expect(context.filters.map((f) => f.frequency.value)).toEqual(
      FLAT_BANDS.map((b) => b.frequency),
    );
  });
});

/* ==========================================================================
   DISPOSAL AND THE SINGLETON
   ========================================================================== */

describe("disposal", () => {
  it("closes the context and disconnects everything, exactly once", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.dispose();
    graph.dispose();

    expect(context.closeCalls).toBe(1);
    expect(context.filters.every((f) => f.disconnectCount > 0)).toBe(true);
    expect(graph.isDisposed).toBe(true);
    expect(graph.isEngaged).toBe(false);
  });

  it("refuses to engage again after disposal", async () => {
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.dispose();
    await expect(graph.engage(vShapeState)).resolves.toBe(false);
    expect(context.sourceCalls).toBe(1);
  });
});

describe("the module singleton", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    setEqElementResolver(() => null);
  });

  it("is one graph for the whole page, whatever the caller passes", () => {
    const a = getEqGraph({ createContext: () => new FakeContext(), getElement: () => null });
    const b = getEqGraph();
    expect(b).toBe(a);
  });

  it("declines cleanly when nothing has registered an element", async () => {
    // Startup order is not something to rely on: the shell registers the
    // element, and until it does the EQ is simply unavailable.
    const graph = getEqGraph();
    expect(await graph.engage(vShapeState)).toBe(false);
    expect(graph.unsupportedReason).toBe("no-element");
  });

  it("uses the registered resolver once one exists", async () => {
    resetEqGraphForTests();
    const context = new FakeContext();
    setEqElementResolver(() => element);
    const graph = getEqGraph({ createContext: () => context, getElement: () => element });
    await graph.engage(vShapeState);
    expect(context.sourcedElement).toBe(element);
  });

  it("does not create a graph that survives being reset", () => {
    const first = getEqGraph();
    resetEqGraphForTests();
    const second = getEqGraph();
    expect(second).not.toBe(first);
  });
});

describe("the neutral bypass shape", () => {
  it("uses the same ten canonical centres as the model's, not an octave grid", async () => {
    // The regression this guards is subtle and real: a first version of
    // `bypass()` built its band list with `20 * 2 ** n`, which yields 20, 40,
    // 80 ... 20 480 - an octave grid that is NOT the shipped one (31, 62, 125
    // ... 16 000). A bypassed EQ on the wrong centres is not flat, it is merely
    // different, and nothing about the failure looks like a frequency error.
    //
    // Awaited, unlike a fire-and-forget variant that asserted only about the
    // model and so proved nothing about the graph.
    const { graph, context } = harness();
    await graph.engage(vShapeState);
    graph.bypass();

    expect(context.filters.map((f) => f.frequency.value)).toEqual(
      FLAT_BANDS.map((b) => b.frequency),
    );
    expect(cloneBands(FLAT_BANDS).every((b) => b.gain === 0)).toBe(true);
  });
});
