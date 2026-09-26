import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_BACKGROUND_COLOR,
  APP_DESCRIPTION_BY_MANIFEST_LOCALE,
  APP_DESCRIPTIONS,
  APP_ID,
  APP_NAME,
  APP_SHORT_NAME,
  APP_THEME_COLOR,
  appDescription,
} from "@/lib/app-metadata";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n/locale";

const rootDir = resolve(process.cwd());

/**
 * oklch -> sRGB, per Björn Ottosson's reference transform. Present so the
 * relationship between the shipped hex theme colour and the design-system
 * token is *verified* rather than asserted in a comment (RULE 22, RULE 48).
 */
function oklchToRgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): { r: number; g: number; b: number } {
  const h = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const encode = (x: number) => {
    const v =
      x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return { r: encode(linear[0]), g: encode(linear[1]), b: encode(linear[2]) };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function designTokens(): string {
  return readFileSync(resolve(rootDir, "src/app/globals.css"), "utf8");
}

describe("canonical app metadata", () => {
  it("is the single source of the product name", () => {
    expect(APP_NAME).toBe("Aurora Music");
    expect(APP_SHORT_NAME).toBe("Aurora");
    // RULE 13: no second brand. The short name is a truncation of the
    // canonical name, not a different product.
    expect(APP_NAME).toContain(APP_SHORT_NAME);
  });

  it("describes the product truthfully in every supported locale", () => {
    // RULE 47: no locale may be left out, and none may carry a generic or
    // unverifiable claim.
    for (const locale of LOCALES) {
      const text = appDescription(locale);
      expect(text.length, `${locale} description is present`).toBeGreaterThan(0);
      expect(APP_DESCRIPTIONS[locale]).toBe(text);
      expect(text).not.toMatch(/best|greatest|number one|#1|no\.1/i);
    }
    expect(APP_DESCRIPTION_BY_MANIFEST_LOCALE).toBe(
      appDescription(DEFAULT_LOCALE),
    );
  });

  it("uses a stable identifier that is not derived from a build", () => {
    // RULE 16: changing this makes browsers treat the same site as a
    // different installed application.
    expect(APP_ID).toBe("/");
    expect(APP_ID).not.toMatch(/[0-9a-f]{8,}/i);
    expect(APP_ID).not.toMatch(/[?#]/);
  });

  it("uses one canvas colour for the theme and the splash", () => {
    expect(APP_THEME_COLOR).toBe(APP_BACKGROUND_COLOR);
  });

  it("stays within rounding distance of the design-system canvas token", () => {
    // RULE 22: browser chrome, the splash screen and the manifest must use
    // the application's own canvas, not an arbitrary dark colour. The
    // manifest cannot carry `oklch()` portably, so a hex equivalent is
    // required — but it has to actually be the token. Phase 51 measured the
    // shipped value against `--p-neutral-0` (`oklch(0.145 0.012 285)`,
    // which resolves to #09090f) and found the hand-written #08070d had
    // drifted by a couple of levels per channel. This pins the relationship
    // so a future palette change fails here instead of drifting again.
    const css = designTokens();
    const token = /--p-neutral-0:\s*oklch\(([^)]+)\)/.exec(css);
    expect(token, "--p-neutral-0 is defined in globals.css").not.toBeNull();
    const [lightness, chroma, hue] = (token as RegExpExecArray)[1]
      .split(/\s+/)
      .map(Number);
    const expected = oklchToRgb(lightness, chroma, hue);
    const actual = hexToRgb(APP_THEME_COLOR);

    for (const channel of ["r", "g", "b"] as const) {
      expect(
        Math.abs(actual[channel] - expected[channel]),
        `channel ${channel} is within rounding of the token`,
      ).toBeLessThanOrEqual(4);
    }
  });
});
