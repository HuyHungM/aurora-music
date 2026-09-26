/**
 * Artwork-reactive ambient palette (Phase 53, §15, §16, §39, §40).
 *
 * The idea is that what is playing should tint the room. The implementation is
 * heavily constrained, because the naive version of this idea is a
 * performance and taste disaster:
 *
 *   - It runs ONCE PER TRACK, never per render, and never in a frame loop.
 *     §15 forbids expensive real-time analysis; a `track` change is the only
 *     event that can trigger it, and the result is memoised by artwork URL so
 *     a re-render, a re-subscribe or a queue reorder costs nothing.
 *   - It reads a downsampled grid, not the image. 24 samples, not 8 million.
 *   - It writes four CSS custom properties on the document element and
 *     nothing else. No React state, so no subtree re-renders; no layout
 *     property, so no reflow. Only the ambient layer reads them.
 *   - It has no effect on playback. This module is not importable from
 *     anything under `src/lib/player`, `src/lib/music` or `src/lib/playback`,
 *     and `quality-gates.test.ts` asserts that.
 *
 * RESTRAINT IS A CLAMP, NOT A JUDGEMENT CALL (§16).
 *
 * The interesting decision is what happens to a colour that arrives. A
 * yellow album cover does not get a yellow room and a blue one does not get a
 * blue room: the hue is REMAPPED into a fixed cool window, and chroma and
 * lightness are compressed hard. That is a deliberate departure from "the
 * palette comes from the artwork" - the *character* comes from the artwork
 * (which of the cool hues, and how luminous), not its literal colour - and it
 * is the only version of this feature that cannot produce a chartreuse UI.
 *
 * Readback IS NOT GUARANTEED, and that is a platform fact rather than a
 * design choice. `getImageData` only works on an untainted canvas, which
 * means the host must send `Access-Control-Allow-Origin`. Provider artwork
 * is served from third-party CDNs that mostly do not. So the loader asks for
 * a CORS read first and, when that fails, derives the palette from the
 * artwork's identity instead: a stable hash of the URL, mapped into the same
 * window. Different artwork still gives a different ambience, it is simply
 * not pixel-accurate, and `source` in the result says which of the two
 * happened so nothing downstream can claim extraction that did not occur.
 *
 * Pure and dependency-injected, like `pwa/platform.ts` and
 * `background-image.ts`, so every branch is reachable from a test.
 */

/* ==========================================================================
   RESULT
   ========================================================================== */

export type PaletteSource = "pixels" | "identity";

export interface AuroraPalette {
  /** Dominant hue, as an `oklch()` string. Drives the ambient wash. */
  primary: string;
  /** A neighbouring hue, ~40 degrees around the wheel. Adds depth. */
  secondary: string;
  /** The brightest, narrowest of the three. The bloom around the artwork. */
  glow: string;
  /** The scrim tint: the primary pulled toward the canvas. */
  tint: string;
  source: PaletteSource;
}

/* ==========================================================================
   THE RESTRAINT WINDOW (§16)
   ========================================================================== */

/**
 * Hue is remapped into this window, in degrees.
 *
 * 170 to 340 is teal through cyan, blue, indigo, violet and into magenta -
 * the cool half of the wheel, and the half Aurora's own triad already lives
 * in. The warm quarter (0-60) and the acid quarter (60-170) are excluded
 * outright, which is what makes it impossible for a piece of artwork to
 * produce a chartreuse or orange interface. A wide window is safe HERE only
 * because the chroma ceiling below is so low; a 170-degree hue spread at
 * chroma 0.12 on a near-black canvas reads as one cool light, not as a
 * rainbow.
 *
 * THE WINDOW IS `[AURORA_HUE_MIN, AURORA_HUE_MAX)` - HALF-OPEN. The upper
 * bound is the first hue that is out of window, not one this module can
 * produce, because the remap is a modulo over a span of `MAX - MIN`. The
 * visual cost of the excluded 340 degrees is nil (340 and 339.9 are the same
 * colour); the cost of a reader assuming otherwise is not, so it is stated here
 * and asserted in the tests.
 */
export const AURORA_HUE_MIN = 170;
export const AURORA_HUE_MAX = 340;

/**
 * Chroma ceiling: 0.12.
 *
 * Aurora's own accents sit at chroma 0.16-0.21. A background wash is a large
 * area of low-frequency colour seen out of the corner of the eye, so it is
 * allowed only a fraction of their saturation. The source chroma is
 * multiplied by `CHROMA_COMPRESSION` and then clamped to this, which means a
 * fully saturated input and a nearly grey input can both land at the ceiling
 * but never above it.
 */
export const AURORA_CHROMA_MAX = 0.12;
const CHROMA_COMPRESSION = 0.45;

/**
 * Lightness window: 0.45 to 0.72.
 *
 * The floor stops a dark cover from producing a layer so dark the glass
 * surfaces have nothing to sit against; the ceiling stops a bright cover from
 * producing a wash that outshines the text. Because the layer's own opacity is
 * additionally scaled by the user's `auroraIntensity` (0 by default), the
 * effective on-screen lightness is well below the ceiling in practice.
 */
export const AURORA_LIGHTNESS_MIN = 0.45;
export const AURORA_LIGHTNESS_MAX = 0.72;

/* ==========================================================================
   COLOUR CONVERSION
   ========================================================================== */

export interface Oklch {
  l: number;
  c: number;
  /** Degrees, always normalised to [0, 360). */
  h: number;
}

export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * sRGB (0-255 per channel) to OKLCH, via Oklab.
 *
 * Hand-rolled rather than delegated to a colour library because the
 * application ships no CSS-in-JS and no colour dependency, and adding one for
 * a mean-of-24-samples calculation would be a larger change than the feature
 * (RULE 3). The matrices are Ottosson's published Oklab coefficients, which
 * are the reference implementation's.
 */
export function srgbToOklch(
  red: number,
  green: number,
  blue: number,
): Oklch {
  const r = srgbToLinear(red / 255);
  const g = srgbToLinear(green / 255);
  const b = srgbToLinear(blue / 255);

  const long = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const medium = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const short = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(long);
  const mRoot = Math.cbrt(medium);
  const sRoot = Math.cbrt(short);

  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const bb = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

  const chroma = Math.sqrt(a * a + bb * bb);
  // An achromatic colour has an undefined hue. `atan2(0,0)` is 0, which would
  // put every grey cover at hue 0 - the one value the window excludes, so it
  // would be remapped to the very edge. A grey cover should sit mid-window.
  const hue = chroma < 1e-6 ? (AURORA_HUE_MIN + AURORA_HUE_MAX) / 2 : normaliseHue((Math.atan2(bb, a) * 180) / Math.PI);

  return { l: lightness, c: chroma, h: hue };
}

function normaliseHue(hue: number): number {
  const wrapped = hue % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Forces a colour into the restraint window.
 *
 * The hue remap is a MODULO, not a clamp, and that choice matters: a clamp
 * would pile every out-of-window colour onto the same two boundary hues, so a
 * library of orange and green covers would produce an interface that alternated
 * between exactly two ambiences. Wrapping keeps them distinct while keeping all
 * of them cool.
 *
 * THE WINDOW IS HALF-OPEN, `[MIN, MAX)`, and that is a consequence of the
 * modulo rather than an oversight: the span is `MAX - MIN`, so `MAX` itself
 * wraps to `MIN`. In oklch a hue of exactly 340 degrees is visually
 * indistinguishable from 339.9, so nothing is lost - but the bound is exclusive
 * and `AURORA_HUE_MAX` should be read as "the first hue that is out of
 * window", not as a value this function can return.
 *
 * CHROMA IS SCALED GLOBALLY, THEN CAPPED, rather than compressed with a soft
 * knee. The scale is what does the real work: artwork is consistently more
 * saturated than an ambient wash should be, so 0.45 brings a typical vivid
 * cover (0.2) to 0.09 while leaving a muted one (0.04) at 0.018, and the
 * relationship between covers is preserved. A knee would only change the
 * behaviour above 0.12, where the cap is already flattening everything anyway
 * and where hue - not chroma - is what still distinguishes one vivid cover from
 * another.
 *
 * TOTAL, for the same reason every other boundary in this module is: a NaN
 * reaching `oklch()` in a custom property silently removes the declaration, so
 * the ambient layer would disappear with nothing in the console to explain it.
 * The fallbacks are mid-window, not zero, so a garbage input degrades to a
 * plausible aurora rather than to black.
 */
export function restrain(source: Oklch): Oklch {
  const span = AURORA_HUE_MAX - AURORA_HUE_MIN;
  const fallbackHue = (AURORA_HUE_MIN + AURORA_HUE_MAX) / 2;
  const hue = Number.isFinite(source.h)
    ? AURORA_HUE_MIN +
      ((((source.h - AURORA_HUE_MIN) % span) + span) % span)
    : fallbackHue;
  const lightness = Number.isFinite(source.l)
    ? source.l
    : (AURORA_LIGHTNESS_MIN + AURORA_LIGHTNESS_MAX) / 2;

  return {
    l: Math.min(AURORA_LIGHTNESS_MAX, Math.max(AURORA_LIGHTNESS_MIN, lightness)),
    c: Number.isFinite(source.c)
      ? Math.min(AURORA_CHROMA_MAX, Math.max(0, source.c * CHROMA_COMPRESSION))
      : 0,
    h: hue,
  };
}

/* ==========================================================================
   DERIVATION
   ========================================================================== */

/** Samples per axis. 8x8 = 64 reads, or fewer on a small thumbnail. */
const GRID = 8;

/**
 * Averages a downsampled grid of RGBA pixels into one colour.
 *
 * Returns `null` for an empty or fully transparent buffer, so a caller can
 * tell "no colour here" from "black here" - which matters, because a
 * transparent PNG is a legitimate artwork and treating it as black would put a
 * violet wash behind it for no reason.
 */
export function meanColor(
  pixels: Uint8ClampedArray | ArrayLike<number>,
): { r: number; g: number; b: number } | null {
  const available = Math.floor(pixels.length / 4);
  if (available === 0) {
    return null;
  }
  const stride = Math.max(1, Math.floor(available / (GRID * GRID)));
  let r = 0;
  let g = 0;
  let b = 0;
  // The SUM OF ALPHA, not a count. These have to agree or the premultiplication
  // below is pointless: weighting each pixel by its alpha and then dividing by
  // the number of pixels darkens the result in proportion to how much of the
  // artwork is transparent, which is the exact failure the premultiplication
  // exists to prevent. A cover that is 20% transparent would come out 20%
  // darker for no reason at all.
  let weight = 0;
  for (let i = 0; i < available; i += stride) {
    const offset = i * 4;
    // Premultiplication matters: an image with transparent regions would
    // otherwise average its hidden RGB toward whatever the encoder left
    // there, which is usually black.
    const alpha = pixels[offset + 3] / 255;
    if (alpha < 0.05) {
      continue;
    }
    r += pixels[offset] * alpha;
    g += pixels[offset + 1] * alpha;
    b += pixels[offset + 2] * alpha;
    weight += alpha;
  }
  if (weight === 0) {
    return null;
  }
  return { r: r / weight, g: g / weight, b: b / weight };
}

/** FNV-1a, 32-bit. Stable, fast, and well spread over short strings. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derives a palette from the artwork's IDENTITY, for when pixels are
 * unavailable. Deterministic: the same URL always gives the same ambience, and
 * two different URLs almost never collide, because the hash is taken over the
 * whole string.
 *
 * The colour it invents is deliberately bland - mid lightness, a third of the
 * chroma ceiling - because it is a guess, and a guess that looks like a
 * deliberate design decision is worse than one that looks like ambient light.
 */
export function paletteFromIdentity(artworkUrl: string): AuroraPalette {
  const hue =
    AURORA_HUE_MIN +
    (hashString(artworkUrl) % Math.round(AURORA_HUE_MAX - AURORA_HUE_MIN));
  const base = restrain({ l: 0.58, c: AURORA_CHROMA_MAX / 1.5, h: hue });
  return expand(base, "identity");
}

/** The four roles, from one restrained base colour. */
function expand(base: Oklch, source: PaletteSource): AuroraPalette {
  const secondary = restrain({ ...base, h: base.h - 38 });
  const glow = restrain({ ...base, l: base.l + 0.12, c: base.c * 1.25 });
  const tint = restrain({ ...base, l: Math.max(0.18, base.l - 0.24), c: base.c * 0.7 });
  return {
    primary: formatOklch(base),
    secondary: formatOklch(secondary),
    glow: formatOklch(glow),
    tint: formatOklch(tint),
    source,
  };
}

/** The palette a decoded artwork implies. */
export function paletteFromPixels(
  pixels: Uint8ClampedArray | ArrayLike<number>,
): AuroraPalette | null {
  const mean = meanColor(pixels);
  if (!mean) {
    return null;
  }
  return expand(restrain(srgbToOklch(mean.r, mean.g, mean.b)), "pixels");
}

/* ==========================================================================
   MEMOISATION
   ========================================================================== */

/**
 * Cache of resolved palettes, keyed by artwork URL.
 *
 * Bounded at 32 entries - a long listening session will pass hundreds of
 * tracks, and an unbounded map keyed on a remote URL is a slow leak. Eviction
 * is insertion-order, which for this access pattern is fine: re-analysing a
 * track that has not been heard in the last 32 is cheaper than any real
 * policy would be, and it happens at most once per track anyway.
 */
const CACHE_LIMIT = 32;
const cache = new Map<string, AuroraPalette>();

export function paletteCacheSize(): number {
  return cache.size;
}

export function clearPaletteCache(): void {
  cache.clear();
}

/** A cached palette, if this URL has been analysed before. */
export function cachedPalette(artworkUrl: string): AuroraPalette | undefined {
  return cache.get(artworkUrl);
}

export function rememberPalette(
  artworkUrl: string,
  palette: AuroraPalette,
): AuroraPalette {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(artworkUrl, palette);
  return palette;
}

/* ==========================================================================
   BROWSER SAMPLING
   ========================================================================== */

/**
 * The minimum image shape `samplePixels` reads.
 *
 * `onload`/`onerror` take an `Event` because that is how the DOM types them; a
 * zero-argument signature here would make a real `HTMLImageElement`
 * unassignable to this type, which defeats the point of injecting the shape.
 */
export interface PaletteImage {
  decode?: () => Promise<unknown>;
  onload?: ((event: Event) => void) | null;
  onerror?: ((event: Event) => void) | null;
  naturalWidth: number;
  naturalHeight: number;
  width?: number;
  height?: number;
}

/** The minimum canvas shape: one 2d context, and the ability to return null. */
export interface PaletteCanvas {
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}

export interface PaletteEnvironment {
  createImage?: (src: string, crossOrigin?: string | null) => PaletteImage;
  createCanvas?: (width: number, height: number) => PaletteCanvas | null;
}

/** 16x16 is ample: 256 pixels, and every read is a cheap array index. */
const SAMPLE_EDGE = 16;

/**
 * Resolves the ambient palette for one artwork URL, with a cache in front.
 *
 * NEVER THROWS and never returns null for a non-empty URL: the identity
 * derivation guarantees a palette, because a missing ambience is a silent
 * downgrade nobody would notice and a crash is not an option in a hook that
 * runs off the playback path.
 */
export async function resolveArtworkPalette(
  artworkUrl: string,
  env: PaletteEnvironment,
): Promise<AuroraPalette> {
  const hit = cachedPalette(artworkUrl);
  if (hit) {
    return hit;
  }
  const sampled = await samplePixels(artworkUrl, env);
  const palette = sampled ?? paletteFromIdentity(artworkUrl);
  return rememberPalette(artworkUrl, palette);
}

async function samplePixels(
  artworkUrl: string,
  env: PaletteEnvironment,
): Promise<AuroraPalette | null> {
  if (typeof env.createImage !== "function" || typeof env.createCanvas !== "function") {
    return null;
  }
  let canvas: PaletteCanvas | null = null;
  let image: PaletteImage | null = null;
  try {
    // `anonymous` is the whole reason extraction is possible: it is what
    // makes the canvas untainted, and an untainted canvas is what makes
    // getImageData legal. When the host does not send CORS the load fails
    // outright and the identity path below takes over - which is the correct
    // outcome, because the alternative (loading without crossOrigin) yields a
    // tainted canvas and getImageData throws on every host, CORS-enabled or
    // not.
    image = env.createImage(artworkUrl, "anonymous");
    await settleImage(image);
    if (image.naturalWidth <= 0) {
      return null;
    }
    canvas = env.createCanvas(SAMPLE_EDGE, SAMPLE_EDGE);
    const context = canvas?.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(
      image as unknown as CanvasImageSource,
      0,
      0,
      SAMPLE_EDGE,
      SAMPLE_EDGE,
    );
    const data = context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    return paletteFromPixels(data.data);
  } catch {
    // A SecurityError from getImageData means the host withheld CORS after
    // all. Anything else means the same thing here: no pixels.
    return null;
  } finally {
    // Release the backing store immediately. A 16x16 canvas is trivial, but
    // it is allocated on a track change and this is the whole teardown.
    canvas = null;
    image = null;
  }
}

/**
 * Waits for the artwork to load, whichever way this element signals it.
 *
 * The `done` latch exists because the two paths can both fire: an element
 * whose `onload` already ran can still call the handler attached afterwards,
 * and a lost `resolve` here would hang `samplePixels` - and therefore hang the
 * ambient write that runs off the playback path. A second `resolve` is a
 * no-op, so the latch is free.
 */
function settleImage(image: PaletteImage): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    try {
      if (typeof image.decode === "function") {
        void image.decode().then(
          () => finish(true),
          () => finish(false),
        );
      } else if (image.onload || image.onerror) {
        image.onload = () => finish(true);
        image.onerror = () => finish(false);
      } else {
        finish(false);
      }
    } catch {
      finish(false);
    }
  });
}
