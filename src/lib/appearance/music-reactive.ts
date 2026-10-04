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
 * Band edges as a fraction of the spectrum, low to high.
 *
 * Bass stops at 12% (~250 Hz at 44.1 kHz), which is where a bassline lives;
 * treble starts at 55% (~2.3 kHz), where cymbals and air live. The mid band is
 * deliberately the widest because that is where most melodic content sits, and
 * mid drives the subtlest response anyway.
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
      value = {
        bass: approach(value.bass, current.bass, "bass", dt),
        mid: approach(value.mid, current.mid, "mid", dt),
        treble: approach(value.treble, current.treble, "treble", dt),
        energy: approach(value.energy, current.energy, "energy", dt),
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

/** How strongly music drives the light, per user setting. */
export const MUSIC_REACTIVE_IDS = ["off", "subtle", "full"] as const;
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
 */
export const MUSIC_REACTIVE_GAIN: Record<MusicReactiveId, number> = {
  off: 0,
  subtle: 0.45,
  full: 1,
};
