/**
 * Appearance -> CSS custom properties (Phase 53).
 *
 * The whole rendering story of Glass Mode is eight numbers on one element.
 * Everything visual - translucency, blur, vibrancy, border luminance, ambient
 * glow, scrim strength - resolves from `--p-appearance-*` in `globals.css`, and
 * this module is the only thing that writes them.
 *
 * WHY A STYLE OBJECT AND NOT AN EFFECT. `AppShell` renders these as an inline
 * `style` on the shell root, on the SERVER. That is the reason this feature
 * has no flash of unstyled content: the first HTML response already carries
 * the resolved values, so there is no frame in which the application is
 * painted with defaults and then corrected. It also means there is no
 * hydration hazard - the client renders the same object from the same prop and
 * the markup matches - and no effect that has to run before the first paint.
 * `applyAppearanceStyles` is exported separately for the one case that cannot
 * use that route (§ the artwork palette), where the value is not part of the
 * preference at all.
 *
 * THE TOKEN NAMES ARE THE CONTRACT. `--p-appearance-alpha` here has to be the
 * same name the stylesheet declares, or the interface silently does nothing
 * while every test passes. `__tests__/apply.test.ts` reads `globals.css` and
 * asserts that each name this module writes is declared there, precisely
 * because the two files are the two halves of one definition.
 */

import {
  APPEARANCE_CONTROL_NAMES,
  type Appearance,
  type AppearanceControlName,
} from "./appearance";

/**
 * Control name -> CSS custom property.
 *
 * Total over `AppearanceControlName`, so a control added to
 * `APPEARANCE_RANGES` without a token here is a type error rather than a
 * setting that quietly does nothing.
 */
export const APPEARANCE_TOKENS: Record<AppearanceControlName, string> = {
  glassAlpha: "--p-appearance-alpha",
  glassBlur: "--p-appearance-blur",
  glassSaturation: "--p-appearance-saturation",
  borderIntensity: "--p-appearance-border",
  auroraIntensity: "--p-appearance-aurora",
  backgroundDim: "--p-appearance-dim",
  backgroundSaturation: "--p-appearance-bg-saturation",
  backgroundBlur: "--p-appearance-bg-blur",
};

/** Unit a control's value is written with. Blur is px; the rest are unitless. */
const CONTROL_UNITS: Record<AppearanceControlName, string> = {
  glassAlpha: "",
  glassBlur: "px",
  glassSaturation: "",
  borderIntensity: "",
  auroraIntensity: "",
  backgroundDim: "",
  backgroundSaturation: "",
  backgroundBlur: "px",
};

/** The minimal surface `applyAppearanceStyles` needs. `CSSStyleDeclaration` fits. */
export interface StyleTarget {
  setProperty(property: string, value: string): void;
}

export function appearanceTokenValue(
  appearance: Appearance,
  name: AppearanceControlName,
): string {
  return `${appearance[name]}${CONTROL_UNITS[name]}`;
}

/**
 * Writes all eight control values onto `target`.
 *
 * `import type { CSSProperties } from "react"` is deliberately avoided: this
 * module is imported by tests, by the server and by client components, and a
 * React type would make the non-React callers depend on React for no reason.
 * The returned record is structurally a valid `CSSProperties`, and the cast
 * happens at the one call site that needs it.
 */
export function applyAppearanceStyles(
  target: StyleTarget,
  appearance: Appearance,
): void {
  for (const name of APPEARANCE_CONTROL_NAMES) {
    target.setProperty(
      APPEARANCE_TOKENS[name],
      appearanceTokenValue(appearance, name),
    );
  }
}

/**
 * The eight values as a plain record, for an inline `style` attribute.
 * Returned in `APPEARANCE_CONTROL_NAMES` order so the server-rendered markup
 * is byte-stable for the same preference, which is what keeps hydration from
 * reporting a mismatch.
 */
export function appearanceStyleRecord(
  appearance: Appearance,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of APPEARANCE_CONTROL_NAMES) {
    out[APPEARANCE_TOKENS[name]] = appearanceTokenValue(appearance, name);
  }
  return out;
}

/**
 * The `data-aurora-glass` value. The stylesheet's entire Glass Mode is scoped
 * to this one attribute, which is what makes the OFF state provably identical
 * to the pre-Phase-53 rendering: with `off`, none of the glass rules are in
 * the cascade at all, rather than resolving to values that merely resemble the
 * old ones.
 */
export function glassAttributeValue(appearance: Appearance): "on" | "off" {
  return appearance.glass ? "on" : "off";
}

/**
 * The `data-aurora-background` value.
 *
 * `none` is distinct from the preset names because the background layer has to
 * be able to answer "is there an image at all?" with a single attribute
 * selector, and because the ambient aurora treatment is applied differently
 * for "an image the user chose" than for "no image".
 */
export function backgroundAttributeValue(appearance: Appearance): string {
  switch (appearance.background.kind) {
    case "none":
      return "none";
    case "preset":
      return `preset-${appearance.background.id}`;
    case "url":
      return "url";
  }
}
