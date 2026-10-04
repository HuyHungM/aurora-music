/**
 * The Local Music Aurora override — an ambient-only, runtime, non-persisted
 * change of scene.
 *
 * WHY IT EXISTS, and why it is the one case that matters. Music reactivity in
 * Aurora reads the player element's OUTPUT through `captureStream()`, and
 * Chromium refuses that on a cross-origin media element — so every provider
 * stream is unreadable and the feature stands down (recorded in
 * `docs/scope-boundaries.md`). A LOCAL file is served from a blob the app
 * itself created: same-origin, therefore capturable, therefore the one and only
 * situation where the analyser can actually run. Giving local playback its own
 * ambient scene is not a cosmetic extra; it is the only place the existing
 * engine is not silently inert.
 *
 * THREE HARD RULES, and each one is enforced by the shape of this module rather
 * than by discipline at the call sites:
 *
 *   1. IT IS NEVER PERSISTED. Nothing here touches the Appearance store, the
 *      cookie, or a server action. The user stops playing their own music and
 *      their saved appearance is exactly what it was.
 *   2. IT IS AMBIENT-ONLY. It returns ambient-layer values and nothing else —
 *      no glass, no accent, no text, no radius, no layout. The UI the user
 *      chose is untouched while their own music plays.
 *   3. IT IS A PURE FUNCTION OF (saved appearance, playback source, preference).
 *      No clock, no DOM, no React. That is what makes the transitions in the
 *      caller testable and the restoration exact.
 */

import type { Appearance } from "./appearance";

/** What the user chose about local music specifically. */
export const LOCAL_AMBIENT_IDS = ["aurora", "follow", "off"] as const;
export type LocalAmbientId = (typeof LOCAL_AMBIENT_IDS)[number];

export function isLocalAmbientId(value: unknown): value is LocalAmbientId {
  return (
    typeof value === "string" &&
    (LOCAL_AMBIENT_IDS as readonly string[]).includes(value)
  );
}

/**
 * `aurora` is the default, and the reason is the rule above rather than a
 * preference: local playback is the only source the analyser can read, so
 * `follow` would mean "a user who plays their own music sees strictly less than
 * a user who streams someone else's".
 */
export const DEFAULT_LOCAL_AMBIENT: LocalAmbientId = "aurora";

/**
 * The Ambient Light layer this app owns. ONLY these are ever overridden —
 * the list is the mechanism, so a new appearance field cannot be swept into the
 * override by accident.
 *
 * Every field here is a NUMERIC CONTROL, which is a deliberate constraint rather
 * than a coincidence. Numeric controls reach the page as `--p-appearance-*`
 * inline properties on the shell root, so overriding one means writing one
 * property and restoring it means putting the previous inline value back — a
 * mechanism that is exact and needs no bookkeeping of its own.
 *
 * The two ambient ENUMS are therefore absent: `ambientTransition` and
 * `ambientMotion` are not controls at all but shell-root ATTRIBUTES
 * (`data-aurora-artwork-transition` / `-motion`), so overriding them would
 * require a second save/restore path for strings. It would also buy nothing:
 * `smooth` and `subtle` are already the shipped defaults, so the override could
 * only ever change them for a user who had deliberately moved them, which is the
 * one case where respecting their choice is the right answer anyway.
 */
export const LOCAL_AMBIENT_OVERRIDES = {
  /** How brightly the ambient field burns. Up from the default 0.4. */
  auroraIntensity: 0.62,
  /** A deeper field: more reach, so the light has somewhere to come from. */
  ambientSpread: 0.72,
  /** Slower falloff, which is what reads as "deeper" rather than "dimmer". */
  ambientFade: 0.52,
  /** Softer, so a large field does not turn into a hard edge. */
  ambientBlur: 0.55,
  /** More of the light on the viewport edges: cinematic rather than centred. */
  ambientEdgeGlow: 1.25,
} as const satisfies Partial<Appearance>;

export type LocalAmbientOverrides = typeof LOCAL_AMBIENT_OVERRIDES;

/**
 * The ambient scene to render, given what the user saved and what is playing.
 *
 * Returns a PARTIAL appearance — the ambient fields that differ — so the caller
 * can apply them as an override layer rather than as a replacement. Returning a
 * full `Appearance` would be the easier mistake and the wrong one: it would make
 * it possible to write the override into the persisted object, which rule 1
 * forbids.
 *
 * `source` is the track's source id. `"local"` is the only value that triggers
 * this, and it is an explicit field on the track rather than a guess from a
 * filename or a URL scheme.
 *
 * `appearance` is accepted and deliberately NOT read. The scene is Aurora's, not
 * the user's, so it does not vary with what they saved — and that is precisely
 * why the parameter is worth keeping: it is the statement that this decision is
 * made in the context of the saved appearance and must leave it alone, and it
 * gives the caller one call shape that cannot be confused with `update()`.
 */
export function localAmbientOverride(input: {
  appearance: Appearance;
  /** `TrackIdentity.primarySource.source` for the playing track. */
  source: string | null | undefined;
  preference: LocalAmbientId;
}): Partial<Appearance> {
  const { source, preference } = input;
  if (preference === "off") {
    return {};
  }
  if (source !== "local") {
    // `follow` and `aurora` both mean "the user's own ambient settings" for
    // provider playback. Online music must not be restyled by a setting whose
    // entire subject is the listener's own files.
    return {};
  }
  if (preference === "follow") {
    return {};
  }
  return { ...LOCAL_AMBIENT_OVERRIDES };
}

/**
 * Every ambient field the override touches, for the caller to apply and restore.
 *
 * Exported so the apply and restore paths cannot be written against a
 * hand-typed list that drifts from the override. Restoration works by SAVED
 * VALUE rather than by re-deriving the default, which is what makes it exact:
 * the user's own ambient settings come back character for character, including
 * fields the override never touched.
 */
export const LOCAL_AMBIENT_KEYS = Object.keys(
  LOCAL_AMBIENT_OVERRIDES,
) as ReadonlyArray<keyof LocalAmbientOverrides>;
