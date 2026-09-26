import { describe, expect, it } from "vitest";
import {
  AURORA_V_SHAPE,
  AURORA_V_SHAPE_MAX_BOOST_DB,
  DEFAULT_EQ,
  DEFAULT_PREAMP_DB,
  EQ_BAND_FREQUENCIES,
  EQ_BAND_GAIN_MAX_DB,
  EQ_BAND_GAIN_MIN_DB,
  EQ_BAND_GAIN_STEP_DB,
  EQ_BAND_Q,
  EQ_PRESETS,
  FLAT_BANDS,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
  SAFETY_MARGIN_DB,
  autoPreampDb,
  clampPreampDb,
  compositeMaxGainDb,
  dbToLinear,
  decodeEQ,
  effectiveGraphState,
  encodeEQ,
  headroomSaturated,
  isEQPresetId,
  linearToDb,
  magnitudeDb,
  maxBandGainDb,
  peakingCoefficients,
  presetPreampDb,
  quantizeBandGain,
  requiredPreampDb,
  resetEQ,
  resolvePreampDb,
  selectPreset,
  setBandGain,
  cloneBands,
  type EQBand,
  type EQConfig,
} from "@/lib/audio/eq";

/** Aurora V-Shape as the addendum §5 specifies it, verbatim. */
const SPEC_TABLE: ReadonlyArray<readonly [number, number]> = [
  [31, 2.5],
  [62, 3.0],
  [125, 2.0],
  [250, 0.5],
  [500, -0.5],
  [1000, -1.0],
  [2000, -0.5],
  [4000, 0.5],
  [8000, 2.0],
  [16000, 1.5],
];

function withGain(index: number, gain: number): EQBand[] {
  const bands = cloneBands(FLAT_BANDS);
  bands[index] = { ...bands[index]!, gain };
  return bands;
}

describe("the shipped Aurora V-Shape curve", () => {
  it("is the ten specified bands at the specified gains", () => {
    // The table in addendum §5, asserted rather than restated, so an edit that
    // changes a number has to change this test in the same commit.
    expect(AURORA_V_SHAPE.map((b) => [b.frequency, b.gain])).toEqual(SPEC_TABLE);
  });

  it("peaks at exactly +3.0 dB, and the constant says so", () => {
    expect(AURORA_V_SHAPE_MAX_BOOST_DB).toBe(3.0);
    expect(maxBandGainDb(AURORA_V_SHAPE)).toBe(3.0);
    // ...and it is the 62 Hz band, which is what §6's arithmetic assumes.
    const peak = AURORA_V_SHAPE.find((b) => b.gain === 3.0);
    expect(peak?.frequency).toBe(62);
  });

  it("is a V: bass and treble lifted, the middle eased, and NOT scooped", () => {
    const gain = (hz: number) =>
      AURORA_V_SHAPE.find((b) => b.frequency === hz)?.gain ?? 0;
    // The two ends are up.
    expect(gain(62)).toBeGreaterThan(0);
    expect(gain(8000)).toBeGreaterThan(0);
    // The middle is down, but by a hair. A mid scoop is the classic V failure
    // and §15 forbids it; -1.0 dB is "relaxed", not "missing".
    expect(gain(1000)).toBe(-1.0);
    expect(Math.abs(gain(1000))).toBeLessThanOrEqual(1.0);
    // 250 Hz stays POSITIVE. §14: cut here and the sound goes thin and hollow.
    expect(gain(250)).toBeGreaterThan(0);
  });

  it("keeps the low-mid gentle and the high-treble restrained", () => {
    const gain = (hz: number) =>
      AURORA_V_SHAPE.find((b) => b.frequency === hz)?.gain ?? 0;
    // §14: no aggressive cut anywhere in 200-500 Hz.
    expect(gain(500)).toBeGreaterThanOrEqual(-0.5);
    // §16: 1-4 kHz protects vocals, so the smallest cut and a return to flat.
    expect(gain(2000)).toBeGreaterThanOrEqual(-0.5);
    expect(gain(4000)).toBeGreaterThanOrEqual(0);
    // §18: air is a lift, but the smallest of the three treble-side lifts.
    expect(gain(16000)).toBeGreaterThan(0);
    expect(gain(16000)).toBeLessThan(gain(8000));
    expect(gain(16000)).toBeLessThan(gain(62));
  });

  it("does not overboost the sub-bass: the deepest band is not the loudest", () => {
    // §13 targets deep/tight/controlled. If 31 Hz were also the peak, the
    // bottom octave would be where "deep" becomes "bloated" first.
    const sub = AURORA_V_SHAPE.find((b) => b.frequency === 31);
    const peak = AURORA_V_SHAPE.find((b) => b.frequency === 62);
    expect(sub!.gain).toBeLessThan(peak!.gain);
  });

  it("uses one Q for every band, and ten canonical centres", () => {
    // A uniform Q is what "a 10-band EQ" means to a listener; a non-uniform one
    // would change the curve's shape invisibly.
    for (const band of AURORA_V_SHAPE) {
      expect(band.q).toBe(EQ_BAND_Q);
    }
    expect(AURORA_V_SHAPE).toHaveLength(10);
    expect(AURORA_V_SHAPE.map((b) => b.frequency)).toEqual([
      ...EQ_BAND_FREQUENCIES,
    ]);
  });
});

describe("the headroom decisions (addendum §6 and §52)", () => {
  it("documents the three numbers that must not be 'fixed'", () => {
    // If any of these three change, this test fails. That is the entire point of
    // §52: -3.5 dB is +3.0 boost, compensated, plus 0.5 dB of safety - not an
    // arithmetic slip to be tidied into -3.
    expect(AURORA_V_SHAPE_MAX_BOOST_DB).toBe(3.0);
    expect(DEFAULT_PREAMP_DB).toBe(-3.5);
    expect(SAFETY_MARGIN_DB).toBe(0.5);
  });

  it("derives the default preamp from the boost plus the margin", () => {
    expect(DEFAULT_PREAMP_DB).toBe(
      -(AURORA_V_SHAPE_MAX_BOOST_DB + SAFETY_MARGIN_DB),
    );
  });

  it("keeps the preamp range at -12..0 and never allows a positive preamp", () => {
    // §10. The ceiling is a hard rule, not a preference.
    expect(PREAMP_MIN_DB).toBe(-12);
    expect(PREAMP_MAX_DB).toBe(0);
    for (const value of [99, 1e9, Number.MAX_SAFE_INTEGER]) {
      expect(clampPreampDb(value)).toBe(0);
    }
    expect(clampPreampDb(-99)).toBe(-12);
    // And a non-number is absence, not a crash.
    for (const value of [null, undefined, "loud", NaN, Infinity, {}]) {
      expect(clampPreampDb(value)).toBe(0);
    }
  });
});

describe("the composite transfer function (addendum §8)", () => {
  it("exceeds the largest individual band, which is why the naive bound is wrong", () => {
    // THE CENTRAL TECHNICAL CLAIM OF THE WHOLE HEADROOM DESIGN, asserted.
    //
    // Addendum §8 says the maximum individual band gain does NOT bound the
    // output, because cascaded filters multiply. Measured on the shipped curve
    // the excess is 0.83 dB, and it comes from the 31/62/125 Hz group whose
    // skirts overlap around 62 Hz.
    const naive = maxBandGainDb(AURORA_V_SHAPE);
    const composite = compositeMaxGainDb(AURORA_V_SHAPE, 48_000);
    expect(naive).toBe(3.0);
    expect(composite).toBeGreaterThan(naive);
    expect(composite).toBeCloseTo(3.83, 2);
  });

  it("locates the peak at the 62 Hz band, where the boosts stack", () => {
    // Sampled the same way `compositeMaxGainDb` samples, so this is the peak
    // the headroom arithmetic actually sees.
    const sets = AURORA_V_SHAPE.map((b) => peakingCoefficients(b, 48_000));
    let best = { hz: 0, db: -Infinity };
    for (let i = 0; i <= 4000; i += 1) {
      const hz = 20 * 1000 ** (i / 4000);
      let sum = 0;
      for (const c of sets) {
        sum += magnitudeDb(c, hz, 48_000);
      }
      if (sum > best.db) {
        best = { hz, db: sum };
      }
    }
    expect(best.db).toBeCloseTo(3.83, 2);
    // Within a band width of 62 Hz, not up at 16 kHz where the air lift is.
    expect(best.hz).toBeGreaterThan(40);
    expect(best.hz).toBeLessThan(100);
  });

  it("is stable across the sample rates a browser actually uses", () => {
    // Why `NOMINAL_SAMPLE_RATE` is safe to show a figure computed against.
    const values = [44_100, 48_000, 96_000].map((fs) =>
      compositeMaxGainDb(AURORA_V_SHAPE, fs),
    );
    for (const value of values) {
      expect(value).toBeCloseTo(values[0]!, 1);
    }
  });

  it("is zero for a flat curve, to the last bit", () => {
    expect(compositeMaxGainDb(FLAT_BANDS, 48_000)).toBe(0);
  });

  it("shows a far larger excess when a user stacks two adjacent boosts", () => {
    // The case the shipped curve only hints at, and the reason the automatic
    // path cannot be `max(band.gain)`: two neighbouring +6 dB bands peak 7.19 dB
    // up, so a naive bound would under-compensate by 1.19 dB.
    const stacked = [
      ...withGain(0, 6).slice(0, 1),
      ...withGain(1, 6).slice(1),
    ];
    expect(maxBandGainDb(stacked)).toBe(6);
    expect(compositeMaxGainDb(stacked, 48_000)).toBeCloseTo(7.19, 2);
  });

  it("agrees with the browser's own filter definition at each band centre", () => {
    // A peaking biquad's magnitude AT its centre frequency is exactly its gain
    // in dB. If the coefficients used for the arithmetic were not the same ones
    // handed to `BiquadFilterNode`, this would fail - which is the check that
    // the number sizing the headroom describes the filter that is playing.
    for (const band of AURORA_V_SHAPE) {
      const coefficients = peakingCoefficients(band, 48_000);
      expect(magnitudeDb(coefficients, band.frequency, 48_000)).toBeCloseTo(
        band.gain,
        6,
      );
    }
  });
});

describe("automatic headroom (addendum §7, §8)", () => {
  it("gives the shipped curve a true 0.5 dB margin, not the naive figure", () => {
    // autoPreampDb on Aurora V-Shape is -4.33, NOT -3.5. That is the composite
    // ceiling (3.83) plus the 0.5 margin, and it is what makes the peak land at
    // -0.5 dB instead of +0.33.
    const composite = compositeMaxGainDb(AURORA_V_SHAPE, 48_000);
    const preamp = autoPreampDb(AURORA_V_SHAPE, 48_000);
    expect(preamp).toBeCloseTo(-(composite + SAFETY_MARGIN_DB), 6);
    expect(composite + preamp).toBeCloseTo(-SAFETY_MARGIN_DB, 6);
  });

  it("scales with the boost, so a +6 dB curve does not keep -3.5 dB", () => {
    // §7's explicit example, refused: a +6 dB band must not ride on the
    // shipped preset's -3.5 dB.
    const six = withGain(1, 6);
    const preamp = autoPreampDb(six, 48_000);
    expect(preamp).toBeLessThan(DEFAULT_PREAMP_DB);
    expect(preamp).toBeCloseTo(-6.5, 1);
    expect(compositeMaxGainDb(six, 48_000) + preamp).toBeLessThanOrEqual(0);
  });

  it("gives a curve that only cuts exactly 0 dB", () => {
    // Nothing was made louder, so there is nothing to make room for. A cut-only
    // curve with -0.5 dB of preamp would be a quiet bug nobody would report.
    const cut = withGain(5, -6);
    expect(autoPreampDb(cut, 48_000)).toBe(0);
  });

  it("gives a FLAT curve exactly 0 dB, never a stale -0.5 or -3.5", () => {
    // §11 and §48. This is the bug the margin rule would otherwise create:
    // subtracting 0.5 dB for a curve with no boost in it.
    expect(autoPreampDb(FLAT_BANDS, 48_000)).toBe(0);
    expect(requiredPreampDb(FLAT_BANDS, 48_000)).toBe(0);
    expect(headroomSaturated(FLAT_BANDS, 48_000)).toBe(false);
  });

  it("never returns a positive preamp, for any curve at all", () => {
    // §10's hard rule, checked exhaustively rather than on samples.
    for (const gain of [-12, -6, -0.5, 0, 0.5, 3, 6, 12]) {
      for (let index = 0; index < 10; index += 1) {
        const preamp = autoPreampDb(withGain(index, gain), 48_000);
        expect(preamp, `band ${index} at ${gain}`).toBeLessThanOrEqual(0);
      }
    }
  });

  it("reports saturation rather than pretending, when the range is too small", () => {
    // Every band at +12 dB needs about -18.9 dB, which the -12 dB floor cannot
    // express. The interface is told, instead of being handed a clamped number
    // that overstates the protection.
    const allMax = cloneBands(FLAT_BANDS).map((b) => ({ ...b, gain: 12 }));
    expect(requiredPreampDb(allMax, 48_000)).toBeLessThan(PREAMP_MIN_DB);
    expect(autoPreampDb(allMax, 48_000)).toBe(PREAMP_MIN_DB);
    expect(headroomSaturated(allMax, 48_000)).toBe(true);
  });

  it("is NOT saturated for any single band, except at the very top of its range", () => {
    // A MEASURED BORDERLINE, recorded rather than rounded away: a lone band at
    // the maximum needs -(12 + 0.5) = -12.5 dB, which is 0.5 dB past the -12 dB
    // floor. Every other single-band value is expressible, and so is every
    // pair. The floor is not widened to chase this: -12 dB is already a quarter
    // of the signal's amplitude, and the interface reports saturation instead
    // of quietly protecting the signal less than it says it is.
    for (const gain of [-12, -6, 0, 3, 6, 9, 11, 11.5]) {
      for (let index = 0; index < 10; index += 1) {
        expect(
          headroomSaturated(withGain(index, gain), 48_000),
          `band ${index} at ${gain}`,
        ).toBe(false);
      }
    }
    // At the top of the range the requirement exceeds the floor by the margin.
    for (let index = 0; index < 10; index += 1) {
      const band = withGain(index, 12);
      expect(requiredPreampDb(band, 48_000), `band ${index}`).toBeCloseTo(-12.5, 9);
      expect(headroomSaturated(band, 48_000), `band ${index}`).toBe(true);
    }
  });

  it("treats a curve that needs EXACTLY the floor as fitting", () => {
    // The boundary, and it is a boundary that has to be decided rather than
    // inherited from floating point. A lone +11.5 dB band needs exactly
    // -12.0 dB, and evaluating a biquad's magnitude response returns
    // 11.500000000000037, so a bare comparison against the floor reports
    // "cannot be honoured" for a curve that fits to within 4e-14 dB.
    const exact = withGain(0, 11.5);
    expect(requiredPreampDb(exact, 48_000)).toBeCloseTo(-12, 9);
    expect(headroomSaturated(exact, 48_000)).toBe(false);
    // One 0.5 dB step higher and it genuinely does not fit.
    expect(headroomSaturated(withGain(0, 12), 48_000)).toBe(true);
  });
});

describe("presets and headroom together (addendum §9, §11)", () => {
  it("declares -3.5 for Aurora V-Shape and 0 for Flat", () => {
    expect(presetPreampDb("aurora-v")).toBe(-3.5);
    expect(presetPreampDb("flat")).toBe(0);
  });

  it("replaces bands AND preamp when switching presets", () => {
    // §9. Aurora V-Shape -> Flat must not leave -3.5 dB attached.
    const vShape = selectPreset("aurora-v");
    expect(resolvePreampDb(vShape)).toBe(-3.5);

    const flat = selectPreset("flat");
    expect(flat.presetId).toBe("flat");
    expect(flat.bands.every((b) => b.gain === 0)).toBe(true);
    expect(resolvePreampDb(flat)).toBe(0);
    expect(flat.preampMode).toBe("manual");
  });

  it("walks the full switching cycle and lands correctly every time (§49)", () => {
    // V-Shape -> Flat -> V-Shape -> Custom -> V-Shape, checking the complete
    // state at each stop: bands, preamp, mode and enabled.
    const stops: Array<{ preset: "aurora-v" | "flat" | "custom"; gain: number; preamp: number }> = [
      { preset: "aurora-v", gain: 3.0, preamp: -3.5 },
      { preset: "flat", gain: 0, preamp: 0 },
      { preset: "aurora-v", gain: 3.0, preamp: -3.5 },
      { preset: "custom", gain: 3.0, preamp: 0 }, // custom enters auto; bands kept
      { preset: "aurora-v", gain: 3.0, preamp: -3.5 },
    ];
    let config = DEFAULT_EQ;
    for (const stop of stops) {
      config = selectPreset(stop.preset);
      expect(maxBandGainDb(config.bands), stop.preset).toBeCloseTo(stop.gain, 6);
      // "custom" enters automatic headroom, which recomputes from the bands it
      // kept rather than adopting a preset's number.
      expect(config.preampMode, stop.preset).toBe(
        stop.preset === "custom" ? "auto" : "manual",
      );
      if (stop.preset !== "custom") {
        expect(resolvePreampDb(config), stop.preset).toBe(stop.preamp);
      }
      expect(config.enabled, stop.preset).toBe(true);
    }
  });

  it("moves a band out of the preset, and drops the preset's headroom with it", () => {
    // §9's exact failure. The preset declared a fixed -3.5 dB; the band the
    // listener just moved makes that figure wrong, and keeping it would leave
    // the chain peaking decibels over unity on a boost made a moment ago.
    const config = setBandGain(selectPreset("aurora-v"), 1, 6);
    expect(config.presetId).toBe("custom");
    expect(config.preampMode).toBe("auto");
    expect(config.bands[1]!.gain).toBe(6);
    expect(maxBandGainDb(config.bands)).toBe(6);
    expect(resolvePreampDb(config)).toBeLessThan(DEFAULT_PREAMP_DB);
  });

  it("respects a deliberate manual figure once the curve is already custom", () => {
    // The other half of the rule. Overriding a mode the listener chose, every
    // time they adjusted a neighbouring band, would be the system overruling a
    // decision rather than inheriting a stale one.
    const custom = setBandGain(selectPreset("aurora-v"), 1, 6);
    const manual: EQConfig = {
      ...custom,
      preampMode: "manual",
      manualPreampDb: -8,
    };
    const moved = setBandGain(manual, 2, 4);
    expect(moved.preampMode).toBe("manual");
    expect(moved.manualPreampDb).toBe(-8);
  });

  it("ignores an out-of-range band index rather than writing past the end", () => {
    const config = selectPreset("flat");
    expect(setBandGain(config, -1, 6)).toBe(config);
    expect(setBandGain(config, 10, 6)).toBe(config);
    expect(setBandGain(config, 99, 6)).toBe(config);
  });

  it("has a Flat preset that is genuinely flat", () => {
    expect(EQ_PRESETS.flat.bands).toHaveLength(10);
    expect(EQ_PRESETS.flat.bands.every((b) => b.gain === 0)).toBe(true);
    expect(EQ_PRESETS.flat.preamp).toBe(0);
  });

  it("resets to the shipped default, disabled", () => {
    const reset = resetEQ();
    expect(reset.enabled).toBe(false);
    expect(reset.presetId).toBe("aurora-v");
    expect(reset.bands).toEqual([...AURORA_V_SHAPE]);
    expect(reset.manualPreampDb).toBe(-3.5);
  });

  it("validates preset ids against a closed set", () => {
    for (const value of ["aurora-v", "flat", "custom"]) {
      expect(isEQPresetId(value)).toBe(true);
    }
    for (const value of [
      "", "constructor", "toString", "__proto__", "Aurora-V", " aurora-v",
      "aurora-v ", "AURORA-V", null, undefined, 0, 3, true, {}, ["aurora-v"],
    ]) {
      expect(isEQPresetId(value), String(value)).toBe(false);
    }
  });
});

describe("bypass is a neutral path, never a disconnect (addendum §12)", () => {
  it("produces unity when the EQ is off, whatever the stored config says", () => {
    const config = { ...selectPreset("aurora-v"), enabled: false };
    const state = effectiveGraphState(config);
    expect(state.preampDb).toBe(0);
    expect(state.bands.every((b) => b.gain === 0)).toBe(true);
    // The filters are still there, because they have to be: the element's audio
    // only reaches the speakers by travelling through them.
    expect(state.bands).toHaveLength(10);
  });

  it("passes a boosted curve through untouched when the EQ is on", () => {
    const state = effectiveGraphState({ ...selectPreset("aurora-v"), enabled: true });
    expect(state.preampDb).toBe(-3.5);
    expect(maxBandGainDb(state.bands)).toBe(3.0);
  });
});

describe("band gain quantisation", () => {
  it("snaps to the slider grid and clamps into range", () => {
    expect(quantizeBandGain(0.3)).toBe(0.5);
    expect(quantizeBandGain(0.2)).toBe(0);
    expect(quantizeBandGain(-0.3)).toBe(-0.5);
    expect(quantizeBandGain(99)).toBe(EQ_BAND_GAIN_MAX_DB);
    expect(quantizeBandGain(-99)).toBe(EQ_BAND_GAIN_MIN_DB);
    // Every produced value is on the grid, so a handle can come to rest
    // somewhere the user can return to.
    for (let v = EQ_BAND_GAIN_MIN_DB; v <= EQ_BAND_GAIN_MAX_DB; v += 0.13) {
      const q = quantizeBandGain(v);
      expect(((q / EQ_BAND_GAIN_STEP_DB) % 1)).toBeCloseTo(0, 6);
    }
  });

  it("treats a non-number as 0 dB rather than coercing garbage", () => {
    for (const value of [null, undefined, "", false, NaN, Infinity, {}, []]) {
      expect(quantizeBandGain(value), String(value)).toBe(0);
    }
  });
});

describe("decibel conversion", () => {
  it("round-trips", () => {
    for (const db of [-12, -3.5, -0.5, 0, 0.5, 3, 6, 12]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 9);
    }
  });

  it("maps 0 dB to exactly 1", () => {
    expect(dbToLinear(0)).toBe(1);
  });

  it("reports silence rather than throwing", () => {
    expect(linearToDb(0)).toBe(-Infinity);
    expect(linearToDb(-1)).toBe(-Infinity);
  });
});

describe("the wire format (addendum §39)", () => {
  it("is worth one field for a visitor who has touched nothing", () => {
    // The cookie travels with every same-origin request, so the default has to
    // be tiny. This is the same argument `AppearanceWire` makes.
    expect(encodeEQ(DEFAULT_EQ)).toEqual({ v: 1 });
  });

  it("round-trips every field it can write", () => {
    const config = {
      enabled: true,
      presetId: "custom" as const,
      bands: withGain(3, 4.5),
      preampMode: "auto" as const,
      manualPreampDb: -6,
    };
    expect(decodeEQ(encodeEQ(config))).toEqual(config);
  });

  it("omits bands that equal the default", () => {
    const encoded = encodeEQ(selectPreset("aurora-v"));
    expect(encoded.bands).toBeUndefined();
    const flat = encodeEQ(selectPreset("flat"));
    expect(flat.presetId).toBe("flat");
  });

  it("is total and per-field, because a cookie is attacker-controllable", () => {
    for (const value of [undefined, null, 7, "{}", [], true]) {
      expect(() => decodeEQ(value)).not.toThrow();
      expect(decodeEQ(value).presetId).toBe(DEFAULT_EQ.presetId);
    }
    // A future version is the only hard gate.
    expect(decodeEQ({ v: 999, enabled: true }).enabled).toBe(false);
    // One bad field costs that field and nothing else. 500 Hz has an unusable
    // gain and is repaired per field; 4 kHz - a real centre - is applied.
    const decoded = decodeEQ({
      v: 1,
      enabled: true,
      presetId: "custom",
      manualPreampDb: "loud",
      bands: [{ f: 500, g: "loud" }, { f: 4000, g: 3 }],
    });
    expect(decoded.enabled).toBe(true);
    expect(decoded.presetId).toBe("custom");
    expect(decoded.manualPreampDb).toBe(0);
    expect(decoded.bands[7]!.gain).toBe(3);
    // 500 Hz kept the curve's own -0.5 dB, because the entry named a
    // frequency but not a usable value.
    expect(decoded.bands[4]!.gain).toBe(-0.5);
  });

  it("clamps a hand-written preamp instead of amplifying a boosted signal", () => {
    // §10. A cookie asking for +6 dB of preamp must not get it.
    expect(decodeEQ({ v: 1, preampMode: "manual", manualPreampDb: 6 }).manualPreampDb).toBe(0);
  });

  it("drops a stored band at an unknown frequency rather than adding a filter", () => {
    // The graph has a fixed set of ten filters. A cookie must not be able to
    // decide how many nodes exist.
    const decoded = decodeEQ({
      v: 1,
      presetId: "custom",
      bands: [
        { f: 440, g: 6 },
        { f: 1000, g: 2 },
      ],
    });
    expect(decoded.bands).toHaveLength(10);
    expect(decoded.bands[5]!.gain).toBe(2);
    // Every surviving band sits on a canonical centre - the set the graph's ten
    // filters are built from, not whatever the document happened to name.
    const canonical: readonly number[] = EQ_BAND_FREQUENCIES;
    expect(
      decoded.bands.every((b) => canonical.includes(b.frequency)),
    ).toBe(true);
  });

  it("lets a preset beat contradictory stored bands", () => {
    // `flat` with stray gains is a contradiction, and the preset wins.
    const decoded = decodeEQ({ v: 1, presetId: "flat", bands: [{ f: 62, g: 6 }] });
    expect(decoded.bands.every((b) => b.gain === 0)).toBe(true);
  });

  it("never returns a shared mutable default", () => {
    const a = decodeEQ({ v: 1 });
    const b = decodeEQ({ v: 1 });
    a.bands[0]!.gain = 9;
    expect(b.bands[0]!.gain).toBe(2.5);
  });
});
