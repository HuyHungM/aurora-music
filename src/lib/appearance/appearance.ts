/**
 * Appearance preference model (Phase 53).
 *
 * THE ONE AUTHORITY for what a user may configure about the way Aurora looks.
 * Three separate things depend on agreeing with it, and each of them is
 * somewhere else in the tree, so this module is deliberately free of React,
 * of the DOM, of the server and of every browser API:
 *
 *   1. `globals.css` owns the canonical DEFAULT of every control. Those
 *      literals are `--p-appearance-*` primitives.
 *   2. The server action validates an incoming write against the ranges
 *      declared here.
 *   3. The settings UI builds its sliders from the same ranges, so a control
 *      can never be rendered with a bound the persistence layer would reject.
 *
 * Which means the ranges below are not documentation. They are the contract,
 * and the two sides are only kept honest because both read this file. If a
 * range changes here and the CSS default does not move with it, the tests in
 * `__tests__/appearance.test.ts` fail.
 *
 * WHY QUANTISED. Every numeric control is stored as an integer STEP INDEX
 * rather than as a float. Three reasons, all of them about honesty rather
 * than than storage:
 *
 *   - The slider, the persisted value and the CSS variable are then the same
 *     number, so a restored preference cannot land between two slider stops
 *     and show a position the user never chose.
 *   - A stored float could be `0.30000000000000004`, and it would be written
 *     to a cookie and a database row forever.
 *   - Decoding is total. Any index inside its range is a legal value, so a
 *     corrupt or hand-edited field resolves to a real value or to the
 *     default, never to a `NaN` that silently blanks the interface.
 *
 * WHY THE WIRE FORMAT OMITS DEFAULTS. A visitor who accepts the shipped
 * preset writes `{"v":1}` — two fields, ~12 bytes. The preference travels in
 * a cookie that is attached to every same-origin request, so the difference
 * between "sending the whole object" and "sending only what differs" is the
 * difference between a permanently heavier request and a permanently
 * lighter one. Omission is also what makes the format forward-compatible:
 * a key that is absent means "the default", so a field added later is
 * readable by an older build and vice versa.
 *
 * This is an APPEARANCE preference. It is deliberately not part of the
 * playback session snapshot (Phase 52): those are two different lifecycles,
 * two different tables, and resetting one must never touch the other.
 */

/* ==========================================================================
   BACKGROUND
   ========================================================================== */

/**
 * The shipped Aurora backgrounds (Phase 53).
 *
 * Hand-authored SVG, one file per preset under `public/backgrounds/`. SVG and
 * not raster, for reasons that are not aesthetic:
 *
 *   - The whole set is a few kilobytes of text. Five 2560x1440 WebP files
 *     would be 1-3 MB, which is a larger download than Aurora's entire
 *     JavaScript bundle, for decoration the user may never scroll to.
 *   - `preserveAspectRatio="xMidYMid slice"` gives a true `cover` fit, so the
 *     same file is correct at 360px portrait and at 2560px ultrawide with no
 *     per-breakpoint asset.
 *   - No binary asset can be reviewed in a diff. A gradient mesh expressed as
 *     text is reviewable, which is the only reason to trust "no copyrighted
 *     third-party artwork" (§62): it is visible in the change.
 *
 * Each is a cold, deep, low-chroma aurora field - never a photograph, never a
 * saturated rainbow.
 */
export const BACKGROUND_PRESET_IDS = [
  "aurora-night",
  "polar-glow",
  "deep-space",
  "northern-light",
  "midnight-bloom",
] as const;

export type BackgroundPresetId = (typeof BACKGROUND_PRESET_IDS)[number];

export function isBackgroundPresetId(
  value: unknown,
): value is BackgroundPresetId {
  return (
    typeof value === "string" &&
    (BACKGROUND_PRESET_IDS as readonly string[]).includes(value)
  );
}

/**
 * Where the background image comes from.
 *
 * `"url"` is a remote image ADDRESS, never an upload. Aurora has no object
 * storage and no upload endpoint, and `docs/scope-boundaries.md` excludes
 * upload-based cover management for exactly that reason; storing a data URL
 * would put a multi-kilobyte binary in a relational row, which §9 rules out.
 * The precedent is `Playlist.artwork`, which is a URL column and nothing
 * else. The URL is validated for real - decoded type, decoded dimensions,
 * decode success - before it is ever accepted, in
 * `./background-image.ts`.
 */
export type BackgroundSelection =
  | { kind: "none" }
  | { kind: "preset"; id: BackgroundPresetId }
  | { kind: "url"; url: string };

/** Matches the artwork URL column's own bound (`PLAYLIST_ARTWORK_MAX_LENGTH`). */
export const BACKGROUND_URL_MAX_LENGTH = 2048;

/** Why a candidate background address was refused, syntactically. */
export type UrlRejection =
  | "empty"
  | "tooLong"
  | "invalidUrl"
  | "insecureScheme"
  | "credentialsInUrl";

export type UrlCheck =
  | { ok: true; url: string; parsed: URL }
  | { ok: false; reason: UrlRejection };

/**
 * The network-free half of background-address validation, and the only part
 * that is safe to run on the server. Deliberately IN THIS MODULE, not in
 * `./background-image.ts`, and for two reasons that point the same way:
 *
 *   1. The decoder needs it. A cookie is attacker-controllable, so the value
 *      that comes back out of `decodeAppearance` is still put through this
 *      before it is rendered. Syntactically legal is the floor, not the
 *      ceiling. Keeping the rule here is what makes that possible without a
 *      dependency cycle between the model and the browser validator.
 *   2. The panel needs it. The same function is the first stage of
 *      `validateBackgroundImage`, so a stored address and a typed address are
 *      judged by one authority rather than two that could disagree about what
 *      https means.
 */
export function checkBackgroundUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string") {
    return { ok: false, reason: "invalidUrl" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (trimmed.length > BACKGROUND_URL_MAX_LENGTH) {
    return { ok: false, reason: "tooLong" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalidUrl" };
  }
  // HTTPS only. A background loaded over plaintext is a substitution waiting to
  // happen, and `img-src` in the CSP permits `http:` for provider artwork, so
  // this rule is not inherited from there - it has to be stated here.
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "insecureScheme" };
  }
  // Credentials in a URL are both a phishing surface and a way to make an
  // address look like it points somewhere it does not.
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentialsInUrl" };
  }
  return { ok: true, url: trimmed, parsed };
}

/* ==========================================================================
   RANGES
   ========================================================================== */

/**
 * The tunable surface. Every control, its legal range and its step, declared
 * once. The settings UI generates its inputs from this; the server action
 * validates against it; the CSS default mirrors it.
 *
 * The bounds are chosen for measured reasons, not taste:
 *
 *   - `alpha` stops at 0.85 because a glass surface that is fully opaque is
 *     not glass, and stops at 0.05 because below roughly there the aurora
 *     canvas behind it stops being legible as a surface at all.
 *   - `blur` stops at 28px. A `backdrop-filter` radius is not free: cost
 *     grows with both the radius and the AREA it is applied to, and these
 *     surfaces are viewport-sized. Past ~28px the extra radius is not
 *     perceptible through a dark scrim but is very perceptible in a frame
 *     time, which is the definition of spending frames for nothing.
 *   - `saturation` is bounded below at 0.8, not at 1. A value under 1 is a
 *     real and useful control - it is how a busy photograph stops competing
 *     with the text - so it is allowed. The floor is 0.8 rather than 0 because
 *     below that the effect stops reading as "calmed down" and starts reading
 *     as "the image is broken", and 1.6 at the top because beyond that a photo
 *     looks processed rather than lit.
 *
 * EVERY DEFAULT AND EVERY PRESET VALUE BELOW IS ON ITS OWN GRID. This is not
 * tidiness: `quantize` is applied to every stored value, so a default that sits
 * between two steps would be changed the first time it was decoded, and the
 * shipped theme would not be the theme the stylesheet declares. The step is
 * coarse (0.05) for exactly that reason - a 0.05 step is a slider with real
 * detents, and it forces the design values onto a grid a person can land on.
 */
export interface AppearanceControl {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const APPEARANCE_RANGES = {
  /** Glass surface opacity. Lower shows more background. */
  glassAlpha: { min: 0.05, max: 0.85, step: 0.05 },
  /** Backdrop blur radius, px. */
  glassBlur: { min: 0, max: 28, step: 2 },
  /** Backdrop vibrancy multiplier. */
  glassSaturation: { min: 0.8, max: 1.6, step: 0.05 },
  /** Border intensity, 0-1. The CSS derives an alpha from it. */
  borderIntensity: { min: 0, max: 1, step: 0.05 },
  /** Ambient aurora glow, 0-1. */
  auroraIntensity: { min: 0, max: 1, step: 0.05 },
  /** Scrim strength over the background image, 0-0.9. */
  backgroundDim: { min: 0, max: 0.9, step: 0.05 },
  /** Background image saturation multiplier. */
  backgroundSaturation: { min: 0, max: 1.5, step: 0.05 },
  /** Background image blur radius, px. Off by default; see the note in `apply.ts`. */
  backgroundBlur: { min: 0, max: 24, step: 2 },
} as const satisfies Record<string, AppearanceControl>;

export type AppearanceControlName = keyof typeof APPEARANCE_RANGES;

export const APPEARANCE_CONTROL_NAMES = Object.keys(
  APPEARANCE_RANGES,
) as AppearanceControlName[];

/**
 * Glass intensity presets (Phase 53, §46).
 *
 * Four, not fifteen sliders. A user who has to tune eight parameters before
 * the design looks good will conclude the feature is broken, so the shipped
 * states have to be good; the individual controls exist, but behind a
 * disclosure, for the person who wants them.
 *
 * "Minimal" is also the performance escape hatch (§45). It sets blur to
 * zero, which removes every `backdrop-filter` in the application in one
 * choice - the only honest way to offer a low-cost mode without inspecting
 * the hardware, which `docs/scope-boundaries.md` excludes as device
 * fingerprinting.
 */
export const GLASS_PRESET_IDS = [
  "aurora",
  "balanced",
  "crystal",
  "minimal",
] as const;

export type GlassPresetId = (typeof GLASS_PRESET_IDS)[number];

export function isGlassPresetId(value: unknown): value is GlassPresetId {
  return (
    typeof value === "string" &&
    (GLASS_PRESET_IDS as readonly string[]).includes(value)
  );
}

/**
 * The shipped glass looks. Only the five controls a preset actually owns are
 * listed; anything absent is left as the user had it, so choosing a preset is
 * never a silent reset of the background or of the aurora glow.
 *
 * THE FOUR ARE ORDERED ALONG ONE AXIS - how much of the aurora shows through -
 * and every value is on its own control's grid. Crystal is the most glass and
 * the most expensive; Minimal is the flattest, unblurred, and the cheapest;
 * Balanced sits between them as the everyday choice. Two details worth reading
 * off the table rather than assuming:
 *
 *   - MINIMAL IS MORE OPAQUE THAN BALANCED, despite being "less glass". It has
 *     no blur to fall back on, so the only thing keeping a photograph legible
 *     behind it is the fill - which means the scrim has to work harder too
 *     (0.65 against 0.55). Reading the table as "higher number = more glass"
 *     gets this one backwards.
 *   - THE BORDER LADDER RISES WITH GLASSINESS. More glass means a wider area of
 *     low-contrast fill, and the edge is what keeps that area from bleeding
 *     into its surroundings, so Crystal has the most luminous edge and Minimal
 *     the least.
 */
export const GLASS_PRESETS: Record<
  GlassPresetId,
  Partial<Record<AppearanceControlName, number>>
> = {
  /** The default. Deep, cinematic, readable over any image. */
  aurora: {
    glassAlpha: 0.6,
    glassBlur: 18,
    glassSaturation: 1.1,
    borderIntensity: 0.15,
    auroraIntensity: 0.4,
    backgroundDim: 0.6,
  },
  /** Less opaque and less blurred than Aurora; the everyday choice. */
  balanced: {
    glassAlpha: 0.5,
    glassBlur: 14,
    glassSaturation: 1.05,
    borderIntensity: 0.1,
    auroraIntensity: 0.3,
    backgroundDim: 0.55,
  },
  /**
   * The most glass: most transparent, most blurred, most luminous border.
   * Also the most expensive, by a wide margin. Deliberately not the default.
   */
  crystal: {
    glassAlpha: 0.3,
    glassBlur: 24,
    glassSaturation: 1.2,
    borderIntensity: 0.2,
    auroraIntensity: 0.45,
    backgroundDim: 0.45,
  },
  /** Flat, unblurred, hairline borders. The cheapest possible glass. */
  minimal: {
    glassAlpha: 0.55,
    glassBlur: 0,
    glassSaturation: 1,
    borderIntensity: 0.05,
    auroraIntensity: 0.2,
    backgroundDim: 0.65,
  },
};

/* ==========================================================================
   THE PREFERENCE
   ========================================================================== */

/**
 * The resolved preference. Always complete: every field is present, in
 * range, and quantised. A partial, unvalidated version of this never exists
 * outside the two functions below it.
 */
export interface Appearance {
  /** Glass Mode. Off renders byte-for-byte the pre-Phase-53 surfaces. */
  glass: boolean;
  /** Which shipped look the glass controls were last set from. */
  preset: GlassPresetId;
  background: BackgroundSelection;
  /**
   * Whether the current track's artwork tints the ambient layer (§40).
   * Off by default: it is the one control that reads data the user did not
   * choose, so it is opt-in.
   */
  artworkAmbient: boolean;
  glassAlpha: number;
  glassBlur: number;
  glassSaturation: number;
  borderIntensity: number;
  auroraIntensity: number;
  backgroundDim: number;
  backgroundSaturation: number;
  backgroundBlur: number;
}

/**
 * The canonical default, and the value every missing field resolves to.
 *
 * Glass Mode ships ON because the default has to be the good-looking one
 * (§24): a user who never opens Settings should see the intended design, and
 * a user who wants the old flat surfaces has one toggle.
 *
 * Every number here MUST equal the matching `--p-appearance-*` primitive in
 * `globals.css` AND must be a fixed point of `quantize` - that is, already on
 * its own control's grid. Both are asserted by `__tests__/appearance.test.ts`
 * reading the stylesheet and calling `quantize`, because two hand-maintained
 * copies of the same default is how the "single source of truth" rule gets
 * quietly broken, and a default that is not on the grid is worse: it renders as
 * something nobody chose, the first time it is decoded.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  glass: true,
  preset: "aurora",
  background: { kind: "none" },
  artworkAmbient: false,
  glassAlpha: 0.6,
  glassBlur: 18,
  glassSaturation: 1.1,
  borderIntensity: 0.15,
  auroraIntensity: 0.4,
  backgroundDim: 0.6,
  backgroundSaturation: 0.85,
  backgroundBlur: 0,
};

/* ==========================================================================
   QUANTISATION
   ========================================================================== */

/**
 * Snaps an arbitrary number to the nearest legal step and clamps it into
 * range. Total: every input, including `NaN`, `Infinity`, `-0` and a
 * string-shaped number, produces a legal value.
 *
 * Clamping rather than rejecting is deliberate for the numeric controls. A
 * preference is a taste, not a transaction: a value that is merely out of
 * range is corrected to the nearest thing the design system can actually
 * render, because a control stuck on "invalid" helps nobody. The discriminated
 * fields (preset id, background kind) are different - an unknown value there
 * is a different thing, not a different amount, so those fall back to the
 * default instead.
 */
export function quantize(name: AppearanceControlName, value: unknown): number {
  const range = APPEARANCE_RANGES[name];
  const numeric = toNumber(value);
  if (numeric === null) {
    return DEFAULT_APPEARANCE[name];
  }
  const clamped = Math.min(range.max, Math.max(range.min, numeric));
  // `toFixed` on the step's own decimal count is what keeps 0.30000000000004
  // out of the CSS; the arithmetic itself is then exact at that precision.
  const decimals = decimalPlaces(range.step);
  const snapped =
    Math.round((clamped - range.min) / range.step) * range.step + range.min;
  return Number(snapped.toFixed(decimals));
}

/**
 * Reads an untrusted value as a number, or reports that there isn't one.
 *
 * THE POINT IS WHAT IS *NOT* A NUMBER. `Number(null)`, `Number("")`,
 * `Number(false)` and `Number([])` are all `0`, and a plain
 * `Number(value)` coercion would therefore read a JSONB row with
 * `{"glassAlpha": null}` as "glass as transparent as the design allows" - the
 * one value a user would describe as the surface having broken. Absence has to
 * mean the default, and only a value that genuinely carries a magnitude is
 * allowed to become one.
 *
 * A numeric string IS honoured, because a JSON round trip can hand one back and
 * it still carries the user's intent.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function decimalPlaces(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Every value of `range`, in order. The settings sliders are built from this. */
export function controlSteps(name: AppearanceControlName): number[] {
  const range = APPEARANCE_RANGES[name];
  const decimals = decimalPlaces(range.step);
  const out: number[] = [];
  const count = Math.round((range.max - range.min) / range.step);
  for (let i = 0; i <= count; i += 1) {
    out.push(Number((range.min + i * range.step).toFixed(decimals)));
  }
  return out;
}

/* ==========================================================================
   THE WIRE FORMAT
   ========================================================================== */

/** Bumped only on an incompatible change; unknown versions are discarded. */
export const APPEARANCE_VERSION = 1;

/**
 * The document that travels: a cookie value, a database column, a server
 * action's argument.
 *
 * WRITTEN AS A PARTIAL OF THE MODEL, and that is the whole design. Every
 * writable field of an `Appearance` is a field of the wire document, so the two
 * cannot drift, and the version travels beside them.
 *
 * It is deliberately a TYPE and not a runtime schema. An earlier revision
 * declared a `zod` object here and nothing ever parsed with it - `decodeAppearance`
 * is per-field by design, because all-or-nothing parsing is the wrong failure
 * mode for a preference - and a validator nobody calls is a validator that will
 * drift out of date and then be trusted. Worse, `zod` is a large dependency, and
 * importing it here put the whole library into the client bundle for a
 * declaration the client never evaluates. The type costs nothing at runtime, is
 * checked by the compiler at every call site, and the parity between what is
 * written and what is read is asserted by the round-trip tests instead.
 */
export type AppearanceWire = { v?: number } & Partial<Appearance>;

/**
 * Coerces any untrusted input into a complete, legal `Appearance`.
 *
 * NEVER THROWS. A preference is not worth taking the application down for: a
 * corrupt cookie must render the default theme, not an error boundary, and the
 * same is true of a database value written by a build that no longer exists.
 *
 * VALIDATED FIELD BY FIELD, not as one object, and the difference is the whole
 * design. An all-or-nothing parse means a single unrecognised key discards
 * every setting the user has - so merely ADDING a preference in a later build
 * would wipe the settings of anyone who then ran an earlier one, and
 * `encodeAppearance`'s promise of forward compatibility would be false in the
 * one direction that costs a person their configuration. Per-field validation
 * means every value that is still understood survives regardless of what else
 * is in the object:
 *
 *   - an unknown key is dropped, and everything else is kept;
 *   - a `glassAlpha` that is not a number reverts THAT control, and a preset
 *     chosen alongside it still applies;
 *   - a background of an unknown `kind` reverts the background and leaves the
 *     glass exactly where the user had it.
 *
 * The one hard gate is the version. An unrecognised `v` means the encoding
 * itself may have changed meaning, so the whole value is discarded rather than
 * repaired field by field - guessing at the semantics of a format this build
 * does not know is how a preference becomes a WRONG one rather than a missing
 * one.
 *
 * Note what is NOT here: no URL revalidation. `decodeAppearance` is a pure
 * shape coercion and is the function the server action runs; whether the
 * address is a decodable image is decided in the browser by
 * `background-image.ts`, which is the only place that can actually find out.
 */
export function decodeAppearance(input: unknown): Appearance {
  const record = asRecord(input);
  if (!record) {
    return defaultAppearance();
  }
  // `undefined` means "no version", which is the same as the current one: a
  // caller storing a bare object is a caller with nothing else to say.
  if (record.v !== undefined && record.v !== APPEARANCE_VERSION) {
    return defaultAppearance();
  }
  return {
    glass: readBoolean(record.glass) ?? DEFAULT_APPEARANCE.glass,
    preset: isGlassPresetId(record.preset)
      ? record.preset
      : DEFAULT_APPEARANCE.preset,
    background: readBackground(record.background),
    artworkAmbient:
      readBoolean(record.artworkAmbient) ?? DEFAULT_APPEARANCE.artworkAmbient,
    glassAlpha: quantize("glassAlpha", record.glassAlpha),
    glassBlur: quantize("glassBlur", record.glassBlur),
    glassSaturation: quantize("glassSaturation", record.glassSaturation),
    borderIntensity: quantize("borderIntensity", record.borderIntensity),
    auroraIntensity: quantize("auroraIntensity", record.auroraIntensity),
    backgroundDim: quantize("backgroundDim", record.backgroundDim),
    backgroundSaturation: quantize(
      "backgroundSaturation",
      record.backgroundSaturation,
    ),
    backgroundBlur: quantize("backgroundBlur", record.backgroundBlur),
  };
}

/** A fresh default, with a fresh nested `background`, every single time. */
function defaultAppearance(): Appearance {
  return {
    ...DEFAULT_APPEARANCE,
    background: { ...DEFAULT_APPEARANCE.background },
  };
}

/** A plain object, or null. `null` and arrays are objects in JavaScript. */
function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

/** Only a real boolean is a preference; everything else is absence. */
function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Validated as a whole, because its three kinds are genuinely different things.
 *
 * AND THE URL IS REALLY RE-CHECKED, not merely measured. This runs on
 * attacker-controllable input - a cookie is a string anybody can set - so a
 * structural check alone would let a hand-written `http://` address into a
 * value that is later painted. `checkBackgroundUrl` is the same function the
 * settings form uses, so the two paths cannot disagree about what a legal
 * background address is.
 *
 * The fallback is the default rather than `{ kind: "none" }`: a broken stored
 * background should leave the rest of the appearance alone, not reset it.
 */
function readBackground(value: unknown): BackgroundSelection {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_APPEARANCE.background };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "none") {
    return { kind: "none" };
  }
  if (candidate.kind === "preset" && isBackgroundPresetId(candidate.id)) {
    return { kind: "preset", id: candidate.id };
  }
  if (candidate.kind === "url") {
    const checked = checkBackgroundUrl(candidate.url);
    if (checked.ok) {
      return { kind: "url", url: checked.url };
    }
  }
  return { ...DEFAULT_APPEARANCE.background };
}

/**
 * The inverse: a complete `Appearance` reduced to only the fields that differ
 * from the default, plus the version.
 *
 * Symmetric with `decodeAppearance` - `decodeAppearance(encodeAppearance(a))`
 * is `a` for every legal `a`, and the tests assert exactly that.
 */
export function encodeAppearance(appearance: Appearance): AppearanceWire {
  const wire: AppearanceWire = { v: APPEARANCE_VERSION };
  if (appearance.glass !== DEFAULT_APPEARANCE.glass) {
    wire.glass = appearance.glass;
  }
  if (appearance.preset !== DEFAULT_APPEARANCE.preset) {
    wire.preset = appearance.preset;
  }
  if (!isSameBackground(appearance.background, DEFAULT_APPEARANCE.background)) {
    wire.background = { ...appearance.background };
  }
  if (appearance.artworkAmbient !== DEFAULT_APPEARANCE.artworkAmbient) {
    wire.artworkAmbient = appearance.artworkAmbient;
  }
  for (const name of APPEARANCE_CONTROL_NAMES) {
    if (appearance[name] !== DEFAULT_APPEARANCE[name]) {
      wire[name] = appearance[name];
    }
  }
  return wire;
}

function isSameBackground(a: BackgroundSelection, b: BackgroundSelection): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "none" || b.kind === "none") {
    return true;
  }
  if (a.kind === "preset" && b.kind === "preset") {
    return a.id === b.id;
  }
  if (a.kind === "url" && b.kind === "url") {
    return a.url === b.url;
  }
  return false;
}

/** Whether a background image will be painted at all. */
export function hasBackground(appearance: Appearance): boolean {
  return appearance.background.kind !== "none";
}

/**
 * Applies a preset, returning a NEW object. Controls the preset does not own
 * are carried through untouched, so "Crystal" changes the glass and leaves
 * the user's background image and their dimming exactly where they were.
 */
export function applyPreset(
  appearance: Appearance,
  preset: GlassPresetId,
): Appearance {
  const values = GLASS_PRESETS[preset];
  const next: Appearance = { ...appearance, preset };
  for (const [name, value] of Object.entries(values)) {
    const key = name as AppearanceControlName;
    next[key] = quantize(key, value);
  }
  return next;
}

/**
 * The reset. Appearance only, and the word matters: this does not touch the
 * queue, playback, likes, playlists, the account, or the background's
 * presence beyond returning it to "none" (§60).
 */
export function resetAppearance(): Appearance {
  return {
    ...DEFAULT_APPEARANCE,
    background: { ...DEFAULT_APPEARANCE.background },
  };
}

/** The CSS `background-image` value for the current selection, or `none`. */
export function backgroundImageValue(appearance: Appearance): string {
  switch (appearance.background.kind) {
    case "none":
      return "none";
    case "preset":
      return `url("/backgrounds/${appearance.background.id}.svg")`;
    case "url":
      return `url("${cssUrlEscape(appearance.background.url)}")`;
  }
}

/**
 * Escapes a URL for a CSS `url("...")` token.
 *
 * Only the characters that would END the string or start an escape are
 * handled, which is the entire attack surface here: a URL is going to be
 * interpolated into a stylesheet value, so a bare `"` or a bare `\` would let
 * a value escape the token and inject arbitrary CSS. The CSP
 * (`style-src 'self' 'unsafe-inline'`) cannot help with that, because inline
 * style is allowed by design.
 */
export function cssUrlEscape(value: string): string {
  return value.replace(/[\\"]/g, (character) => `\\${character}`);
}
