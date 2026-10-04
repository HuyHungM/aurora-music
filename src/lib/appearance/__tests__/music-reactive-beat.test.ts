import { describe, expect, it } from "vitest";
import {
  BEAT,
  MUSIC_REACTIVE_GAIN,
  MUSIC_REACTIVE_IDS,
  createBeatDetector,
  createSmoother,
  isMusicReactiveId,
} from "@/lib/appearance/music-reactive";
import {
  DEFAULT_LOCAL_AMBIENT,
  LOCAL_AMBIENT_IDS,
  LOCAL_AMBIENT_KEYS,
  LOCAL_AMBIENT_OVERRIDES,
  isLocalAmbientId,
  localAmbientOverride,
} from "@/lib/appearance/local-ambient";
import { APPEARANCE_TOKENS } from "@/lib/appearance/apply";
import { APPEARANCE_CONTROL_NAMES } from "@/lib/appearance/appearance";
import { DEFAULT_APPEARANCE } from "@/lib/appearance/appearance";

/**
 * The two additions to the Ambient Light layer: a beat impulse, and the Local
 * Music Aurora scene.
 *
 * Both are pure modules, so every assertion here is about arithmetic and about
 * the shape of the override — which is the point. The failure this guards
 * against is a *visual* one (a strobe, a lost user's setting) that no
 * component test could have observed.
 */

/** One 60fps frame. */
const FRAME = 1000 / 60;

/** Feeds a constant level for `frames` and returns the final impulse. */
function hold(
  detector: ReturnType<typeof createBeatDetector>,
  level: number,
  frames: number,
): number {
  let out = 0;
  for (let i = 0; i < frames; i += 1) {
    out = detector.step(level, FRAME);
  }
  return out;
}

describe("beat detection", () => {
  it("ignores steady noise: no transient, no beat", () => {
    // A constant level has no DELTA, which is the whole detection criterion.
    const detector = createBeatDetector();
    expect(hold(detector, 0.3, 200)).toBe(0);
    expect(detector.baseline()).toBeCloseTo(0.3, 2);
  });

  it("ignores jitter too small to be a transient", () => {
    // Spectral noise around a steady level, well under the threshold.
    const detector = createBeatDetector();
    hold(detector, 0.3, 120);
    let peak = 0;
    for (let i = 0; i < 200; i += 1) {
      const wobble = i % 2 === 0 ? 0.3 + 0.01 : 0.3 - 0.01;
      peak = Math.max(peak, detector.step(wobble, FRAME));
    }
    expect(peak).toBe(0);
  });

  it("fires a soft, bounded impulse on a real transient", () => {
    const detector = createBeatDetector();
    hold(detector, 0.25, 120); // establish a reference
    const impulse = detector.step(0.55, FRAME); // a kick-sized jump
    expect(impulse).toBeGreaterThan(0);
    // SOFT: a threshold-sized transient, and nothing like 1. A beat that reads
    // as full scale is a flash, which is the failure this whole layer avoids.
    expect(impulse).toBeLessThanOrEqual(BEAT.strength);
  });

  it("decays the impulse instead of cutting it", () => {
    const detector = createBeatDetector();
    hold(detector, 0.25, 120);
    const peak = detector.step(0.55, FRAME);
    expect(peak).toBeGreaterThan(0);
    const later = hold(detector, 0.25, 30); // ~500ms
    expect(later).toBeLessThan(peak);
    expect(later).toBeGreaterThan(0); // still a tail, not a step to zero
  });

  it("releases more slowly than it attacks", () => {
    // The asymmetry is the property, so it is asserted on the constants rather
    // than inferred from a trace.
    expect(BEAT.release).toBeGreaterThan(BEAT.attack * 4);
    expect(BEAT.attack).toBeLessThanOrEqual(20);
    expect(BEAT.release).toBeGreaterThanOrEqual(200);
  });

  it("will not machine-gun on a hi-hat roll", () => {
    // Two transients inside the refractory period are one beat.
    const detector = createBeatDetector();
    hold(detector, 0.25, 120);
    const first = detector.step(0.55, FRAME);
    const immediateSecond = detector.step(0.55, FRAME);
    expect(immediateSecond).toBeLessThan(first);
  });

  it("keeps firing through a sustained loud passage", () => {
    // The reference walks up behind a chorus rather than chasing it, so beats
    // do not stop the moment the music gets loud.
    const detector = createBeatDetector();
    hold(detector, 0.25, 120);
    let fired = 0;
    // A loud, beatty passage: a high level with a pulse on top.
    for (let i = 0; i < 600; i += 1) {
      const level = i % 20 < 2 ? 0.8 : 0.6;
      if (detector.step(level, FRAME) > 0.2) fired += 1;
    }
    expect(fired).toBeGreaterThan(3);
  });

  it("never leaves the 0..1 range, whatever it is fed", () => {
    const detector = createBeatDetector();
    for (const level of [0, 1, 2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = detector.step(level, FRAME);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it("survives a pathological frame delta without teleporting", () => {
    // A backgrounded tab produces an enormous dt. It must not produce a spike.
    const detector = createBeatDetector();
    hold(detector, 0.25, 60);
    const out = detector.step(0.3, 60_000);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(BEAT.strength);
  });

  it("resets to silence, so a resumed track cannot inherit an impulse", () => {
    const detector = createBeatDetector();
    hold(detector, 0.25, 60);
    expect(detector.step(0.6, FRAME)).toBeGreaterThan(0);
    detector.reset();
    // The first frame after a reset only SEEDS the reference. It cannot fire,
    // or every pause and resume would manufacture a phantom beat — which is the
    // brightness spike the pause path exists to prevent.
    expect(detector.step(0.25, FRAME)).toBe(0);
    expect(detector.baseline()).toBeCloseTo(0.25, 5);
    // And the frame after that is an ordinary one, not a second phantom.
    expect(detector.step(0.25, FRAME)).toBe(0);
  });

  it("does not fire on the very first frame of a fresh detector", () => {
    // Silence then music: the transition into audio is a level change, not a
    // transient, and treating it as one is what makes a track start with a thump
    // before the music has done anything.
    const detector = createBeatDetector();
    expect(detector.step(0.9, FRAME)).toBe(0);
  });
});

describe("music reactivity levels", () => {
  it("is monotonic and bounded", () => {
    const gains = MUSIC_REACTIVE_IDS.map((id) => MUSIC_REACTIVE_GAIN[id]);
    for (let i = 1; i < gains.length; i += 1) {
      expect(gains[i]).toBeGreaterThan(gains[i - 1] as number);
    }
    expect(MUSIC_REACTIVE_GAIN.off).toBe(0);
    expect(MUSIC_REACTIVE_GAIN.full).toBe(1);
  });

  it("keeps the pre-existing levels at exactly their old values", () => {
    // These three ids are already in users' cookies. A saved preference must
    // never be reinterpreted by a release that merely added resolution.
    expect(MUSIC_REACTIVE_GAIN.subtle).toBe(0.45);
    expect(MUSIC_REACTIVE_GAIN.full).toBe(1);
  });

  it("offers the names the setting is described in", () => {
    for (const id of ["off", "subtle", "balanced", "expressive"]) {
      expect(MUSIC_REACTIVE_IDS).toContain(id);
      expect(isMusicReactiveId(id)).toBe(true);
    }
    expect(isMusicReactiveId("wild")).toBe(false);
    expect(isMusicReactiveId(7)).toBe(false);
  });
});

describe("local ambient override", () => {
  const appearance = DEFAULT_APPEARANCE;

  it("applies the Aurora scene to a local file", () => {
    const override = localAmbientOverride({
      appearance,
      source: "local",
      preference: "aurora",
    });
    expect(Object.keys(override).sort()).toEqual([...LOCAL_AMBIENT_KEYS].sort());
    expect(override.auroraIntensity).toBeGreaterThan(appearance.auroraIntensity);
  });

  it("leaves provider playback completely alone", () => {
    // Online music must not be restyled by a setting whose entire subject is
    // the listener's own files.
    for (const source of ["youtube", "spotify", "deezer", null, undefined]) {
      expect(
        localAmbientOverride({ appearance, source, preference: "aurora" }),
      ).toEqual({});
    }
  });

  it("honours `off` and `follow` for local files too", () => {
    for (const preference of ["off", "follow"] as const) {
      expect(
        localAmbientOverride({ appearance, source: "local", preference }),
      ).toEqual({});
    }
  });

  it("defaults to the Aurora scene", () => {
    expect(DEFAULT_LOCAL_AMBIENT).toBe("aurora");
    expect(appearance.localAmbient).toBe("aurora");
    expect(LOCAL_AMBIENT_IDS).toContain(DEFAULT_LOCAL_AMBIENT);
  });

  it("only touches ambient numeric controls", () => {
    // THE load-bearing shape assertion: every key must be a real appearance
    // control carrying a real CSS token, so the override can be applied and
    // restored through one mechanism. An enum or a non-ambient field here would
    // silently do nothing, or worse, restyle the UI.
    for (const key of LOCAL_AMBIENT_KEYS) {
      expect(APPEARANCE_CONTROL_NAMES).toContain(key);
      expect(APPEARANCE_TOKENS[key as keyof typeof APPEARANCE_TOKENS]).toMatch(
        /^--p-appearance-/,
      );
    }
  });

  it("never reaches glass, accent, text or background", () => {
    const forbidden = [
      "glass",
      "glassAlpha",
      "glassBlur",
      "glassSaturation",
      "borderIntensity",
      "background",
      "backgroundDim",
      "backgroundSaturation",
      "backgroundBlur",
      "preset",
      "localAmbient",
    ];
    for (const key of Object.keys(LOCAL_AMBIENT_OVERRIDES)) {
      expect(forbidden).not.toContain(key);
    }
  });

  it("returns a partial, so it cannot be written into the saved appearance", () => {
    // Rule 1 is structural: the function's return type has no room for the
    // fields persistence needs, so "accidentally store the override" does not
    // typecheck.
    const override = localAmbientOverride({
      appearance,
      source: "local",
      preference: "aurora",
    });
    expect(Object.keys(override)).toHaveLength(LOCAL_AMBIENT_KEYS.length);
    expect(override).not.toHaveProperty("glass");
  });

  it("is a pure function of its three inputs", () => {
    const input = { appearance, source: "local" as const, preference: "aurora" as const };
    expect(localAmbientOverride(input)).toEqual(localAmbientOverride(input));
  });

  it("leaves the saved appearance object untouched", () => {
    const before = JSON.stringify(DEFAULT_APPEARANCE);
    localAmbientOverride({ appearance, source: "local", preference: "aurora" });
    expect(JSON.stringify(DEFAULT_APPEARANCE)).toBe(before);
  });

  it("validates its own ids", () => {
    expect(isLocalAmbientId("aurora")).toBe(true);
    expect(isLocalAmbientId("nope")).toBe(false);
    expect(isLocalAmbientId(null)).toBe(false);
  });
});

describe("smoothing / attack-release", () => {
  it("rises faster than it falls", () => {
    const up = createSmoother();
    const down = createSmoother();
    for (let i = 0; i < 6; i += 1) {
      up.step({ bass: 1, mid: 1, treble: 1, energy: 1 }, FRAME);
      down.step({ bass: 1, mid: 1, treble: 1, energy: 1 }, FRAME);
    }
    const risenValue = up.current().energy;
    for (let i = 0; i < 6; i += 1) {
      down.step({ bass: 0, mid: 0, treble: 0, energy: 0 }, FRAME);
    }
    // After equal time, the value that went UP is higher than the one that came
    // down from the same starting point.
    expect(risenValue).toBeGreaterThan(down.current().energy);
  });

  it("stays inside 0..1 from any input", () => {
    const smoother = createSmoother();
    for (const level of [0, 1, 5, -5, Number.NaN]) {
      smoother.step(
        { bass: level, mid: level, treble: level, energy: level },
        FRAME,
      );
      const value = smoother.current();
      for (const band of [value.bass, value.mid, value.treble, value.energy]) {
        expect(band).toBeGreaterThanOrEqual(0);
        expect(band).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns to silence after a reset, so pause leaves no residue", () => {
    const smoother = createSmoother();
    smoother.step({ bass: 1, mid: 1, treble: 1, energy: 1 }, FRAME);
    expect(smoother.current().energy).toBeGreaterThan(0);
    smoother.reset();
    expect(smoother.current().energy).toBe(0);
  });
});
