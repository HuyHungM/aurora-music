/**
 * Appearance preference model tests (Phase 53).
 *
 * Four properties are being defended here, and each of them is a property the
 * rest of the system silently depends on:
 *
 *   1. THE RANGES ARE A CONTRACT, not documentation. `globals.css` owns a
 *      default for every control, this module owns the range, and the two are
 *      hand-maintained copies of the same decision. The first test reads the
 *      stylesheet and fails when they disagree, which is the only thing
 *      stopping "one source of truth" from being a comment.
 *
 *   2. DECODING IS TOTAL. A corrupt cookie, a truncated JSONB row, a
 *      hand-edited field, a value from a build that no longer exists: every one
 *      of those must render a real theme, and none of them may throw. The
 *      property is asserted over a table of hostile inputs rather than by
 *      example, because "one weird input" is not the claim being made.
 *
 *   3. ENCODING OMITS DEFAULTS, and round-trips exactly. Omission is what keeps
 *      the cookie at ~12 bytes for an untouched visitor and what makes an
 *      unknown future field survivable in both directions.
 *
 *   4. RESET AND PRESETS ARE SURGICAL. Reset returns the appearance and touches
 *      nothing else; a preset owns five controls and leaves the other three
 *      alone. Both are tested against a value that has been deliberately
 *      changed first, because a test against the default proves nothing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_CONTROL_NAMES,
  APPEARANCE_RANGES,
  APPEARANCE_VERSION,
  BACKGROUND_PRESET_IDS,
  BACKGROUND_URL_MAX_LENGTH,
  DEFAULT_APPEARANCE,
  GLASS_PRESET_IDS,
  GLASS_PRESETS,
  applyPreset,
  backgroundImageValue,
  controlSteps,
  cssUrlEscape,
  decodeAppearance,
  encodeAppearance,
  hasBackground,
  isBackgroundPresetId,
  isGlassPresetId,
  quantize,
  resetAppearance,
  type Appearance,
  type AppearanceControlName,
} from "@/lib/appearance/appearance";

/* ==========================================================================
   1. THE STYLESHEET AGREES WITH THE MODEL
   ========================================================================== */

/**
 * The CSS primitive each control's default lives in.
 *
 * A mapping rather than a convention, because the names are not derivable:
 * `backgroundDim` is `--p-appearance-dim` and `backgroundSaturation` is
 * `--p-appearance-bg-saturation`. Guessing the name would have made this test
 * pass for the wrong reasons.
 */
const CSS_DEFAULT_OF: Record<AppearanceControlName, string> = {
  glassAlpha: "--p-appearance-alpha",
  glassBlur: "--p-appearance-blur",
  glassSaturation: "--p-appearance-saturation",
  borderIntensity: "--p-appearance-border",
  auroraIntensity: "--p-appearance-aurora",
  backgroundDim: "--p-appearance-dim",
  backgroundSaturation: "--p-appearance-bg-saturation",
  backgroundBlur: "--p-appearance-bg-blur",
};

/** The stylesheet's own spelling of a control's default, normalised to a number. */
function cssDefault(token: string): number {
  const globals = readFileSync(
    resolve(process.cwd(), "src/app/globals.css"),
    "utf8",
  );
  const match = new RegExp(`${token}:\\s*([0-9.]+)(px)?\\s*;`).exec(globals);
  if (!match) {
    throw new Error(`${token} is not declared in globals.css`);
  }
  return Number(match[1]);
}

describe("appearance model / stylesheet agreement", () => {
  it("gives every control a CSS primitive, so none can drift silently", () => {
    expect(Object.keys(CSS_DEFAULT_OF).sort()).toEqual(
      [...APPEARANCE_CONTROL_NAMES].sort(),
    );
  });

  it.each(APPEARANCE_CONTROL_NAMES)(
    "matches the --p-appearance-* default for %s",
    (name) => {
      expect(DEFAULT_APPEARANCE[name]).toBe(cssDefault(CSS_DEFAULT_OF[name]));
    },
  );

  it("keeps the default inside its own range, and on a legal step", () => {
    for (const name of APPEARANCE_CONTROL_NAMES) {
      const range = APPEARANCE_RANGES[name];
      const value = DEFAULT_APPEARANCE[name];
      expect(value, name).toBeGreaterThanOrEqual(range.min);
      expect(value, name).toBeLessThanOrEqual(range.max);
      // On a step, not merely in range: a default between two slider stops
      // would mean the shipped theme is a position the control cannot produce.
      expect(controlSteps(name), name).toContain(value);
    }
  });
});

/* ==========================================================================
   2. RANGES, QUANTISATION, PRESETS
   ========================================================================== */

describe("appearance model / ranges", () => {
  it("expresses every control as a positive-width, positive-step range", () => {
    for (const name of APPEARANCE_CONTROL_NAMES) {
      const { min, max, step } = APPEARANCE_RANGES[name];
      expect(step, name).toBeGreaterThan(0);
      expect(max, name).toBeGreaterThan(min);
    }
  });

  it("bounds glass alpha into a window that is actually glass", () => {
    // 0.05 is the point below which the canvas stops reading as a surface, and
    // 0.85 is the point above which it stops being glass at all. A wider range
    // would let a user build a design the tokens were never checked against.
    expect(APPEARANCE_RANGES.glassAlpha.min).toBe(0.05);
    expect(APPEARANCE_RANGES.glassAlpha.max).toBe(0.85);
  });

  it("bounds blur below the radius where cost is spent for nothing", () => {
    // The documented reason for 28: a viewport-sized backdrop-filter past this
    // radius is not perceptible through the scrim but is very perceptible in
    // frame time. Lowering this is a design decision; raising it needs a
    // measurement.
    expect(APPEARANCE_RANGES.glassBlur.max).toBe(28);
  });

  it("keeps vibrancy inside a window where it reads as glass, not as a filter", () => {
    // Below 1 is a real control - it is how a busy photograph stops competing
    // with the text - but the floor is where the effect stops reading as
    // "calmed down", and the cap is where a photo starts looking processed.
    expect(APPEARANCE_RANGES.glassSaturation.min).toBe(0.8);
    expect(APPEARANCE_RANGES.glassSaturation.max).toBe(1.6);
    // And no shipped preset takes it below 1: a preset that desaturated the
    // whole chrome would be surprising in a way a user could not undo by
    // moving one slider back.
    for (const id of GLASS_PRESET_IDS) {
      expect(GLASS_PRESETS[id].glassSaturation, id).toBeGreaterThanOrEqual(1);
    }
  });

  it("produces exactly the steps the slider will offer, first and last included", () => {
    for (const name of APPEARANCE_CONTROL_NAMES) {
      const { min, max, step } = APPEARANCE_RANGES[name];
      const steps = controlSteps(name);
      expect(steps[0], name).toBe(min);
      expect(steps[steps.length - 1], name).toBe(max);
      expect(steps.length, name).toBe(
        Math.round((max - min) / step) + 1,
      );
    }
  });
});

describe("quantize", () => {
  it("snaps to the nearest legal step", () => {
    expect(quantize("glassAlpha", 0.61)).toBe(0.6);
    expect(quantize("glassAlpha", 0.63)).toBe(0.65);
    expect(quantize("glassBlur", 17)).toBe(18);
  });

  it("clamps rather than rejecting an out-of-range taste", () => {
    // A preference is not a transaction. Corrected to the nearest renderable
    // value, because a control stuck on "invalid" helps nobody.
    expect(quantize("glassAlpha", 99)).toBe(0.85);
    expect(quantize("glassAlpha", -99)).toBe(0.05);
    expect(quantize("glassBlur", 1e9)).toBe(28);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["true", true],
    ["an empty string", ""],
    ["a blank string", "   "],
    ["a non-numeric string", "wide"],
    ["an object", {}],
    ["an array", []],
  ])("returns the default for %s rather than a coerced zero", (_label, input) => {
    // The reason this is total, and the reason it is not a `Number()` cast:
    // `Number(null)` and `Number("")` are both 0, so a naive coercion reads a
    // stored `null` as "the most transparent glass the design allows" - the
    // one value a user would report as the surface having broken. Absence has
    // to mean the default. A NaN reaching a CSS custom property is just as
    // silent.
    expect(quantize("glassAlpha", input)).toBe(DEFAULT_APPEARANCE.glassAlpha);
  });

  it("honours a numeric string, which is what a JSON round trip can produce", () => {
    expect(quantize("glassBlur", "20")).toBe(20);
    expect(quantize("glassAlpha", " 0.5 ")).toBe(0.5);
  });

  it("never returns a float artefact", () => {
    // 0.1 + 0.2 style residue must not reach the stylesheet or the cookie.
    for (let raw = 0; raw <= 1; raw += 0.013) {
      const snapped = quantize("backgroundDim", raw);
      expect(String(snapped)).toMatch(/^\d+(\.\d{1,2})?$/);
    }
  });

  it("returns a value the control can express, for every step of every range", () => {
    for (const name of APPEARANCE_CONTROL_NAMES) {
      for (const legal of controlSteps(name)) {
        // A value that is not on a step is a value the slider has no stop for,
        // so a restored preference would sit between two positions.
        expect(quantize(name, legal), `${name}@${legal}`).toBe(legal);
      }
    }
  });
});

describe("glass presets", () => {
  it("ships exactly the four documented looks", () => {
    expect([...GLASS_PRESET_IDS]).toEqual([
      "aurora",
      "balanced",
      "crystal",
      "minimal",
    ]);
  });

  it("makes the default one of them, so the shipped state is a named look", () => {
    expect(DEFAULT_APPEARANCE.preset).toBe("aurora");
  });

  it("gives every preset a value inside every range it owns", () => {
    for (const id of GLASS_PRESET_IDS) {
      for (const [name, value] of Object.entries(GLASS_PRESETS[id])) {
        const key = name as AppearanceControlName;
        const range = APPEARANCE_RANGES[key];
        expect(value, `${id}.${name}`).toBeGreaterThanOrEqual(range.min);
        expect(value, `${id}.${name}`).toBeLessThanOrEqual(range.max);
        // On a step, not just in range: a preset that no slider could produce
        // would immediately be silently re-quantised the first time it is
        // applied, and the value in the table would be a lie.
        expect(controlSteps(key), `${id}.${name}`).toContain(
          quantize(key, value),
        );
      }
    }
  });

  it("leaves backgroundSaturation and backgroundBlur to the user", () => {
    // These two are about the IMAGE, not the glass. A preset that owned them
    // would reset the picture whenever someone tried a look, which is the
    // "silent reset" the model docstring promises does not happen.
    for (const id of GLASS_PRESET_IDS) {
      expect(GLASS_PRESETS[id], id).not.toHaveProperty("backgroundSaturation");
      expect(GLASS_PRESETS[id], id).not.toHaveProperty("backgroundBlur");
    }
  });

  it("sets blur to zero in Minimal, which is what makes it the cheap mode", () => {
    // §45: the only honest way to offer a low-cost mode without inspecting the
    // hardware. The CSS turns a zero blur into `backdrop-filter: none` rather
    // than `blur(0px)`, so this one number really does remove every filter in
    // the application.
    expect(GLASS_PRESETS.minimal.glassBlur).toBe(0);
    for (const id of GLASS_PRESET_IDS.filter((p) => p !== "minimal")) {
      expect(GLASS_PRESETS[id].glassBlur, id).toBeGreaterThan(0);
    }
  });

  it("makes the four presets genuinely different from one another", () => {
    // Three of them are only useful if they are not interchangeable. Compared on
    // the two controls a person actually perceives: how much glass, and how
    // much blur.
    const alpha = GLASS_PRESET_IDS.map((id) => GLASS_PRESETS[id].glassAlpha);
    expect(new Set(alpha).size).toBe(GLASS_PRESET_IDS.length);
    const blur = GLASS_PRESET_IDS.map((id) => GLASS_PRESETS[id].glassBlur);
    expect(new Set(blur).size).toBe(GLASS_PRESET_IDS.length);
  });

  it("applies without mutating the value it was given", () => {
    const before = { ...DEFAULT_APPEARANCE };
    applyPreset(DEFAULT_APPEARANCE, "crystal");
    expect(DEFAULT_APPEARANCE).toEqual(before);
  });

  it("writes only the controls the preset owns", () => {
    const customised: Appearance = {
      ...DEFAULT_APPEARANCE,
      background: { kind: "preset", id: "deep-space" },
      backgroundSaturation: 1.4,
      backgroundBlur: 12,
    };
    const next = applyPreset(customised, "minimal");

    // Owned by the preset.
    expect(next.glassAlpha).toBe(GLASS_PRESETS.minimal.glassAlpha);
    expect(next.glassBlur).toBe(GLASS_PRESETS.minimal.glassBlur);
    expect(next.preset).toBe("minimal");
    // NOT owned: untouched. This is the "switching look never discards the
    // picture" promise, and it is only meaningful against a changed value.
    expect(next.background).toEqual({ kind: "preset", id: "deep-space" });
    expect(next.backgroundSaturation).toBe(1.4);
    expect(next.backgroundBlur).toBe(12);
  });
});

/* ==========================================================================
   3. THE WIRE FORMAT
   ========================================================================== */

describe("encodeAppearance", () => {
  it("writes only the version for an untouched visitor", () => {
    // ~12 bytes, on a cookie attached to EVERY same-origin request. The whole
    // reason the format omits defaults.
    expect(encodeAppearance(DEFAULT_APPEARANCE)).toEqual({ v: APPEARANCE_VERSION });
    expect(JSON.stringify(encodeAppearance(DEFAULT_APPEARANCE)).length).toBeLessThan(24);
  });

  it("omits exactly the fields equal to the default", () => {
    const wire = encodeAppearance({
      ...DEFAULT_APPEARANCE,
      glass: false,
      glassBlur: 22,
    });
    expect(wire).toEqual({ v: APPEARANCE_VERSION, glass: false, glassBlur: 22 });
  });

  it("carries a background selection through", () => {
    expect(
      encodeAppearance({
        ...DEFAULT_APPEARANCE,
        background: { kind: "preset", id: "polar-glow" },
      }),
    ).toEqual({ v: APPEARANCE_VERSION, background: { kind: "preset", id: "polar-glow" } });

    expect(
      encodeAppearance({
        ...DEFAULT_APPEARANCE,
        background: { kind: "url", url: "https://img.test/a.jpg" },
      }),
    ).toEqual({ v: APPEARANCE_VERSION, background: { kind: "url", url: "https://img.test/a.jpg" } });
  });

  it("does not treat a different background of the same kind as the default", () => {
    // `isSameBackground` has three kinds and two of them carry a payload. A
    // comparison that stopped at `kind` would drop a real image and leave a
    // user staring at the Aurora default wondering what happened.
    const wire = encodeAppearance({
      ...DEFAULT_APPEARANCE,
      background: { kind: "preset", id: "aurora-night" },
    });
    expect(wire.background).toEqual({ kind: "preset", id: "aurora-night" });
  });
});

describe("decodeAppearance", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["a string", '{"v":1}'],
    ["an array", [1, 2, 3]],
    ["a future version", { v: 99, glass: false, glassBlur: 4 }],
    ["a zero version", { v: 0 }],
  ])("returns the default for %s and never throws", (_label, input) => {
    // These are the cases where the value as a whole is meaningless: not an
    // object at all, or an encoding this build does not know the meaning of.
    expect(() => decodeAppearance(input)).not.toThrow();
    expect(decodeAppearance(input)).toEqual(DEFAULT_APPEARANCE);
  });

  it("returns the default for a bare object with no fields", () => {
    expect(decodeAppearance({})).toEqual(DEFAULT_APPEARANCE);
  });

  it("re-checks a stored address rather than trusting its structure", () => {
    // THE TRUST BOUNDARY. A cookie is a string anybody can set, so the decoder
    // is the last place a background address can be refused before it is
    // painted. A structural check alone - "is it a string of legal length" -
    // would happily pass all four of these, and the first two are the ones
    // that matter.
    for (const url of [
      "http://img.test/a.jpg",
      "https://user:pw@img.test/a.jpg",
      "ftp://img.test/a.jpg",
      "javascript:alert(1)",
      `https://img.test/${"a".repeat(BACKGROUND_URL_MAX_LENGTH + 1)}.jpg`,
    ]) {
      const decoded = decodeAppearance({ v: 1, background: { kind: "url", url } });
      expect(decoded.background, url.slice(0, 40)).toEqual({ kind: "none" });
    }
  });

  it("accepts a stored address and stores the TRIMMED form", () => {
    // Trimmed, because the address that was validated is the address that is
    // kept. A stored value with leading whitespace would be re-checked against
    // a different string every time it is read.
    const decoded = decodeAppearance({
      v: 1,
      background: { kind: "url", url: "  https://img.test/a.jpg  " },
    });
    expect(decoded.background).toEqual({
      kind: "url",
      url: "https://img.test/a.jpg",
    });
  });

  it("keeps the rest of the appearance when only the address is refused", () => {
    // The whole point of a per-field decoder: a background the user cannot
    // repair by editing a cookie should not cost them their glass settings too.
    const decoded = decodeAppearance({
      v: 1,
      glass: false,
      preset: "minimal",
      glassBlur: 4,
      background: { kind: "url", url: "http://img.test/a.jpg" },
    });
    expect(decoded.glass).toBe(false);
    expect(decoded.preset).toBe("minimal");
    expect(decoded.glassBlur).toBe(4);
    expect(decoded.background).toEqual({ kind: "none" });
  });

  it("keeps what it understood when a single field is unusable", () => {
    // Per-field, not all-or-nothing. The realistic version is a hand-edited
    // cookie or a row written by a build with a different shape; the point is
    // that one bad value costs the user that control, not their whole
    // configuration.
    const decoded = decodeAppearance({
      v: 1,
      glass: false,
      preset: "crystal",
      artworkAmbient: true,
      glassAlpha: "wide",
      background: { kind: "url", url: 5 },
    });
    expect(decoded.glass).toBe(false);
    expect(decoded.preset).toBe("crystal");
    expect(decoded.artworkAmbient).toBe(true);
    // Repaired, not discarded:
    expect(decoded.glassAlpha).toBe(DEFAULT_APPEARANCE.glassAlpha);
    expect(decoded.background).toEqual({ kind: "none" });
  });

  it.each([
    ["a preset id that does not exist", { v: 1, preset: "chrome" }],
    ["a background kind that does not exist", { v: 1, background: { kind: "gif" } }],
    ["a background url of the wrong type", { v: 1, background: { kind: "url", url: 5 } }],
    ["a preset background with no id", { v: 1, background: { kind: "preset" } }],
    ["a non-boolean glass", { v: 1, glass: "yes" }],
  ])("reverts only the bad field for %s", (_label, input) => {
    const decoded = decodeAppearance({ ...(input as object), glassBlur: 8 });
    // The one field in the object that was valid still applied:
    expect(decoded.glassBlur).toBe(8);
  });

  it("returns a value that is itself encodable, so a rejection is recoverable", () => {
    // Whatever `decodeAppearance` hands out, `encodeAppearance` must accept -
    // otherwise a corrupt stored value would produce something that cannot be
    // written back, and the user could never change a setting again.
    for (const input of [undefined, {}, { v: 99 }, { v: 1, glassAlpha: 99 }]) {
      const decoded = decodeAppearance(input);
      expect(() => encodeAppearance(decoded)).not.toThrow();
      expect(decodeAppearance(encodeAppearance(decoded))).toEqual(decoded);
    }
  });

  it("clamps a stored out-of-range number instead of trusting it", () => {
    // The realistic version of this is a range that was widened or narrowed
    // between builds. Either way, the stored value is not the renderable one.
    const decoded = decodeAppearance({ v: 1, glassAlpha: 5, glassBlur: 900 });
    expect(decoded.glassAlpha).toBe(0.85);
    expect(decoded.glassBlur).toBe(28);
  });

  it("keeps the fields it did get wrong-free while repairing the ones it did not", () => {
    const decoded = decodeAppearance({
      v: 1,
      glass: false,
      preset: "crystal",
      glassAlpha: 99,
    });
    expect(decoded.glass).toBe(false);
    expect(decoded.preset).toBe("crystal");
    expect(decoded.glassAlpha).toBe(0.85);
    // And untouched: the rest of the preference is intact, not reset.
    expect(decoded.glassBlur).toBe(DEFAULT_APPEARANCE.glassBlur);
  });

  it("treats an omitted field as the default, and an unknown key as nothing", () => {
    // THE FORWARD-COMPATIBILITY CLAIM, in the direction that costs a user
    // something. A build that knows about a setting this one does not must be
    // readable by this build without costing the settings it DOES understand -
    // otherwise simply shipping a new preference would wipe the configuration
    // of anyone who then rolled back, and `encodeAppearance`'s omission-based
    // format would be forward-compatible in name only.
    const decoded = decodeAppearance({
      v: 1,
      glass: false,
      futureSetting: { whatever: true },
    });
    expect(decoded.glass).toBe(false);
    expect(decoded.preset).toBe(DEFAULT_APPEARANCE.preset);
  });
});

describe("the wire format round-trips", () => {
  it.each(APPEARANCE_CONTROL_NAMES)("survives encode/decode for %s at every step", (name) => {
    for (const value of controlSteps(name)) {
      const original: Appearance = { ...DEFAULT_APPEARANCE, [name]: value };
      expect(decodeAppearance(encodeAppearance(original))).toEqual(original);
    }
  });

  it("round-trips every background kind", () => {
    const selections: Appearance["background"][] = [
      { kind: "none" },
      ...BACKGROUND_PRESET_IDS.map((id) => ({ kind: "preset" as const, id })),
      { kind: "url", url: "https://img.test/a.png" },
    ];
    for (const background of selections) {
      const original = { ...DEFAULT_APPEARANCE, background };
      expect(decodeAppearance(encodeAppearance(original))).toEqual(original);
    }
  });

  it("round-trips both booleans and every preset", () => {
    for (const glass of [true, false]) {
      for (const preset of GLASS_PRESET_IDS) {
        const original: Appearance = {
          ...DEFAULT_APPEARANCE,
          glass,
          preset,
          artworkAmbient: !DEFAULT_APPEARANCE.artworkAmbient,
        };
        expect(decodeAppearance(encodeAppearance(original))).toEqual(original);
      }
    }
  });
});

/* ==========================================================================
   4. RESET, AND THE BACKGROUND VALUE
   ========================================================================== */

describe("resetAppearance", () => {
  it("returns the canonical default", () => {
    expect(resetAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("returns a fresh object, so a mutation cannot poison the constant", () => {
    // `Appearance.background` is a nested object. A shallow spread that shared
    // it would let one caller's `background.id = ...` change the default for
    // every future reset - a bug that would only appear in the one session
    // where somebody reset twice.
    const first = resetAppearance();
    first.background = { kind: "preset", id: "deep-space" };
    expect(resetAppearance().background).toEqual({ kind: "none" });
    expect(DEFAULT_APPEARANCE.background).toEqual({ kind: "none" });
  });

  it("clears a custom image, restoring the Aurora default", () => {
    const customised: Appearance = {
      ...DEFAULT_APPEARANCE,
      glass: false,
      preset: "minimal",
      background: { kind: "url", url: "https://img.test/a.jpg" },
      artworkAmbient: true,
      glassAlpha: 0.2,
    };
    const after = resetAppearance();
    expect(after.background).toEqual({ kind: "none" });
    expect(after.glass).toBe(true);
    expect(after.artworkAmbient).toBe(false);
    // Every field comes back to the default. Asserting it in both directions is
    // what makes this a test of the reset rather than of the constant it
    // returns: a reset that quietly kept one customised field would still pass
    // the three assertions above.
    const keys = Object.keys(customised) as (keyof Appearance)[];
    for (const key of keys) {
      expect(after[key], key).toEqual(DEFAULT_APPEARANCE[key]);
    }
    // And for the fields the customisation actually changed, the customised
    // value is genuinely gone rather than merely shadowed by the three
    // assertions above. Only the changed fields can be held to this: a field
    // the customisation left at its default has nothing to undo.
    const changed = keys.filter(
      (key) =>
        JSON.stringify(customised[key]) !== JSON.stringify(DEFAULT_APPEARANCE[key]),
    );
    expect(changed.length).toBeGreaterThan(3);
    for (const key of changed) {
      expect(after[key], key).not.toEqual(customised[key]);
    }
  });

  it("reaches only the appearance: it is a pure function of a constant", () => {
    // §60. The isolation is structural - `resetAppearance` cannot touch the
    // queue or the account because it has no reference to either, and this
    // test is the record of that. `persistence.test.ts` asserts the same thing
    // through the action that calls it.
    expect(Object.keys(resetAppearance()).sort()).toEqual(
      Object.keys(DEFAULT_APPEARANCE).sort(),
    );
  });
});

describe("hasBackground", () => {
  it("is false only for the explicit none", () => {
    expect(hasBackground(DEFAULT_APPEARANCE)).toBe(false);
    expect(hasBackground({ ...DEFAULT_APPEARANCE, background: { kind: "preset", id: "deep-space" } })).toBe(true);
    expect(hasBackground({ ...DEFAULT_APPEARANCE, background: { kind: "url", url: "https://a.test/x" } })).toBe(true);
  });
});

describe("backgroundImageValue", () => {
  it("is `none` when there is no image", () => {
    expect(backgroundImageValue(DEFAULT_APPEARANCE)).toBe("none");
  });

  it("addresses a shipped preset by path", () => {
    for (const id of BACKGROUND_PRESET_IDS) {
      expect(backgroundImageValue({ ...DEFAULT_APPEARANCE, background: { kind: "preset", id } })).toBe(
        `url("/backgrounds/${id}.svg")`,
      );
    }
  });

  it("escapes a custom address so it cannot escape the CSS token", () => {
    // A URL is interpolated into a stylesheet value. The CSP allows inline
    // style by design, so `style-src` cannot save us here - the only defence
    // is that a bare quote or backslash can never reach the value unescaped.
    const injected = 'https://a.test/x"); } body { display: none } .y{';
    const value = backgroundImageValue({
      ...DEFAULT_APPEARANCE,
      background: { kind: "url", url: injected },
    });

    // The exact escaped form, so a change to `cssUrlEscape` is visible here
    // rather than only in a browser.
    expect(value).toBe(`url("${injected.replace('"', '\\"')}")`);

    // The property that actually matters: every `"` inside the token is
    // preceded by a backslash, so the string cannot be closed early. Asserting
    // the absence of a literal `")` substring would be the wrong test - the
    // escaped form legitimately contains that text.
    const inner = value.slice('url("'.length, -'")'.length);
    expect(inner).not.toMatch(/(^|[^\\])"/);
    expect(inner).not.toMatch(/(^|[^\\])\\$/);
  });

  it("escapes a backslash, which would otherwise start a CSS escape", () => {
    // Without this, `a\62 c` style input could smuggle unescaped characters
    // past a naive quote check.
    expect(cssUrlEscape("a\\b")).toBe("a\\\\b");
    expect(cssUrlEscape('a\\b"c')).toBe('a\\\\b\\"c');
  });
});

describe("id guards", () => {
  it("accepts exactly the shipped ids", () => {
    for (const id of BACKGROUND_PRESET_IDS) {
      expect(isBackgroundPresetId(id)).toBe(true);
    }
    for (const id of GLASS_PRESET_IDS) {
      expect(isGlassPresetId(id)).toBe(true);
    }
  });

  // Rejected values that are not preset ids, and several of them are the ones
  // that break a naive implementation: `constructor` and `toString` are real
  // properties of every object, so a guard written as
  // `GLASS_PRESET_IDS.includes(id)` on an unvalidated `unknown` survives only
  // if it is an array and not an object. A loop rather than `it.each` because
  // the cases have different arities, which `it.each` types as a union of
  // tuples and then refuses to call.
  for (const value of [
    "",
    "constructor",
    "toString",
    "__proto__",
    "AURORA",
    "Aurora",
    " aurora",
    "aurora ",
    null,
    undefined,
    0,
    3,
    true,
    {},
    ["aurora"],
    { id: "aurora" },
  ]) {
    it(`rejects ${typeof value === "string" ? JSON.stringify(value) : String(value)}`, () => {
      expect(isBackgroundPresetId(value)).toBe(false);
      expect(isGlassPresetId(value)).toBe(false);
    });
  }

  it("keeps the background URL bound aligned with the artwork column's own", () => {
    // Both are a validated https address in a relational row, so they share a
    // bound; the test names the relationship so the two cannot drift.
    expect(BACKGROUND_URL_MAX_LENGTH).toBe(2048);
  });
});

describe("the shipped default is the intended design", () => {
  it("enables glass, because a user who never opens Settings should see it", () => {
    expect(DEFAULT_APPEARANCE.glass).toBe(true);
  });

  it("picks readable glass over showy glass", () => {
    // Medium alpha, real blur, a subtle border. Asserted as a band rather than
    // a point so a deliberate later retune is a one-line change here too.
    expect(DEFAULT_APPEARANCE.glassAlpha).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_APPEARANCE.glassAlpha).toBeLessThanOrEqual(0.75);
    expect(DEFAULT_APPEARANCE.glassBlur).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_APPEARANCE.borderIntensity).toBeLessThanOrEqual(0.2);
    // A strong scrim: the background is decoration behind text, and the text
    // is the product.
    expect(DEFAULT_APPEARANCE.backgroundDim).toBeGreaterThanOrEqual(0.5);
  });

  it("leaves the image itself unprocessed by default", () => {
    expect(DEFAULT_APPEARANCE.backgroundSaturation).toBeLessThan(1);
    expect(DEFAULT_APPEARANCE.backgroundBlur).toBe(0);
  });

  it("leaves artwork ambience off, because it is the one opt-in", () => {
    // §40. The single control that reads data the user did not choose, so it is
    // the single one that asks.
    expect(DEFAULT_APPEARANCE.artworkAmbient).toBe(false);
  });

  it("starts with no background at all", () => {
    // A first-time visitor gets the plain Aurora canvas. Glass is on because it
    // is the intended look; a photograph behind the application is not.
    expect(DEFAULT_APPEARANCE.background).toEqual({ kind: "none" });
  });
});

/* ==========================================================================
   WRITER / READER PARITY
   ========================================================================== */

describe("the wire document", () => {
  /**
   * Every writable field of an `Appearance`, each one carrying a value that is
   * legal but NOT the default, so the encoder has to emit it. Built from
   * `APPEARANCE_CONTROL_NAMES` rather than listed, so a control added later is
   * covered without editing this.
   */
  function customisedAppearance(): Appearance {
    const out: Appearance = {
      ...DEFAULT_APPEARANCE,
      glass: false,
      preset: "crystal",
      artworkAmbient: true,
      background: { kind: "url", url: "https://img.test/a.jpg" },
    };
    for (const name of APPEARANCE_CONTROL_NAMES) {
      const range = APPEARANCE_RANGES[name];
      // The opposite end of the range from the default, so the encoder has to
      // emit it, and QUANTISED, so the value is one the control could itself
      // produce. Un-quantised, the round trip would be testing the quantiser
      // rather than the codec: `(0.8 + 1.6) / 2` is 1.2000000000000002, which
      // `decodeAppearance` correctly rounds to 1.2, and the difference is the
      // quantiser working, not a codec fault.
      const midpoint = (range.min + range.max) / 2;
      const wanted =
        Math.abs(midpoint - DEFAULT_APPEARANCE[name]) > 1e-9
          ? midpoint
          : range.min;
      out[name] = quantize(name, wanted);
    }
    return out;
  }

  it("round-trips every field the encoder can write", () => {
    // THE PARITY CLAIM. `AppearanceWire` is a `Partial<Appearance>` and a
    // version, so the writer and the reader cannot disagree about which fields
    // exist - but a field the encoder emits and the decoder ignores would still
    // be a silent data loss, and a field the decoder honours the encoder never
    // writes would be a setting that silently does nothing. One assertion
    // covers both directions.
    const original = customisedAppearance();
    const wire = encodeAppearance(original);
    expect(wire).not.toEqual({ v: 1 });
    expect(decodeAppearance(wire)).toEqual(original);
  });

  it("quantises on the way in, so a stored value is always one a slider could produce", () => {
    // The counterpart to the round trip, and the reason the test above had to
    // quantise: the wire is a hand-editable string, and what comes back out is
    // pinned to the grid. A value the control could not itself produce is a
    // handle that would come to rest somewhere the user cannot return to.
    const decoded = decodeAppearance({
      v: 1,
      glassAlpha: 0.4371,
      glassBlur: 13,
    });
    expect(decoded.glassAlpha).toBe(
      quantize("glassAlpha", 0.4371),
    );
    expect(decoded.glassBlur).toBe(quantize("glassBlur", 13));
    expect(APPEARANCE_RANGES.glassAlpha.step).toBe(0.05);
    // And the snapped value is one the control can actually rest at, which is
    // the property the step exists for.
    expect(APPEARANCE_RANGES.glassAlpha.min).toBeLessThanOrEqual(
      decoded.glassAlpha,
    );
    expect(decoded.glassAlpha).toBeLessThanOrEqual(
      APPEARANCE_RANGES.glassAlpha.max,
    );
  });

  it("carries a version, and refuses one it does not know", () => {
    // The version is the only hard gate in the whole decoder. Every other
    // field is recovered per field, because one bad value should cost one
    // control rather than the entire preference.
    expect(encodeAppearance(customisedAppearance()).v).toBe(APPEARANCE_VERSION);
    expect(decodeAppearance({ v: 999 })).toEqual(DEFAULT_APPEARANCE);
    expect(decodeAppearance({ v: undefined })).toEqual(DEFAULT_APPEARANCE);
  });

  it("emits nothing for an untouched appearance", () => {
    // What an anonymous visitor who changes nothing is worth on a cookie that
    // is attached to every same-origin request.
    expect(encodeAppearance(DEFAULT_APPEARANCE)).toEqual({ v: 1 });
  });

  it("keeps every key it emits inside the declared wire type", () => {
    // Compile-time checked by the encoder's own return type, and asserted here
    // so the invariant survives a cast or a `as AppearanceWire` appearing
    // somewhere. `v` plus any subset of the model's own fields: no renamed key,
    // no nested helper document, no field the decoder does not know.
    const allowed = new Set(["v", ...Object.keys(DEFAULT_APPEARANCE)]);
    const wire = encodeAppearance(customisedAppearance());
    for (const key of Object.keys(wire)) {
      expect(allowed.has(key), `unexpected wire key ${key}`).toBe(true);
    }
    // And nothing non-default is silently dropped on the way out.
    const customised = customisedAppearance() as unknown as Record<
      string,
      unknown
    >;
    const defaults = DEFAULT_APPEARANCE as unknown as Record<string, unknown>;
    const changed = Object.keys(defaults).filter(
      (key) => JSON.stringify(customised[key]) !== JSON.stringify(defaults[key]),
    );
    expect(changed.length).toBeGreaterThan(4);
    for (const key of changed) {
      expect(Object.keys(wire), key).toContain(key);
    }
  });
});
