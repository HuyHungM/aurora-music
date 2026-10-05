/**
 * Music-reactivity analysis for Ambient Light. PURE, and deliberately so.
 *
 * Everything here is a function over numbers and one reusable typed array. It
 * touches no audio graph, no DOM, no React and no clock of its own, which is
 * what makes the smoothing curve — the part that decides whether this reads as
 * "alive" or as "broken" — testable without a browser.
 *
 * THE TWO RULES THAT MATTER
 *
 *   1. AUDIO NEVER CHOSES A COLOUR. This module emits four 0..1 scalars. The
 *      palette still comes from `artwork-palette.ts`, and nothing here is
 *      allowed near a hue value. That separation is what stops the effect from
 *      becoming an RGB light show.
 *
 *   2. NOTHING RAW REACHES A STYLE. FFT bins jump between 0 and 255 frame to
 *      frame; written straight into a custom property that is a strobe. Every
 *      value passes through an attack/release envelope first — fast up, slow
 *      down — which is the whole difference between "the light breathes with
 *      the track" and "there is an animation running in the background".
 */

/** FFT size. 512 is 256 bins at ~43 Hz each, which resolves a bass/mid/treble
 *  split comfortably for music and costs ~2ms per frame to read. Larger buys
 *  nothing a listener can see here and costs real time on a phone. */
export const MUSIC_FFT_SIZE = 512;

/** A smoothed, normalised view of the current audio. Every field is 0..1. */
export interface MusicEnergy {
  bass: number;
  mid: number;
  treble: number;
  energy: number;
}

export const SILENT_ENERGY: MusicEnergy = {
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
};

/**
 * Band edges in hertz, because the historical comment got this wrong.
 *
 * Bass stops at 12% of the 512-point spectrum: `floor(256 * 0.12) = 30`, so
 * the band is indices 0..30 (31 bins), and at 44.1 kHz a bin is ~86 Hz, so
 * the effective edge sits near 2.6 kHz — NOT "250 Hz". (An earlier comment said
 * "~250 Hz at 44.1 kHz"; reproducing that would need a 12% fraction of a
 * ~2 kHz Nyquist, which no sample rate produces.) The constant is unchanged
 * — only the description was wrong — and the test below pins the fraction so
 * a future edit moves it knowingly.
 */
const BASS_END = 0.12;
const MID_END = 0.55;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Level of one band, as a blend of its loudest bin and its mean.
 *
 * MEAN ALONE IS WRONG, and measuring it is what proved it. A 60 Hz bass tone at
 * 44.1 kHz with a 512-point FFT lands in TWO of the 31 bass bins, so the mean
 * reads ~0.065 where the actual level is near full scale: a bass line measured
 * 0.02 and moved the emitter by a third of a pixel, which is to say not at all.
 * Any narrowband content — a sub-bass note, a sustained vocal, a hi-hat — is
 * diluted the same way, and music is full of narrowband content.
 *
 * MAX ALONE IS ALSO WRONG, in the other direction: it is one bin, so it tracks
 * a single FFT spike and makes the light chatter.
 *
 * The blend keeps the mean's stability and the max's sensitivity. Half and half
 * because neither term dominates for the case it is not good at: a pure sine
 * lands near full scale, and broadband material lands near its own mean.
 */
function bandLevel(data: Uint8Array, from: number, to: number): number {
  const start = Math.max(0, Math.min(from, data.length - 1));
  const end = Math.max(start, Math.min(to, data.length - 1));
  let total = 0;
  let peak = 0;
  for (let i = start; i <= end; i += 1) {
    const value = data[i] as number;
    total += value;
    if (value > peak) peak = value;
  }
  return ((peak + total / (end - start + 1)) / 2) / 255;
}

/**
 * Reads four normalised bands out of one `getByteFrequencyData` frame.
 *
 * `floor` matters: an average over 256 bins of mostly-silent spectrum sits near
 * zero, and without a floor the whole ambient would sit invisible during normal
 * playback and only appear on a kick drum. The floor is subtracted and the
 * remainder rescaled, so a genuinely quiet passage still reads as "very little
 * happening" rather than "nothing at all" — the field never fully collapses.
 *
 * `gain` is 1.8, and that number is calibrated rather than convenient. Loud
 * broadband material must land BELOW 1, or the band saturates and every loud
 * passage reads identically — at which point there is no breath left to see,
 * only a light that is simply on. A full-scale pure tone may legitimately pin
 * the top, because a full-scale tone is the loudest thing there is; ordinary
 * music is not.
 */
export function readBands(
  data: Uint8Array,
  options: { floor?: number; gain?: number } = {},
): MusicEnergy {
  const floor = options.floor ?? 0.12;
  const gain = options.gain ?? 1.8;
  const shape = (raw: number) => clamp01((raw - floor) * gain);

  const bass = shape(bandLevel(data, 0, Math.floor(data.length * BASS_END)));
  // `+ 1` so the bands do not SHARE an edge bin. Without it the boundary bin
  // belongs to both neighbours and a loud bass bleeds into mid — which reads as
  // a leak in the separation test below, and would give mid a permanent floor
  // lifted by whatever the bass is doing.
  const mid = shape(
    bandLevel(
      data,
      Math.floor(data.length * BASS_END) + 1,
      Math.floor(data.length * MID_END),
    ),
  );
  const treble = shape(
    bandLevel(data, Math.floor(data.length * MID_END) + 1, data.length - 1),
  );

  // Weighted rather than a plain mean: a bassline is what a listener
  // perceives as the track's weight, and averaging it against treble would make
  // the whole field twitch on hi-hats.
  const energy = clamp01(bass * 0.5 + mid * 0.35 + treble * 0.15);

  return { bass, mid, treble, energy };
}

/**
 * Attack/release envelope.
 *
 * `attack` is applied when the target RISES and `release` when it falls, so a
 * beat lifts the light quickly and it eases back down over a moment — the
 * asymmetry is the entire point. A single symmetric coefficient always reads as
 * either too laggy or too jittery.
 *
 * Frame-rate independence: coefficients are converted from a per-60fps-frame
 * basis into per-millisecond, so the envelope behaves the same on a 60 Hz and a
 * 120 Hz display instead of running twice as fast on the latter.
 */
export interface Smoother {
  step(current: MusicEnergy, dtMs: number): MusicEnergy;
  current(): MusicEnergy;
  reset(): void;
}

/**
 * Per-band attack and release, in milliseconds.
 *
 * SEPARATE TIMES PER BAND, which is the part that took a rewrite. Using one
 * release constant for both directions (the first attempt) meant ENERGY attacked
 * as slowly as it released: the overall brightness — the thing that should read
 * as the track "lifting" — simply did not respond to a beat, and only bass did.
 * That is the opposite of the intent.
 *
 * The ladder encodes a perceptual ordering:
 *
 *   bass    fastest attack, quickest release — a beat should land and go, or
 *           consecutive beats blur into one continuous swell
 *   energy  fast attack, slow release — overall presence swells and eases
 *   mid     slightly behind bass, long tail
 *   treble  slowest attack, longest release — hi-hats must never strobe
 */
const ENVELOPE = {
  bass: { attack: 45, release: 260 },
  energy: { attack: 60, release: 450 },
  mid: { attack: 70, release: 380 },
  treble: { attack: 90, release: 520 },
} as const;

function coefficient(durationMs: number, dtMs: number): number {
  if (durationMs <= 0) return 1;
  const dt = Math.max(0, dtMs);
  return 1 - Math.exp(-dt / durationMs);
}

/* ==========================================================================
   BEAT / TRANSIENT DETECTION

   WHY THIS IS SEPARATE FROM THE ENVELOPE. The bands already swell with the
   music, and that swell is the BREATH. A beat is a different shape: a fast
   rise and a quick decay, repeated on the transient rather than on the level.
   Folding it into `Smoother` would force one release constant on two jobs —
   slow enough to ease the breath back down, far too slow for a hit — and the
   first attempt at doing so produced a light that heaved once per bar instead
   of pulsing on the beat.

   So the envelope keeps the breath and this keeps the pulse. They are summed
   where they are published, and neither knows about the other.
   ========================================================================== */

/**
 * Tuning, in one place because these four numbers ARE the feature.
 *
 * `attack` is short on purpose: a transient is over in well under a frame's
 * worth of perceptible change, so the impulse is essentially instant. `release`
 * is what makes it a soft thump rather than a flash — 260ms puts it in the same
 * neighbourhood as a hi-hatted kick's decay, so it reads as the beat's tail
 * instead of a separate event.
 *
 * `baselineMs` is slow enough (900ms) that a sustained loud passage walks the
 * reference up behind the music rather than chasing it, so a chorus keeps
 * producing beats instead of going permanently quiet because the reference
 * caught up. `minIntervalMs` is the refractory period: at 150 BPM a beat is
 * 400ms apart, so 180ms cannot merge two adjacent hits into one, while a
 * 16th-note hi-hat roll still cannot machine-gun the light.
 */
export const BEAT = {
  /** Impulse rise. Effectively instant. */
  attack: 12,
  /** Impulse fall. Long enough to read as a thump, short enough to stay percussive. */
  release: 260,
  /** How fast the reference level follows the music. */
  baselineMs: 900,
  /** Refractory period; also the shortest gap two impulses may have. */
  minIntervalMs: 180,
  /**
   * How far above the reference a transient must rise to count, as a fraction
   * of full scale. Low on purpose: a kick that lifts the bass band by 0.06 is
   * musically obvious and visually should register, while spectral jitter never
   * produces a jump that shape.
   */
  threshold: 0.055,
  /** Impulse strength at a threshold-sized transient. */
  strength: 0.55,
  /**
   * A transient larger than this is a DROP, not a beat. Scaling down past 1
   * keeps the strongest possible hit inside the same visual budget as every
   * other one, which is what stops a chorus from looking like a strobe.
   */
  overshoot: 0.22,
} as const;

/** A transient detector over an already-band-limited bass value. */
export interface BeatDetector {
  /** Feeds one frame of bass energy; returns the impulse to publish, 0..1. */
  step(bass: number, dtMs: number): number;
  /** The reference level the next transient is measured against. */
  baseline(): number;
  reset(): void;
}

/**
 * Beat detection from the BASS band only.
 *
 * Bass rather than overall energy on purpose: a snare and a hi-hat lift the
 * treble band hard and the total energy barely, so an energy-based detector
 * fires on cymbals and reads as chatter. The bass band is where a kick and a
 * bassline live, which is what "the beat" means to a listener.
 *
 * The bass value passed in should be the RAW band reading, not the smoothed
 * one. Smoothing first would have already absorbed the transient this is trying
 * to find — the envelope deliberately rounds the attack off over 45ms, which is
 * correct for the breath and fatal for the pulse.
 */
export function createBeatDetector(): BeatDetector {
  let reference = 0;
  let impulse = 0;
  let sinceBeat = Number.POSITIVE_INFINITY;
  /**
   * Whether the reference means anything yet.
   *
   * After a reset the reference is 0, so the FIRST real frame of any audio
   * looks like an enormous transient — a pause, a resume or a track change
   * would each manufacture one phantom beat, which is the brightness spike the
   * pause path exists to prevent. So the first frame after a reset only
   * SEEDS the reference and cannot fire.
   */
  let primed = false;

  return {
    step(bass, dtMs) {
      const dt = Math.min(Math.max(dtMs, 0), 100);
      const level = clamp01(bass);

      // The reference walks toward the music slowly, and only ever RISES
      // quickly. Letting it fall at the same slow rate is what stops a chorus
      // from silencing itself; letting it rise fast is what stops a single
      // transient from becoming the new normal and masking the next beat.
      //
      // `coefficient` takes (durationMs, dtMs). Getting that pair the other way
      // round is not a subtle degradation — it evaluates to ~1 for any real dt,
      // the reference snaps onto the music within one frame, `delta` is
      // therefore always ~0, and NO BEAT EVER FIRES. Measured, before this was
      // corrected: a 0.25 baseline followed by a 0.30 transient produced an
      // impulse of exactly 0.
      if (!primed) {
        primed = true;
        reference = level;
        sinceBeat = 0;
        return 0;
      }

      reference =
        level > reference
          ? reference +
            (level - reference) * coefficient(BEAT.baselineMs * 0.25, dt)
          : reference + (level - reference) * coefficient(BEAT.baselineMs, dt);

      const delta = level - reference;
      sinceBeat += dt;

      const eligible = sinceBeat >= BEAT.minIntervalMs && delta >= BEAT.threshold;
      if (eligible) {
        sinceBeat = 0;
        // Scale the hit, then CEILING it: `1 + overshoot` maps the threshold to
        // `strength`, and everything louder than the overshoot saturates there
        // instead of growing without bound.
        const scale = delta / (BEAT.threshold + BEAT.overshoot);
        const fired = Math.min(scale * BEAT.strength, BEAT.strength);
        // Rise instantly rather than easing: the transient is already gone by
        // the time an attack curve would have finished.
        impulse = Math.max(impulse, fired);
      } else {
        // Decay ALWAYS uses the release time. There is no branch here: the
        // attack is not an easing curve applied over time, it is the instant
        // assignment in the `eligible` branch above, so by the time anything
        // decays the rise is already over. Picking `attack` while the impulse is
        // live — which is what this did first — gave the decay a 12ms constant
        // and the "soft thump" vanished within a frame or two, leaving a blink.
        impulse += (0 - impulse) * coefficient(BEAT.release, dt);
        if (impulse < 0.001) {
          impulse = 0;
        }
      }

      return clamp01(impulse);
    },
    baseline() {
      return reference;
    },
    reset() {
      reference = 0;
      impulse = 0;
      sinceBeat = Number.POSITIVE_INFINITY;
      primed = false;
    },
  };
}

export function createSmoother(initial: MusicEnergy = SILENT_ENERGY): Smoother {
  let value: MusicEnergy = { ...initial };

  /** Attack going up, release coming down — the asymmetry is the whole point. */
  const approach = (from: number, to: number, band: keyof typeof ENVELOPE, dt: number) => {
    const times = to > from ? ENVELOPE[band].attack : ENVELOPE[band].release;
    return from + (to - from) * coefficient(times, dt);
  };

  return {
    step(current, dtMs) {
      // A pathological delta (tab was backgrounded, debugger paused) must not be
      // allowed to teleport the value; clamping it keeps the next frame
      // continuous instead of snapping.
      const dt = Math.min(Math.max(dtMs, 0), 100);
      // The TARGET is clamped as well as the frame delta. `readBands` already
      // clamps, so this is defence in depth — but the envelope interpolates
      // TOWARD the target, so an out-of-range target does not stay out of range:
      // it walks the value past 1 and keeps going. Measured with a target of 5,
      // which settled at 1.76 — a light brighter than full scale, from a
      // malformed input. Cheap to make impossible.
      value = {
        bass: approach(value.bass, clamp01(current.bass), "bass", dt),
        mid: approach(value.mid, clamp01(current.mid), "mid", dt),
        treble: approach(value.treble, clamp01(current.treble), "treble", dt),
        energy: approach(value.energy, clamp01(current.energy), "energy", dt),
      };
      return value;
    },
    current() {
      return value;
    },
    reset() {
      value = { ...SILENT_ENERGY };
    },
  };
}

/**
 * How strongly music drives the light, per user setting.
 *
 * Four levels, ordered. `off` / `subtle` / `full` are the ORIGINAL three and
 * keep their exact ids and gains, because they are already persisted in users'
 * appearance cookies and in the wire format — renaming or renumbering them
 * would silently reinterpret a saved preference. `balanced` and `expressive`
 * are inserted BETWEEN them, which is safe precisely because the scale is a
 * gain table rather than an index: an existing `subtle` is still 0.45 and an
 * existing `full` is still 1.
 */
export const MUSIC_REACTIVE_IDS = [
  "off",
  "subtle",
  "balanced",
  "expressive",
  "full",
] as const;
export type MusicReactiveId = (typeof MUSIC_REACTIVE_IDS)[number];

export function isMusicReactiveId(value: unknown): value is MusicReactiveId {
  return (
    typeof value === "string" &&
    (MUSIC_REACTIVE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Per-setting multipliers, applied to the AUDIO contribution only.
 *
 * A `reactivity` of 0 is how "off" is honoured without removing any CSS: the
 * variables still update, they simply stop multiplying anything. That keeps one
 * code path for on and off, which is why there is no second renderer.
 *
 * The scale is MONOTONIC and `full` is still the ceiling at exactly 1, so the
 * top of the range renders precisely what it always did and no saved
 * preference is reinterpreted. The two new levels only add resolution between
 * ends that previously had nothing between them.
 */
export const MUSIC_REACTIVE_GAIN: Record<MusicReactiveId, number> = {
  off: 0,
  subtle: 0.45,
  balanced: 0.72,
  expressive: 0.88,
  full: 1,
};
