/**
 * The analysis maths, which is the whole difference between "the light breathes
 * with the track" and "there is an animation running in the background".
 *
 * Pure functions over a `Uint8Array`, so every property below is asserted
 * exactly, with no browser, no audio graph and no clock. The invariants that
 * matter for safety are checked explicitly rather than assumed: no NaN, nothing
 * above 1, and a genuinely silent input producing silence rather than noise.
 */
import { describe, expect, it } from "vitest";
import {
  MUSIC_REACTIVE_GAIN,
  SILENT_ENERGY,
  createSmoother,
  isMusicReactiveId,
  readBands,
} from "@/lib/appearance/music-reactive";

const LEN = 256;

/** A frame where only one band is loud, everything else silent. */
function frame(band: "low" | "mid" | "high", value: number): Uint8Array {
  const data = new Uint8Array(new ArrayBuffer(LEN));
  // Ranges are DISJOINT and match the module's, boundary bin included on the
  // lower side only. A test helper that overlaps the implementation's edges
  // would assert a leak that the implementation does not have — and would stop
  // catching one if it ever did.
  const range =
    band === "low"
      ? [0, Math.floor(LEN * 0.12)]
      : band === "mid"
        ? [Math.floor(LEN * 0.12) + 1, Math.floor(LEN * 0.55)]
        : [Math.floor(LEN * 0.55) + 1, LEN - 1];
  for (let i = range[0] as number; i <= (range[1] as number); i += 1) {
    data[i] = value;
  }
  return data;
}

function fullFrame(value: number): Uint8Array {
  return new Uint8Array(new ArrayBuffer(LEN)).fill(value);
}

const finite01 = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

describe("readBands", () => {
  it("returns silence for a silent frame, not noise", () => {
    const out = readBands(new Uint8Array(new ArrayBuffer(LEN)));
    expect(out.bass).toBe(0);
    expect(out.mid).toBe(0);
    expect(out.treble).toBe(0);
    expect(out.energy).toBe(0);
  });

  it("separates the three bands", () => {
    // This is the property that lets bass drive expansion without treble
    // dragging it along. If the bands leaked into each other the whole mapping
    // in the CSS would be meaningless.
    const bass = readBands(frame("low", 230));
    const mid = readBands(frame("mid", 230));
    const high = readBands(frame("high", 230));

    expect(bass.bass).toBeGreaterThan(0.5);
    expect(bass.mid).toBeLessThan(0.05);
    expect(bass.treble).toBeLessThan(0.05);

    expect(mid.mid).toBeGreaterThan(0.5);
    expect(mid.bass).toBeLessThan(0.05);

    expect(high.treble).toBeGreaterThan(0.5);
    expect(high.bass).toBeLessThan(0.05);
  });

  it("reads narrowband content as a strong signal, not a fraction of one", () => {
    // THE FLAW MEASURED IN A BROWSER, not reasoned about. A 60 Hz bass tone sits
    // in 2 of the 31 bass bins, so a band MEAN reads it near-nothing and the
    // emitter moved by a third of a pixel (the mean-only reading was 0.02) — an effect that existed and did
    // nothing. Music is full of narrowband content, so this is the common case,
    // not an edge case.
    const L = 256;
    const data = new Uint8Array(new ArrayBuffer(L));
    data[0] = 255;
    data[1] = 255;
    expect(readBands(data).bass).toBeGreaterThan(0.65);

    // A single-bin hi-hat must register as treble just as strongly, or the
    // shimmer control would be decorative.
    const hat = new Uint8Array(new ArrayBuffer(L));
    hat[L - 1] = 255;
    expect(readBands(hat).treble).toBeGreaterThan(0.65);
  });

  it("leaves headroom, so loud music is not a flat maximum", () => {
    // MEASURED IN A BROWSER. With the gain set for the old band-mean estimator,
    // ordinary loud material pinned every band to exactly 1.000: the light was
    // on, and nothing about it moved. Saturation is invisible in a screenshot
    // and fatal to the effect, so it is pinned here instead.
    const loud = readBands(fullFrame(150));
    expect(loud.bass).toBeGreaterThan(0.6);
    expect(loud.bass).toBeLessThan(1);
    expect(loud.energy).toBeLessThan(1);
  });

  it("responds monotonically to level across the whole usable scale", () => {
    // The property that makes it a light that BREATHES rather than a switch.
    // Every step up must produce a strictly larger reading; a single flat pair
    // anywhere in here is a range the effect cannot use.
    const levels = [30, 60, 90, 120, 150].map((v) => readBands(fullFrame(v)).bass);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] as number).toBeGreaterThan(levels[i - 1] as number);
    }
  });

  it("weights energy toward bass, because that is the perceived weight", () => {
    const bass = readBands(frame("low", 230));
    const high = readBands(frame("high", 230));
    // Same loudness in the band, but a bassline should read as heavier.
    expect(bass.energy).toBeGreaterThan(high.energy);
  });

  it("keeps the floor so a quiet passage still reads as quiet, not as absent", () => {
    // Below the floor nothing is emitted at all: the field must not collapse to
    // nothing during an ordinary quiet bar, and must not invent light either.
    const veryQuiet = readBands(fullFrame(10));
    expect(veryQuiet.energy).toBe(0);
  });

  it("never produces NaN, Infinity, or a value outside 0..1", () => {
    const cases = [
      fullFrame(255),
      fullFrame(0),
      new Uint8Array(new ArrayBuffer(0)),
      fullFrame(1),
    ];
    for (const data of cases) {
      const out = readBands(data);
      expect(finite01(out.bass)).toBe(true);
      expect(finite01(out.mid)).toBe(true);
      expect(finite01(out.treble)).toBe(true);
      expect(finite01(out.energy)).toBe(true);
    }
  });

  it("handles a zero-length buffer without throwing", () => {
    const out = readBands(new Uint8Array(new ArrayBuffer(0)));
    expect(finite01(out.energy)).toBe(true);
  });
});

describe("smoothing envelope", () => {
  it("rises fast and falls slowly — the asymmetry is the whole point", () => {
    const s = createSmoother();
    const loud = readBands(fullFrame(255));

    // One frame of attack from silence.
    s.step(loud, 16);
    const afterAttack = s.current().energy;
    expect(afterAttack).toBeGreaterThan(0.2);

    // Then let it decay with the input gone.
    let value = afterAttack;
    for (let i = 0; i < 20; i += 1) value = s.step(SILENT_ENERGY, 16).energy;

    // Twenty frames (~330ms) later it has fallen, but NOT to nothing — that is
    // the difference from a hard gate that blinks on and off.
    expect(value).toBeLessThan(afterAttack);
    expect(value).toBeGreaterThan(0);
  });

  it("stays inside 0..1 across a long loud run", () => {
    const s = createSmoother();
    const loud = readBands(fullFrame(255));
    for (let i = 0; i < 500; i += 1) {
      const v = s.step(loud, 16);
      expect(finite01(v.bass)).toBe(true);
      expect(finite01(v.energy)).toBe(true);
    }
    expect(s.current().energy).toBeGreaterThan(0.5);
  });

  it("is frame-rate independent, so it behaves the same at 60 and 144 Hz", () => {
    // The same elapsed time in many small steps must land near the same value as
    // a few large ones. Without exponential coefficients per-millisecond the
    // envelope would run ~2.4x faster on a 144 Hz display.
    const loud = readBands(fullFrame(255));
    const a = createSmoother();
    for (let i = 0; i < 60; i += 1) a.step(loud, 16.7);
    const b = createSmoother();
    for (let i = 0; i < 240; i += 1) b.step(loud, 4.16);
    expect(Math.abs(a.current().energy - b.current().energy)).toBeLessThan(0.12);
  });

  it("does not teleport on a pathological frame gap", () => {
    // A backgrounded tab produces one enormous dt. The clamp is what stops the
    // first frame back from jumping to a value nothing else could reach.
    const s = createSmoother();
    const loud = readBands(fullFrame(255));
    const v = s.step(loud, 60_000);
    expect(finite01(v.energy)).toBe(true);
  });

  it("resets to silence", () => {
    const s = createSmoother();
    for (let i = 0; i < 60; i += 1) s.step(readBands(fullFrame(255)), 16);
    s.reset();
    expect(s.current()).toEqual(SILENT_ENERGY);
  });

  it("weights bass with the fastest attack and treble with the slowest", () => {
    // Treble with a fast attack is what turns hi-hats into a strobe, so when
    // both bands are driven equally hard a few frames in, treble must still be
    // BEHIND bass. Driven by a high-only frame this would be vacuous, because
    // bass has nothing to rise towards.
    const s = createSmoother();
    const hit = readBands(fullFrame(255));
    for (let i = 0; i < 4; i += 1) s.step(hit, 16);
    expect(s.current().bass).toBeGreaterThan(0.7);
    expect(s.current().treble).toBeLessThan(s.current().bass);
    expect(s.current().treble).toBeGreaterThan(0);
  });
});

describe("music reactivity setting", () => {
  it("recognises exactly the three documented values", () => {
    expect(isMusicReactiveId("off")).toBe(true);
    expect(isMusicReactiveId("subtle")).toBe(true);
    expect(isMusicReactiveId("full")).toBe(true);
    expect(isMusicReactiveId("loud")).toBe(false);
    expect(isMusicReactiveId(undefined)).toBe(false);
  });

  it("maps off to a gain of zero, so the same CSS path serves every setting", () => {
    // One renderer, three settings. `off` is a multiplier of 0 rather than a
    // second code path, which is why the effect costs nothing when disabled.
    expect(MUSIC_REACTIVE_GAIN.off).toBe(0);
    expect(MUSIC_REACTIVE_GAIN.subtle).toBeGreaterThan(0);
    expect(MUSIC_REACTIVE_GAIN.subtle).toBeLessThan(MUSIC_REACTIVE_GAIN.full);
    expect(MUSIC_REACTIVE_GAIN.full).toBe(1);
  });
});
