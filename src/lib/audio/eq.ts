/**
 * The Aurora V-Shape equalizer model (Phase 53 addendum).
 *
 * ONE AUTHORITY, and it is deliberately a pure module: no DOM, no Web Audio,
 * no React, no storage. Everything else in the EQ feature - the audio graph,
 * the store, the settings panel, the server action - reads the curve, the
 * ranges, the headroom arithmetic and the wire format from here, so there is
 * exactly one place where "what Aurora's EQ does" is written down.
 *
 * WHAT THIS IS NOT (addendum §3). Aurora's EQ runs on the playback signal
 * before it reaches the listener's hardware. It is therefore a *global musical
 * coloration*, not a headphone-correction profile: it is not computed from any
 * measurement of any device, it makes no claim about what a particular pair of
 * headphones "should" sound like, and applying it on top of an already-corrected
 * signal is a legitimate choice rather than an error. Aurora has no measurement
 * rig, no per-device profiles and no target curve database, and adding one would
 * be a different product.
 *
 * WHY THE HEADROOM ARITHMETIC IS NOT `max(band.gain)` (addendum §8).
 *
 * A peaking biquad in dB has a magnitude response; ten of them in series
 * MULTIPLY, which means their dB responses ADD. Where two boosted bands are
 * close enough for their skirts to overlap, the composite response at the
 * crossover is larger than either band's own maximum, so
 * `-(max(band.gain))` is not merely imprecise - for a V-shaped curve, where the
 * boost is at BOTH ends, it is wrong in the optimistic direction. The mission
 * names this explicitly: do not claim that the maximum individual band gain
 * bounds the output.
 *
 * So the ceiling here is the real thing: `compositeMaxGainDb` evaluates the
 * actual chained transfer function and returns its maximum, using the SAME
 * coefficients the audio graph hands to `BiquadFilterNode`. One definition of
 * the filter, used by both the ear and the arithmetic, so the number that sizes
 * the headroom is the number the filters actually implement.
 *
 * WHAT THAT STILL IS NOT (addendum §47). A numeric peak over sampled
 * frequencies bounds the EQ chain's own contribution. It is not a proof of zero
 * clipping in playback: lossy decoders can overshoot, inter-sample peaks can
 * exceed the sampled peak, and a downstream limiter or the browser's own
 * resampler can add gain. The margin below exists for exactly that, and this
 * file says so rather than implying a guarantee it cannot make.
 */

/* ==========================================================================
   UNITS
   ========================================================================== */

/**
 * The sample rate used for arithmetic that happens before (or without) an
 * AudioContext.
 *
 * 48 kHz is the nominal rate and the right default: the filter shapes are
 * nearly rate-invariant across the rates a browser actually uses (44.1, 48,
 * 96), the difference at these Q values is well under a tenth of a dB, and a
 * headroom figure that moved with the hardware would be a number the interface
 * could not show honestly. When a context exists, `compositeMaxGainDb` is
 * called with its REAL `sampleRate` instead, so the live graph and the live
 * headroom agree.
 */
export const NOMINAL_SAMPLE_RATE = 48_000;

/** Amplitude ratio -> decibels. */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Decibels -> amplitude ratio. `-Infinity` for silence, `+Infinity` for zero. */
export function linearToDb(linear: number): number {
  if (linear <= 0) {
    return -Infinity;
  }
  return 20 * Math.log10(linear);
}

/* ==========================================================================
   THE HEADROOM DECISIONS - READ THIS BEFORE "FIXING" ANY NUMBER
   ========================================================================== */

export const AURORA_V_SHAPE_MAX_BOOST_DB = 3.0;

/**
 * The shipped V-Shape's preamp: -3.5 dB.
 *
 * THIS IS NOT AN INCONSISTENCY AND MUST NOT BE "CORRECTED" TO -3 dB.
 *
 *   maximum positive EQ boost ........ +3.0 dB   (62 Hz band)
 *   theoretical compensation ......... -3.0 dB
 *   additional safety margin ......... -0.5 dB   (SAFETY_MARGIN_DB)
 *   ----------------------------------------------------------------
 *   default preamp ................... -3.5 dB
 *
 * The 0.5 dB is not a rounding artifact. It is the margin that covers what a
 * transfer-function analysis provably cannot: inter-sample peaks, decoder
 * overshoot, and the browser's own output resampling. A headroom figure that
 * exactly cancels the measured boost leaves nothing for those, and the failure
 * mode is distortion on the loudest, most heavily boosted material - which is
 * exactly the material the curve is boosting.
 *
 * Note that the mission's +3.0 dB / -3.0 dB pair is itself an approximation:
 * `compositeMaxGainDb` on the shipped curve returns a value slightly ABOVE
 * 3.0 dB, because the 31/62/125 Hz boosts overlap (see `AURORA_V_SHAPE` and the
 * tests). The -3.5 dB preset value is the specified, deliberate figure; the
 * composite-aware path is what protects CUSTOM curves, where the user can
 * create overlaps the shipped one does not have.
 */
export const DEFAULT_PREAMP_DB = -3.5;

/** The margin described above. Applied to the computed ceiling, not to a band. */
export const SAFETY_MARGIN_DB = 0.5;

/**
 * Preamp bounds, in dB.
 *
 * The floor is -12 dB: it is the point past which the automatic logic would be
 * attenuating music so far that the EQ is no longer doing anything anyone
 * wanted, and it is also roughly where a 10-band curve set to maximum boost on
 * every band (+12 dB) lands, so the automatic path can always express its own
 * answer without clamping.
 *
 * The ceiling is 0 dB and it is a HARD rule, not a preference: automatic
 * headroom must never produce POSITIVE preamp. Boosting a signal and then
 * amplifying it further is the one thing headroom management exists to prevent,
 * and a positive preamp is the textbook way to clip.
 */
export const PREAMP_MIN_DB = -12;
export const PREAMP_MAX_DB = 0;

/**
 * Tolerance for the saturation test, in dB. See `headroomSaturated`.
 */
export const HEADROOM_EPSILON_DB = 1e-9;

/* ==========================================================================
   THE CURVE
   ========================================================================== */

export interface EQBand {
  frequency: number;
  gain: number;
  q: number;
}

export type EQPresetId = "aurora-v" | "flat" | "custom";

/**
 * Q for every band.
 *
 * 1.41 is the textbook constant-Q graphic-EQ value for octave-spaced bands
 * (~1 octave bandwidth at -3 dB points). It is used uniformly because ten
 * bands with a uniform Q is what "a 10-band EQ" means to a listener, and a
 * non-uniform Q would be an invisible design decision that changes the curve
 * shape without being visible anywhere in the interface.
 *
 * The alternative - narrower bands, Q above ~2 - would reduce how much adjacent
 * boosts overlap, and therefore reduce the composite peak. It was rejected
 * because at 31 Hz a Q of 2 is roughly a 15 Hz-wide bump: on most hardware that
 * band is at or below the reproduction limit anyway, so the effect would be
 * unevenly audible rather than "deep and smooth", and the headroom arithmetic
 * would be optimising for a shape nobody hears.
 */
export const EQ_BAND_Q = 1.41;

/**
 * The ten band centres, ascending. Octave-spaced, 31 Hz to 16 kHz, which spans
 * the audible range with the bottom octave deliberately starting at 31 rather
 * than 20: a 20 Hz band centre is below the reproduction limit of essentially
 * all consumer hardware, so a control there is a control that does nothing.
 * 16 kHz is the top rather than 20 kHz for the same reason in the other
 * direction - the 20 kHz band would be a sparkle control that is either
 * inaudible or, on bright hardware, a hiss control.
 */
export const EQ_BAND_FREQUENCIES = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

/** Per-band user range, in dB. Symmetric, and deliberately not wider. */
export const EQ_BAND_GAIN_MIN_DB = -12;
export const EQ_BAND_GAIN_MAX_DB = 12;
/** The slider's step. 0.5 dB is below the just-noticeable difference for a band. */
export const EQ_BAND_GAIN_STEP_DB = 0.5;

/**
 * AURORA V-SHAPE - the shipped curve.
 *
 * Reference-informed, application-specific musical tuning. The references are
 * the published consumer-headphone preference work (HARMAN / Sean Olive /
 * Todd Welti / Elisabeth McMullin) plus RTINGS and SoundGuys as independent
 * second opinions. What was taken from them is the SHAPE OF THE ARGUMENT, not
 * a curve: that bass and treble are the two regions listeners reward most, that
 * both are overdone easily (bass into boom, treble into harshness), that the
 * 200-500 Hz region is where mud and boxiness live and where a small cut buys
 * the most cleanliness per decibel, and that the midrange should be left alone
 * because it is where intelligibility lives.
 *
 * What was NOT taken: any measured target curve, and any product-specific
 * voicing. This is a musical coloration for one application (addendum §3), it
 * is not a reproduction target, and it is not - and is not described as - any
 * manufacturer's tuning. It is also not Harman-shaped: the published preference
 * targets are closer to tilted or mildly bass-emphasised than to a V, and
 * treating "Harman" as shorthand for "V-shape" is a misreading of that research.
 *
 * The values are engineering starting points, and the character each one is
 * buying is written next to it so a later change can be judged against the
 * intent rather than against the number.
 */
export const AURORA_V_SHAPE: readonly EQBand[] = Object.freeze([
  // --- Bass: emphasized, and bounded on purpose (addendum §13) -----------
  // 31 Hz is +2.5 and not +3: the deepest boost is deliberately NOT also the
  // loudest one. The bottom octave is where a consumer system is most likely to
  // have no headroom of its own, and where "deep" becomes "bloated" fastest.
  { frequency: 31, gain: 2.5, q: EQ_BAND_Q },
  // 62 Hz is the curve's peak and the whole point of the shape: weight you can
  // feel on a kick and a bass line.
  { frequency: 62, gain: 3.0, q: EQ_BAND_Q },
  // 125 Hz is "body", and it is the band most responsible for a V reading as
  // muddy. Held to +2.0 so the punch does not turn into box.
  { frequency: 125, gain: 2.0, q: EQ_BAND_Q },
  // --- Low-mid: controlled, not carved (addendum §14) ---------------------
  // +0.5, and positive on purpose. This is the region where an over-cut
  // produces a thin, hollow, "small" sound, which is the usual failure of a V.
  { frequency: 250, gain: 0.5, q: EQ_BAND_Q },
  // -0.5 is the whole low-mid move. Half a decibel is enough to take the edge
  // off boxiness; more than that starts eating the warmth that the bass boost
  // is leaning on.
  { frequency: 500, gain: -0.5, q: EQ_BAND_Q },
  // --- Midrange: relaxed, never scooped (addendum §15, §16) ---------------
  // -1.0 dB. A deliberate, shallow dip: enough to stop the bass from crowding
  // the middle, not a mid scoop. A deep scoop is the second classic V failure
  // and it is the one that costs vocals their place in the mix.
  { frequency: 1000, gain: -1.0, q: EQ_BAND_Q },
  // -0.5 dB, and the shallowest cut in the curve. 2 kHz is the lower presence
  // region where sibilance and nasal hardness live, so a token cut is cheap
  // insurance; anything more reads as a hole.
  { frequency: 2000, gain: -0.5, q: EQ_BAND_Q },
  // --- Presence and treble: clarity, bounded (addendum §17) ---------------
  // +0.5 dB only. This is the pivot of the whole curve: 2-4 kHz is where
  // articulation is made and where a V most easily shreds vocals, so the curve
  // returns to flat here rather than climbing.
  { frequency: 4000, gain: 0.5, q: EQ_BAND_Q },
  // +2.0 dB: the "detail" and "crisp" of the intended character.
  { frequency: 8000, gain: 2.0, q: EQ_BAND_Q },
  // --- Air: restrained on purpose (addendum §18) -------------------------
  // +1.5 dB, and the smallest of the three positive treble-side lifts. 16 kHz
  // is the band most likely to be unpleasant rather than pleasant: it is where
  // hiss and cymbal hash live, listener sensitivity to it varies enormously,
  // and no amount of it compensates for a track that is already bright. Restrained
  // is the only defensible setting here.
  { frequency: 16000, gain: 1.5, q: EQ_BAND_Q },
]) as readonly EQBand[];

export interface EQPreset {
  id: EQPresetId;
  bands: readonly EQBand[];
  /**
   * `number` for a shipped preset, whose headroom is a deliberate design
   * decision; `"auto"` for a user curve, whose headroom is whatever the actual
   * filter chain requires.
   */
  preamp: number | "auto";
}

/** All ten bands flat, built from the band list so it cannot fall out of step. */
export const FLAT_BANDS: readonly EQBand[] = Object.freeze(
  EQ_BAND_FREQUENCIES.map((frequency) => ({
    frequency,
    gain: 0,
    q: EQ_BAND_Q,
  })),
);

export const EQ_PRESETS: Record<Exclude<EQPresetId, "custom">, EQPreset> = {
  "aurora-v": { id: "aurora-v", bands: AURORA_V_SHAPE, preamp: DEFAULT_PREAMP_DB },
  /**
   * Flat is 0 dB on every band, and its preamp is the neutral path: not
   * `DEFAULT_PREAMP_DB`, and not "whatever the previous preset left behind".
   * Addendum §11 and §48 are both about exactly this failure, and it is the
   * kind of bug nobody notices until they wonder why flat sounds quieter.
   */
  flat: { id: "flat", bands: FLAT_BANDS, preamp: 0 },
};

export function isEQPresetId(value: unknown): value is EQPresetId {
  return (
    value === "aurora-v" || value === "flat" || value === "custom"
  );
}

/** A fresh, mutable copy - callers own what they are handed. */
export function cloneBands(bands: readonly EQBand[]): EQBand[] {
  return bands.map((band) => ({ ...band }));
}

export const DEFAULT_EQ: EQConfig = {
  enabled: false,
  presetId: "aurora-v",
  bands: cloneBands(AURORA_V_SHAPE),
  preampMode: "auto",
  manualPreampDb: DEFAULT_PREAMP_DB,
};

export interface EQConfig {
  enabled: boolean;
  presetId: EQPresetId;
  bands: EQBand[];
  preampMode: "auto" | "manual";
  manualPreampDb: number;
}

/* ==========================================================================
   FILTER COEFFICIENTS - the one definition of the filter
   ========================================================================== */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * RBJ peaking-EQ coefficients.
 *
 * The same numbers are handed to the `BiquadFilterNode`s the browser runs AND
 * used to evaluate the transfer function for headroom, which is the point: if
 * the graph and the arithmetic had separate definitions of "a +3 dB peaking
 * band at 62 Hz", the headroom figure would be describing a filter that is not
 * the one playing.
 *
 * `gain` is in dB, `frequency` in Hz, `q` dimensionless, `sampleRate` in Hz.
 */
export function peakingCoefficients(
  band: EQBand,
  sampleRate: number,
): BiquadCoefficients {
  const A = dbToLinear(band.gain / 2);
  const w0 = (2 * Math.PI * band.frequency) / sampleRate;
  const cosW0 = Math.cos(w0);
  // Clamped because a band centre at or above Nyquist makes `sin` degenerate,
  // and a zero denominator here would put NaN into an audio param - which the
  // Web Audio API treats as an exception, not as silence.
  const sinW0 = Math.max(Math.sin(w0), 1e-6);
  const alpha = sinW0 / (2 * Math.max(band.q, 0.1));

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * The exact magnitude response of one biquad at `frequency`, in dB.
 *
 * Evaluated from the difference equation rather than an approximation, because
 * at the extremes of the band the textbook closed form is at its least
 * accurate and those are exactly the frequencies the 31 Hz and 16 kHz bands
 * live at.
 */
export function magnitudeDb(
  coefficients: BiquadCoefficients,
  frequency: number,
  sampleRate: number,
): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w);
  const sin2W = Math.sin(2 * w);
  const numRe =
    coefficients.b0 + coefficients.b1 * cosW + coefficients.b2 * cos2W;
  const numIm = coefficients.b1 * sinW + coefficients.b2 * sin2W;
  const denRe = 1 + coefficients.a1 * cosW + coefficients.a2 * cos2W;
  const denIm = coefficients.a1 * sinW + coefficients.a2 * sin2W;
  const numerator = Math.hypot(numRe, numIm);
  const denominator = Math.hypot(denRe, denIm);
  if (denominator <= 0) {
    return 0;
  }
  return linearToDb(numerator / denominator);
}

/**
 * How many points the composite sweep uses.
 *
 * Log-spaced across 20 Hz - 20 kHz, PLUS every band centre evaluated exactly.
 *
 * The extra exact evaluations are not tidiness. A pure log grid does not land on
 * 31 Hz - and a lone +12 dB band there measures 11.9945 dB on the grid, i.e.
 * 0.0055 dB UNDER its own gain. That is inaudible and irrelevant to the
 * arithmetic, and it is still the wrong direction for a function whose job is to
 * size headroom: it must never under-report, because everything built on it
 * assumes the number is an upper bound. Ten extra evaluations cost nothing and
 * make the guarantee real rather than approximate.
 *
 * The residual imprecision that remains is a peak of the SUMMED response falling
 * strictly between two samples. `SAFETY_MARGIN_DB` is sized to cover it.
 */
const SWEEP_POINTS = 512;

const SWEEP_MIN_HZ = 20;
const SWEEP_MAX_HZ = 20_000;

/**
 * The maximum positive gain of the WHOLE CHAIN, in dB.
 *
 * This is the function addendum §8 asks for, and it is the reason this module
 * exists. It sums the individual responses in dB (which is what cascading
 * filters do - magnitudes multiply, decibels add), samples the sum, and
 * returns the peak. Never negative: a curve that only attenuates has no headroom
 * problem, and reporting a negative ceiling would make the preamp logic boost
 * the signal, which is the one outcome §10 forbids.
 *
 * Cost is ~512 evaluations of 10 biquads, once per configuration change, not
 * per frame and not per audio sample. That is a few hundred microseconds and it
 * happens when somebody moves a slider.
 */
export function compositeMaxGainDb(
  bands: readonly EQBand[],
  sampleRate: number = NOMINAL_SAMPLE_RATE,
): number {
  if (bands.length === 0) {
    return 0;
  }
  const sets = bands.map((band) => peakingCoefficients(band, sampleRate));
  const evaluate = (frequency: number): number => {
    let sum = 0;
    for (const coefficients of sets) {
      sum += magnitudeDb(coefficients, frequency, sampleRate);
    }
    return sum;
  };

  const ratio = SWEEP_MAX_HZ / SWEEP_MIN_HZ;
  let peakDb = 0;
  for (let i = 0; i <= SWEEP_POINTS; i += 1) {
    const sum = evaluate(SWEEP_MIN_HZ * ratio ** (i / SWEEP_POINTS));
    if (sum > peakDb) {
      peakDb = sum;
    }
  }
  // Every band centre, evaluated exactly, so the sweep can never report less
  // than a band's own maximum - which is the one property a headroom ceiling
  // has to have.
  for (const band of bands) {
    if (band.frequency < SWEEP_MIN_HZ || band.frequency > SWEEP_MAX_HZ) {
      continue;
    }
    const sum = evaluate(band.frequency);
    if (sum > peakDb) {
      peakDb = sum;
    }
  }
  return peakDb;
}

/**
 * The naive bound, kept because the difference between it and the real one is
 * the whole argument for this file. Never used to size headroom.
 */
export function maxBandGainDb(bands: readonly EQBand[]): number {
  return bands.reduce((peak, band) => Math.max(peak, band.gain), 0);
}

/**
 * Automatic headroom for a user curve (addendum §7, §8).
 *
 *   ceiling  = the chain's real maximum positive gain
 *   preamp   = -(ceiling + SAFETY_MARGIN_DB), clamped into [PREAMP_MIN_DB, 0]
 *
 * NEVER POSITIVE, and never inherited. A custom curve with a +6 dB band gets
 * roughly -6.5 dB of preamp, not the -3.5 dB the shipped preset happens to use
 * (addendum §7) and not zero. A curve that only cuts gets 0 dB, because there
 * is nothing to make room for.
 */
/**
 * The preamp a configuration would need, before the range clamps it.
 *
 * Exposed separately from `autoPreampDb` because the clamp is a real limit and
 * hiding it would be a lie: a curve with every band at +12 dB needs about
 * -18.9 dB, which is outside the -12 dB floor, and in that state the chain
 * still has several dB of gain. The interface uses this to SAY that, rather
 * than displaying a reassuring clamped number.
 */
export function requiredPreampDb(
  bands: readonly EQBand[],
  sampleRate: number = NOMINAL_SAMPLE_RATE,
): number {
  const ceiling = compositeMaxGainDb(bands, sampleRate);
  // Same rule as `autoPreampDb`, so "required" and "applied" can never
  // disagree about a curve that boosts nothing.
  if (ceiling <= 0) {
    return 0;
  }
  return -(ceiling + SAFETY_MARGIN_DB);
}

/**
 * Automatic headroom for a user curve (addendum §7, §8).
 *
 *   ceiling  = the chain's real maximum positive gain
 *   preamp   = -(ceiling + SAFETY_MARGIN_DB), clamped into [PREAMP_MIN_DB, 0]
 *
 * NEVER POSITIVE, and never inherited. A custom curve with a +6 dB band gets
 * roughly -6.5 dB of preamp, not the -3.5 dB the shipped preset happens to use
 * (addendum §7) and not zero. A curve that only cuts gets 0 dB, because there
 * is nothing to make room for.
 *
 * **A CURVE THAT BOOSTS NOTHING GETS EXACTLY 0 dB, NOT -0.5 dB.** The safety
 * margin exists to absorb overshoot *caused by* boost - inter-sample peaks and
 * decoder overshoot, which are consequences of having made the signal louder.
 * With no boost there is no overshoot to absorb, and subtracting the margin
 * anyway would quietly attenuate a flat signal by half a decibel for no reason.
 * That is the same failure §11 and §48 are about, arriving from the other
 * direction: not inheriting a stale preamp, but inventing a new one.
 */
export function autoPreampDb(
  bands: readonly EQBand[],
  sampleRate: number = NOMINAL_SAMPLE_RATE,
): number {
  const ceiling = compositeMaxGainDb(bands, sampleRate);
  if (ceiling <= 0) {
    return 0;
  }
  return clampPreampDb(-(ceiling + SAFETY_MARGIN_DB));
}

/**
 * Whether the automatic figure had to be clamped, i.e. cannot be honoured.
 *
 * The comparison carries a tolerance, and it needs one. A band at exactly
 * +11.5 dB needs exactly the -12.0 dB floor - but evaluating a biquad's
 * magnitude response in floating point returns 11.500000000000037, so the
 * requirement computes to -12.000000000000037 and a bare `<` against the floor
 * reports a curve that fits as one that does not. The error is 3.7e-14 dB, which
 * is -144 dB as an amplitude ratio: nothing, and certainly not a reason to tell
 * somebody their headroom is inadequate. The tolerance is 1e-9 dB, which is
 * still far below anything a filter coefficient can meaningfully resolve.
 */
export function headroomSaturated(
  bands: readonly EQBand[],
  sampleRate: number = NOMINAL_SAMPLE_RATE,
): boolean {
  return requiredPreampDb(bands, sampleRate) < PREAMP_MIN_DB - HEADROOM_EPSILON_DB;
}

export function clampPreampDb(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(PREAMP_MAX_DB, Math.max(PREAMP_MIN_DB, value));
}

/** Snaps a band gain to the slider grid and clamps it into range. */
export function quantizeBandGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(
    EQ_BAND_GAIN_MAX_DB,
    Math.max(EQ_BAND_GAIN_MIN_DB, value),
  );
  return Number(
    (Math.round(clamped / EQ_BAND_GAIN_STEP_DB) * EQ_BAND_GAIN_STEP_DB).toFixed(1),
  );
}

/**
 * What the graph is actually told to play.
 *
 * BYPASS IS A NEUTRAL PATH, NOT A DISCONNECT (addendum §12). When EQ is off
 * this returns every band at 0 dB and a preamp of 0 dB - so the filters are
 * still there, still connected, still smoothing, and the signal passes through
 * them at unity.
 *
 * That is not a stylistic choice, it is forced by the audio architecture.
 * Once an element has been connected to a `MediaElementAudioSourceNode` its
 * output goes through the graph and there is no supported way to route it back
 * to the speakers. Tearing the graph down on bypass would not restore direct
 * playback, it would produce SILENCE. Bypass is therefore unity gain, and the
 * alternative - rebuilding the graph - is both slower and the thing §12 and §28
 * forbid.
 */
export function effectiveGraphState(config: EQConfig): {
  bands: EQBand[];
  preampDb: number;
} {
  if (!config.enabled) {
    return { bands: cloneBands(FLAT_BANDS), preampDb: 0 };
  }
  return {
    bands: cloneBands(config.bands),
    preampDb: resolvePreampDb(config),
  };
}

/**
 * The preamp a configuration actually uses.
 *
 * `auto` asks the arithmetic; `manual` is clamped and nothing more. A manual
 * value is still bounded by `PREAMP_MAX_DB`, so a hand-edited cookie asking for
 * +6 dB of preamp cannot amplify a boosted signal into clipping (addendum §10).
 */
export function resolvePreampDb(config: EQConfig): number {
  if (config.preampMode === "auto") {
    return autoPreampDb(config.bands);
  }
  return clampPreampDb(config.manualPreampDb);
}

/**
 * The preamp a SHIPPED PRESET declares, which is a design decision and is
 * deliberately NOT re-derived.
 *
 * For `aurora-v` this is `DEFAULT_PREAMP_DB` (-3.5), not
 * `autoPreampDb(AURORA_V_SHAPE)`. Deriving it would replace a specified,
 * documented figure with a computed one that moves whenever the curve or the
 * sample rate does - and the specified figure is what §52 exists to protect.
 * `flat` is 0, so it can never inherit the V-Shape's compensation.
 */
export function presetPreampDb(presetId: EQPresetId): number {
  if (presetId === "flat") {
    return 0;
  }
  if (presetId === "custom") {
    return 0;
  }
  return DEFAULT_PREAMP_DB;
}

/**
 * Selecting a preset replaces the bands AND the headroom together (addendum §9).
 *
 * Both, atomically, because "an old preset preamp left attached after switching
 * to a custom configuration" is the exact failure §9 names: a user who switches
 * from a -3.5 dB curve to a flat one and keeps -3.5 dB hears a quieter, duller
 * signal and concludes Flat is broken.
 */
export function selectPreset(presetId: EQPresetId): EQConfig {
  if (presetId === "custom") {
    // Entering "custom" keeps the bands that are on screen - the user is about
    // to edit them - but drops to automatic headroom immediately, because the
    // moment a band moves the old preset's fixed number is wrong.
    return {
      ...DEFAULT_EQ,
      enabled: true,
      presetId: "custom",
      preampMode: "auto",
    };
  }
  const preset = EQ_PRESETS[presetId];
  return {
    enabled: true,
    presetId,
    bands: cloneBands(preset.bands),
    preampMode: preset.preamp === "auto" ? "auto" : "manual",
    manualPreampDb: preset.preamp === "auto" ? DEFAULT_PREAMP_DB : preset.preamp,
  };
}

/**
 * Is this preset ACTUALLY applied, as opposed to merely named?
 *
 * `presetId` alone is not enough to answer that, and treating it as enough is a
 * real bug with two faces:
 *
 *   - A hand-edited cookie can name `aurora-v` while carrying gains that are not
 *     the V-Shape. A store that short-circuits on the id would then report
 *     "Aurora V-Shape selected" while playing something else, and the listener's
 *     only way to get the real curve back would be to select something else
 *     first. The name would be a lie the interface cannot see.
 *   - Selecting the already-selected preset has to be a no-op for the CURVE. It
 *     is still the case that it does not turn the equalizer on: an on/off
 *     control is the switch's job, and a radio whose selection turns a DSP on is
 *     a control that does two things badly instead of one thing well.
 *
 * So this compares what matters - the preset id, every band, and the headroom
 * the preset declares - and answers the question the interface actually needs to
 * ask. In the model rather than the store, because "what does this preset mean"
 * is the same question everywhere it is asked.
 */
export function isPresetApplied(
  config: EQConfig,
  presetId: EQPresetId,
): boolean {
  if (config.presetId !== presetId) {
    return false;
  }
  if (presetId === "custom") {
    return true;
  }
  const preset = EQ_PRESETS[presetId];
  if (config.bands.length !== preset.bands.length) {
    return false;
  }
  for (let index = 0; index < preset.bands.length; index += 1) {
    const actual = config.bands[index]!;
    const expected = preset.bands[index]!;
    if (
      actual.frequency !== expected.frequency ||
      Math.abs(actual.gain - expected.gain) > 1e-9
    ) {
      return false;
    }
  }
  // A preset with a fixed figure is in manual mode at that figure. A preset
  // whose headroom is automatic is in automatic mode. Either way, a store that
  // arrived here another way is not "applied".
  const declared = preset.preamp;
  if (declared === "auto") {
    return config.preampMode === "auto";
  }
  return (
    config.preampMode === "manual" &&
    Math.abs(config.manualPreampDb - declared) <= 1e-9
  );
}

/**
 * Moves one band, and necessarily leaves the preset (§25, §9).
 *
 * AND IT NECESSARILY LEAVES THE PRESET'S HEADROOM TOO. This is §9's exact
 * failure - "an old preset preamp left attached after switching to a custom
 * configuration" - and moving a band IS the switch to a custom configuration.
 * Without the second half, a listener who nudges 62 Hz from +3 to +6 keeps a
 * -3.5 dB preamp sized for the curve they have just left, and the chain peaks
 * nearly four decibels over unity on a boost they made a moment ago.
 *
 * BUT ONLY WHEN COMING FROM A PRESET. A curve that is ALREADY custom keeps
 * whatever mode its owner chose, because there the figure is theirs and
 * overriding it would be the system overruling a deliberate decision every time
 * somebody adjusted a neighbouring band.
 */
export function setBandGain(
  config: EQConfig,
  index: number,
  gain: unknown,
): EQConfig {
  if (index < 0 || index >= config.bands.length) {
    return config;
  }
  const bands = cloneBands(config.bands);
  bands[index] = { ...bands[index], gain: quantizeBandGain(gain) };
  const wasPreset = config.presetId !== "custom";
  return {
    ...config,
    bands,
    presetId: "custom",
    preampMode: wasPreset ? "auto" : config.preampMode,
  };
}

/** Back to the shipped default: the V-Shape, disabled, at its own preamp. */
export function resetEQ(): EQConfig {
  return {
    ...DEFAULT_EQ,
    bands: cloneBands(AURORA_V_SHAPE),
  };
}

/* ==========================================================================
   WIRE FORMAT
   ========================================================================== */

export const EQ_VERSION = 1;

/**
 * A partial of the configuration plus a version - a TYPE, not a runtime schema,
 * for the same reason `AppearanceWire` is one: the decoder is per-field by
 * design, a validator nobody calls drifts and is then trusted, and importing a
 * validation library into a client-reachable module once cost this application
 * 88 KiB of gzip for a declaration the client never evaluated.
 */
export type EQWire = { v?: number } & Partial<Omit<EQConfig, "bands">> & {
  bands?: Array<{ f: number; g: number }>;
};

/**
 * The document that travels: omits everything equal to the default, so a
 * visitor who has not touched the EQ is worth `{"v":1}`.
 */
export function encodeEQ(config: EQConfig): EQWire {
  const wire: EQWire = { v: EQ_VERSION };
  if (config.enabled !== DEFAULT_EQ.enabled) {
    wire.enabled = config.enabled;
  }
  if (config.presetId !== DEFAULT_EQ.presetId) {
    wire.presetId = config.presetId;
  }
  if (config.preampMode !== DEFAULT_EQ.preampMode) {
    wire.preampMode = config.preampMode;
  }
  if (config.manualPreampDb !== DEFAULT_EQ.manualPreampDb) {
    wire.manualPreampDb = config.manualPreampDb;
  }
  const bands = encodeBands(config.bands);
  if (bands) {
    wire.bands = bands;
  }
  return wire;
}

/** Band gains as `[frequency, gain]` pairs, or `undefined` when all are default. */
function encodeBands(bands: readonly EQBand[]): EQWire["bands"] {
  const out: NonNullable<EQWire["bands"]> = [];
  let changed = false;
  for (const band of bands) {
    const defaultGain =
      presetBandGain(DEFAULT_EQ.bands, band.frequency) ?? 0;
    if (Math.abs(band.gain - defaultGain) > 1e-9) {
      out.push({ f: band.frequency, g: band.gain });
      changed = true;
    }
  }
  return changed ? out : undefined;
}

function presetBandGain(
  bands: readonly EQBand[],
  frequency: number,
): number | undefined {
  return bands.find((band) => band.frequency === frequency)?.gain;
}

/**
 * Coerces anything into a complete, legal configuration. NEVER THROWS.
 *
 * Per-field, for the same reason `decodeAppearance` is: one bad value in a
 * hand-edited cookie or a row written by another build must cost that one
 * control, not the whole preference. Only `v` is a hard gate.
 *
 * A stored band list is re-gridded to the ten canonical centres: an unknown
 * frequency is dropped rather than added, because the graph has a fixed set of
 * ten filters and a filter whose frequency depends on stored data would be a
 * way to make the node count something a cookie controls.
 */
export function decodeEQ(value: unknown): EQConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return cloneDefault();
  }
  const record = value as Record<string, unknown>;
  const version = record.v;
  if (typeof version !== "number" || version !== EQ_VERSION) {
    return cloneDefault();
  }

  const presetId = isEQPresetId(record.presetId) ? record.presetId : DEFAULT_EQ.presetId;
  const bands = cloneBands(
    presetId === "custom" || presetId === "aurora-v"
      ? AURORA_V_SHAPE
      : FLAT_BANDS,
  );
  const preampMode =
    record.preampMode === "manual" || record.preampMode === "auto"
      ? record.preampMode
      : DEFAULT_EQ.preampMode;

  // Bands only apply when the document says the curve is the user's own;
  // a stored `flat` with stray gains is a contradiction, and the preset wins.
  const stored = record.bands;
  if (Array.isArray(stored) && presetId === "custom") {
    for (const entry of stored) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const { f, g } = entry as { f?: unknown; g?: unknown };
      if (typeof f !== "number" || typeof g !== "number") {
        continue;
      }
      const index = EQ_BAND_FREQUENCIES.indexOf(f as (typeof EQ_BAND_FREQUENCIES)[number]);
      if (index < 0) {
        continue;
      }
      bands[index] = { ...bands[index], gain: quantizeBandGain(g) };
    }
  }

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_EQ.enabled,
    presetId,
    bands,
    preampMode,
    manualPreampDb: clampPreampDb(record.manualPreampDb ?? DEFAULT_EQ.manualPreampDb),
  };
}

function cloneDefault(): EQConfig {
  return { ...DEFAULT_EQ, bands: cloneBands(DEFAULT_EQ.bands) };
}
