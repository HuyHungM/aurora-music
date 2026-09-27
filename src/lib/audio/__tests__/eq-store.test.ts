/**
 * The canonical EQ state (Phase 53 addendum, §42, §49).
 *
 * These tests drive the real store against a fake graph, because the claims
 * worth testing here are about SEQUENCE - what state exists after a given series
 * of actions - and a sequence is only meaningful against the thing it acts on.
 * `eq-store` has no `resetForTests` for the state itself, deliberately: a
 * testing-only reset of a singleton is a second way to reach the value, and the
 * discipline this codebase follows is one authority. The store is reset through
 * its own `reset()` action, which is also the only path production uses.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  eqActions,
  getEqState,
  subscribeEq,
  effectiveBands,
  effectivePreampDb,
  declaredPreampDb,
  autoPreampFor,
  requiredPreampFor,
  isHeadroomSaturatedFor,
} from "@/lib/audio/eq-store";
import {
  AURORA_V_SHAPE,
  DEFAULT_PREAMP_DB,
  FLAT_BANDS,
  SAFETY_MARGIN_DB,
  cloneBands,
  compositeMaxGainDb,
  maxBandGainDb,
  selectPreset,
  setBandGain,
  type EQConfig,
} from "@/lib/audio/eq";
import { resetEqGraphForTests, getEqGraph } from "@/lib/audio/eq-graph";
import { FakeContext, fakeAudioElement } from "./fake-web-audio";

/** A configuration with the equalizer on, so graph engagement is possible. */
function on(config: EQConfig): EQConfig {
  return { ...config, enabled: true };
}

describe("the store starts at the shipped default", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
    eqActions.setComparing(false);
  });

  it("is off, on the V-Shape, with automatic headroom", () => {
    const { config } = getEqState();
    expect(config.enabled).toBe(false);
    expect(config.presetId).toBe("aurora-v");
    expect(config.bands).toEqual([...AURORA_V_SHAPE]);
    expect(config.preampMode).toBe("auto");
  });

  it("does not engage the graph while the equalizer is off", () => {
    // §27: a page load must not spin up an audio graph nobody asked for.
    expect(getEqGraph().isEngaged).toBe(false);
  });
});

describe("preset switching replaces bands AND headroom together (§9, §49)", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
  });

  it("walks V-Shape, Flat, V-Shape, Custom, V-Shape", () => {
    const seen: Array<{ preset: string; peak: number; preamp: number; mode: string }> = [];

    for (const preset of ["flat", "aurora-v", "custom", "aurora-v"] as const) {
      eqActions.choosePreset(preset);
      const { config } = getEqState();
      seen.push({
        preset,
        peak: maxBandGainDb(config.bands),
        preamp: effectivePreampDb(config),
        mode: config.preampMode,
      });
    }

    // Flat is genuinely flat and genuinely at zero preamp. If -3.5 dB had
    // survived the switch, this is the assertion that would catch it.
    expect(seen[0]).toEqual({ preset: "flat", peak: 0, preamp: 0, mode: "manual" });
    expect(seen[1]).toEqual({ preset: "aurora-v", peak: 3, preamp: -3.5, mode: "manual" });
    // Custom enters automatic, which recomputes rather than adopting -3.5.
    expect(seen[2]!.preset).toBe("custom");
    expect(seen[2]!.mode).toBe("auto");
    expect(seen[3]).toEqual({ preset: "aurora-v", peak: 3, preamp: -3.5, mode: "manual" });
  });

  it("never leaves the V-Shape's -3.5 dB attached to Flat", () => {
    eqActions.choosePreset("aurora-v");
    eqActions.choosePreset("flat");
    expect(effectivePreampDb(getEqState().config)).toBe(0);
    expect(declaredPreampDb("flat")).toBe(0);
    expect(effectiveBands(getEqState().config).every((b) => b.gain === 0)).toBe(true);
  });

  it("declares -3.5 for the V-Shape regardless of the curve arithmetic", () => {
    // §52: the declared figure is a design decision, not a computed one.
    // `autoPreampFor` on the same bands gives -4.33, and the two must not be
    // confused for each other anywhere.
    eqActions.choosePreset("aurora-v");
    expect(declaredPreampDb("aurora-v")).toBe(DEFAULT_PREAMP_DB);
    expect(autoPreampFor(AURORA_V_SHAPE)).toBeCloseTo(-4.33, 2);
  });
});

describe("editing a band", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
  });

  it("leaves the preset, because a hand-edited curve is not a preset", () => {
    eqActions.choosePreset("aurora-v");
    eqActions.setBandGain(1, 6);
    expect(getEqState().config.presetId).toBe("custom");
    expect(getEqState().config.bands[1]!.gain).toBe(6);
    expect(getEqState().config.preampMode).toBe("auto");
  });

  it("reassesses headroom for a bigger boost (§7)", () => {
    // From FLAT, so the arithmetic is the clean §7 example: a lone +6 dB band
    // needs about -6.5 dB, and must not ride on the shipped preset's -3.5.
    eqActions.choosePreset("flat");
    eqActions.setBandGain(1, 6);
    const preamp = effectivePreampDb(getEqState().config);
    expect(preamp).toBeLessThan(DEFAULT_PREAMP_DB);
    expect(preamp).toBeCloseTo(-6.5, 1);
  });

  it("accounts for a boost stacked on the V-Shape's own bass", () => {
    // The composite figure earning its keep: raising 62 Hz from +3 to +6 on top
    // of the +2.5 at 31 Hz and the +2.0 at 125 Hz peaks HIGHER than 6 dB, so the
    // naive "one band at +6" answer would under-compensate by most of a
    // decibel. This is why the ceiling is the transfer function.
    eqActions.choosePreset("aurora-v");
    eqActions.setBandGain(1, 6);
    const composite = compositeMaxGainDb(getEqState().config.bands);
    expect(composite).toBeGreaterThan(6);
    expect(requiredPreampFor(getEqState().config.bands)).toBeCloseTo(
      -(composite + SAFETY_MARGIN_DB),
      6,
    );
  });

  it("reports what a curve needs, and whether the range can express it", () => {
    eqActions.choosePreset("flat");
    eqActions.setBandGain(1, 6);
    expect(requiredPreampFor(getEqState().config.bands)).toBeCloseTo(-6.5, 1);
    expect(isHeadroomSaturatedFor(getEqState().config.bands)).toBe(false);

    // Every band at the top of its range, which the -12 dB floor cannot express.
    for (let index = 0; index < 10; index += 1) {
      eqActions.setBandGain(index, 12);
    }
    expect(isHeadroomSaturatedFor(getEqState().config.bands)).toBe(true);
  });

  it("ignores an out-of-range index instead of writing past the end", () => {
    eqActions.choosePreset("aurora-v");
    const before = getEqState().config;
    eqActions.setBandGain(-1, 6);
    eqActions.setBandGain(10, 6);
    expect(getEqState().config).toBe(before);
  });

  it("re-applies a preset that is NAMED but not actually in effect", () => {
    // The bug this guards: a document can say `aurora-v` and carry different
    // gains - a hand-edited cookie, or a row from a build that shipped a
    // different curve. A store that short-circuits on the preset id would leave
    // the interface labelling the V-Shape while playing something else, and the
    // listener's only route to the real curve would be selecting something else
    // first.
    eqActions.hydrate({
      ...selectPreset("aurora-v"),
      bands: cloneBands(getEqState().config.bands).map((band) => ({
        ...band,
        gain: 0,
      })),
    });
    expect(getEqState().config.presetId).toBe("aurora-v");
    expect(maxBandGainDb(getEqState().config.bands)).toBe(0);

    eqActions.choosePreset("aurora-v");
    expect(maxBandGainDb(getEqState().config.bands)).toBe(3);
    expect(getEqState().config.manualPreampDb).toBe(-3.5);
  });

  it("does not turn the equalizer on when a preset is genuinely already applied", () => {
    // Radio semantics: re-selecting the selected option is a no-op. On/off is
    // the switch's job, and a radio that also switches a DSP on is a control
    // doing two things badly instead of one thing well.
    eqActions.reset();
    eqActions.choosePreset("aurora-v");
    expect(getEqState().config.enabled).toBe(true);

    eqActions.setEnabled(false);
    eqActions.choosePreset("aurora-v");
    expect(getEqState().config.enabled).toBe(false);
  });
});

describe("preamp mode (§38)", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
    eqActions.choosePreset("aurora-v");
  });

  it("seeds the manual slider with whatever is in effect, so it does not jump", () => {
    // The preset's -3.5 becomes the manual starting point rather than the
    // default's, which would move the control under the listener's hand.
    eqActions.setPreampMode("manual");
    expect(getEqState().config.manualPreampDb).toBe(-3.5);
    expect(effectivePreampDb(getEqState().config)).toBe(-3.5);
  });

  it("clamps a manual value into range and never positive (§10)", () => {
    eqActions.setPreampMode("manual");
    eqActions.setManualPreamp(6);
    expect(getEqState().config.manualPreampDb).toBe(0);
    eqActions.setManualPreamp(-99);
    expect(getEqState().config.manualPreampDb).toBe(-12);
  });

  it("recomputes when switched back to automatic", () => {
    eqActions.setPreampMode("manual");
    eqActions.setManualPreamp(-12);
    eqActions.setPreampMode("auto");
    // Back to the curve's own requirement, not to the manual -12.
    expect(effectivePreampDb(getEqState().config)).toBeCloseTo(
      -(compositeMaxGainDb(getEqState().config.bands) + SAFETY_MARGIN_DB),
      6,
    );
  });
});

describe("bypass (§12)", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
    eqActions.choosePreset("aurora-v");
  });

  it("is neutral while off, whatever is stored", () => {
    eqActions.setEnabled(false);
    expect(effectivePreampDb(getEqState().config)).toBe(0);
    expect(effectiveBands(getEqState().config).every((b) => b.gain === 0)).toBe(true);
    // The stored curve is untouched, so turning it back on restores it exactly.
    expect(maxBandGainDb(getEqState().config.bands)).toBe(3);
  });

  it("is neutral while comparing, and restores on release (§23)", () => {
    eqActions.setComparing(true);
    expect(effectivePreampDb(getEqState().config)).toBe(0);
    expect(effectiveBands(getEqState().config).every((b) => b.gain === 0)).toBe(true);
    // The configuration is NOT modified by a comparison - it is a view, not an
    // edit, and a listener who lets go of the button gets their curve back.
    expect(maxBandGainDb(getEqState().config.bands)).toBe(3);

    eqActions.setComparing(false);
    expect(effectivePreampDb(getEqState().config)).toBe(-3.5);
  });
});

describe("reset", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
  });

  it("restores the shipped default in isolation", () => {
    eqActions.choosePreset("flat");
    eqActions.setBandGain(3, -9);
    eqActions.setPreampMode("manual");
    eqActions.setManualPreamp(-8);
    eqActions.setComparing(true);

    eqActions.reset();

    const state = getEqState();
    expect(state.config.enabled).toBe(false);
    expect(state.config.presetId).toBe("aurora-v");
    expect(state.config.bands).toEqual([...AURORA_V_SHAPE]);
    expect(state.config.preampMode).toBe("auto");
    expect(state.comparing).toBe(false);
  });
});

describe("subscription (§42)", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
  });

  it("notifies subscribers on a configuration change", () => {
    let notifications = 0;
    const unsubscribe = subscribeEq(() => {
      notifications += 1;
    });
    eqActions.choosePreset("flat");
    unsubscribe();
    expect(notifications).toBeGreaterThan(0);
  });

  it("stops notifying after unsubscribe", () => {
    let notifications = 0;
    const unsubscribe = subscribeEq(() => {
      notifications += 1;
    });
    unsubscribe();
    eqActions.choosePreset("flat");
    expect(notifications).toBe(0);
  });

  it("does not loop when a subscriber writes the save status", () => {
    // The store's own persistence path calls `setSaveStatus` from inside a
    // subscriber. An unguarded assignment there re-notifies that same
    // subscriber forever - an infinite loop whose only symptom is a spinning
    // tab. This asserts the guard by counting the rounds.
    let notifications = 0;
    const unsubscribe = subscribeEq(() => {
      notifications += 1;
      eqActions.setSaveStatus("saved");
    });
    eqActions.choosePreset("flat");
    unsubscribe();

    // A configuration change, plus the save-status change it causes, plus the
    // no-op second attempt. Bounded and small; an unbounded run would hang here.
    expect(notifications).toBeLessThanOrEqual(3);
    expect(getEqState().saveStatus).toBe("saved");
  });

  it("bumps the revision once per real change and not otherwise", () => {
    const before = getEqState().revision;
    eqActions.setEnabled(eqActions && getEqState().config.enabled);
    expect(getEqState().revision).toBe(before);
    eqActions.choosePreset("flat");
    expect(getEqState().revision).toBe(before + 1);
  });
});

describe("hydration", () => {
  beforeEach(() => {
    resetEqGraphForTests();
    eqActions.reset();
  });

  it("adopts an external configuration and copies its bands", () => {
    const incoming = on(setBandGain(selectPreset("aurora-v"), 8, 4));
    eqActions.hydrate(incoming);
    const { config } = getEqState();
    expect(config.bands[8]!.gain).toBe(4);
    expect(config.presetId).toBe("custom");
    // A copy, not a reference: mutating the store must not reach back into
    // whatever the server passed, and vice versa.
    expect(config.bands).not.toBe(incoming.bands);
  });
});

/* ==========================================================================
   ACTION -> STORE -> GRAPH -> AudioParam

   The chain the mode-switching defect broke. The model tests above prove the
   store holds the right numbers; the graph tests prove `engage()` writes the
   state it is given. This block proves the two are CONNECTED - that a preset
   button ends up as a different number on the same ten filters, with no
   rebuild, no second context and no re-homing of the element in between.

   `push()` is the only bridge and it is deliberately fire-and-forget, so every
   assertion waits a macrotask for the engagement to land.
   ========================================================================== */

/** Lets a microtask-queued graph engagement land. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the store reaches the audio graph (the mode-switch chain)", () => {
  let context: FakeContext;
  let contextsCreated: number;

  beforeEach(() => {
    resetEqGraphForTests();
    context = new FakeContext();
    contextsCreated = 0;
    // Prime the singleton with a graph that can actually engage. The store
    // only ever calls `getEqGraph()`, so this is the production path with the
    // Web Audio seam swapped for a recording fake.
    getEqGraph({
      createContext: () => {
        contextsCreated += 1;
        return context;
      },
      getElement: () => fakeAudioElement(),
    });
    eqActions.reset();
    // `reset()` restores the configuration; it deliberately does not know
    // whether a graph is currently running, because that is the graph's fact
    // and not the store's. Start from the store's own clean slate anyway, so a
    // previous test's `engaged` cannot leak into an assertion here.
    eqActions.setEngaged(false, null);
  });

  it("reaches the filter parameters when a preset is chosen", async () => {
    eqActions.choosePreset("flat");
    await settled();

    expect(getEqState().engaged).toBe(true);
    expect(context.filters).toHaveLength(10);
    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    // Flat's declared headroom is 0 dB, so the preamp is unity and not the
    // V-Shape's -3.5 surviving the switch.
    expect(context.gains[0]!.gain.value).toBeCloseTo(1, 6);
  });

  it("switches presets on the SAME nodes, without rebuilding anything", async () => {
    // The central claim of this block. Before the fix, `engage()` returned as
    // soon as the graph existed and dropped the state it was handed, so this
    // sequence changed the interface and left the audio on the V-Shape.
    eqActions.choosePreset("aurora-v");
    await settled();
    const filters = [...context.filters];
    const source = context.sourcedElement;
    expect(context.filters[0]!.gain.value).toBe(2.5);

    eqActions.choosePreset("flat");
    await settled();

    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    // Same ten node objects, one context, one re-homing, nothing closed.
    expect(context.filters).toHaveLength(10);
    for (let i = 0; i < 10; i += 1) {
      expect(context.filters[i]).toBe(filters[i]);
    }
    expect(contextsCreated).toBe(1);
    expect(context.sourceCalls).toBe(1);
    expect(context.sourcedElement).toBe(source);
    expect(context.closeCalls).toBe(0);
  });

  it("carries the V-Shape's declared -3.5 dB into the preamp", async () => {
    eqActions.choosePreset("aurora-v");
    await settled();
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-3.5 / 20), 6);

    eqActions.choosePreset("flat");
    await settled();
    expect(context.gains[0]!.gain.value).toBeCloseTo(1, 6);

    eqActions.choosePreset("aurora-v");
    await settled();
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-3.5 / 20), 6);
    // Still one context after three switches (§26).
    expect(contextsCreated).toBe(1);
  });

  it("bypasses through the same nodes and restores the curve on re-enable", async () => {
    eqActions.choosePreset("aurora-v");
    await settled();
    expect(context.filters[0]!.gain.value).toBe(2.5);

    eqActions.setEnabled(false);
    await settled();
    // Neutral, but written - not disconnected, not closed, not reset.
    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    expect(context.gains[0]!.gain.value).toBeCloseTo(1, 6);
    expect(context.closeCalls).toBe(0);
    expect(context.sourceCalls).toBe(1);

    eqActions.setEnabled(true);
    await settled();
    expect(context.filters[0]!.gain.value).toBe(2.5);
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-3.5 / 20), 6);
    expect(contextsCreated).toBe(1);
    expect(context.sourceCalls).toBe(1);
    expect(context.closeCalls).toBe(0);
  });

  it("restores the curve when an A/B comparison is released", async () => {
    eqActions.choosePreset("aurora-v");
    await settled();

    eqActions.setComparing(true);
    await settled();
    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    expect(context.gains[0]!.gain.value).toBeCloseTo(1, 6);

    eqActions.setComparing(false);
    await settled();
    expect(context.filters[0]!.gain.value).toBe(2.5);
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-3.5 / 20), 6);
    expect(contextsCreated).toBe(1);
    expect(context.closeCalls).toBe(0);
  });

  it("lands on the LAST of a rapid series of switches", async () => {
    // §18, latest-requested-state-wins. Three changes before the first
    // engagement has finished building; the audio and the interface must both
    // end on the third, never on the first.
    eqActions.choosePreset("flat");
    eqActions.choosePreset("aurora-v");
    eqActions.choosePreset("flat");
    await settled();

    expect(getEqState().config.presetId).toBe("flat");
    expect(getEqState().engaged).toBe(true);
    expect(context.filters.map((f) => f.gain.value)).toEqual(
      FLAT_BANDS.map((b) => b.gain),
    );
    expect(contextsCreated).toBe(1);
    expect(context.sourceCalls).toBe(1);
  });

  it("never reports the equalizer unavailable while it waits for a gesture", async () => {
    // A suspended context at page load is an ordinary lifecycle state, and the
    // page cannot be playing yet - so there is nothing for the interface to
    // warn about, and the graph retries by itself at the next gesture.
    context.resume = async () => {
      throw new Error("NotAllowedError");
    };

    eqActions.choosePreset("aurora-v");
    await settled();

    const state = getEqState();
    expect(state.engaged).toBe(false);
    expect(state.unsupportedReason).toBeNull();
    // And the element was never touched, so whatever is playing keeps playing.
    expect(context.sourceCalls).toBe(0);
    expect(context.sourcedElement).toBeNull();
  });

  it("keeps one context and one re-homing across a long editing session", async () => {
    eqActions.choosePreset("aurora-v");
    await settled();

    for (let index = 0; index < 10; index += 1) {
      eqActions.setBandGain(index, index % 2 === 0 ? 4 : -3);
      await settled();
    }
    eqActions.setPreampMode("manual");
    eqActions.setManualPreamp(-6);
    await settled();

    expect(contextsCreated).toBe(1);
    expect(context.sourceCalls).toBe(1);
    expect(context.closeCalls).toBe(0);
    expect(context.filters).toHaveLength(10);
    expect(context.filters[0]!.gain.value).toBe(4);
    expect(context.filters[1]!.gain.value).toBe(-3);
    expect(context.gains[0]!.gain.value).toBeCloseTo(10 ** (-6 / 20), 6);
  });
});
