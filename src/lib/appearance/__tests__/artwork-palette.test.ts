/**
 * Artwork palette tests (Phase 53).
 *
 * The mission's requirement is that ambience be "restrained" and derived
 * through "memoized/low-frequency/precomputed" means rather than per-frame
 * analysis. Those are two different claims and this file defends both.
 *
 * RESTRAINT IS A HARD INVARIANT, not a preference. The mission also says no
 * rainbow, no neon, and that the palette must be "cool, luminous, cinematic".
 * Rather than asserting that particular artworks "look nice", the tests assert
 * the two properties that make that true for EVERY input: every hue lands
 * inside the cool window, and no chroma can exceed the ceiling. A test table of
 * nice-looking inputs would pass while a lime-green album cover produced a
 * chartreuse interface; a window test cannot.
 *
 * THE CORS STORY IS THE OTHER HALF. Provider artwork is cross-origin, so a
 * canvas readback is usually tainted and `getImageData` throws. That is not a
 * failure to work around - it is the normal case, and the identity path is what
 * runs in the wild. So the fallback is tested as a first-class path with its
 * own determinism and its own restraint guarantees, not as an afterthought.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  AURORA_CHROMA_MAX,
  AURORA_HUE_MAX,
  AURORA_HUE_MIN,
  AURORA_LIGHTNESS_MAX,
  AURORA_LIGHTNESS_MIN,
  cachedPalette,
  clearPaletteCache,
  formatOklch,
  hashString,
  meanColor,
  paletteCacheSize,
  paletteFromIdentity,
  paletteFromPixels,
  rememberPalette,
  restrain,
  resolveArtworkPalette,
  srgbToOklch,
  type AuroraPalette,
  type PaletteEnvironment,
} from "@/lib/appearance/artwork-palette";

/* ==========================================================================
   HELPERS
   ========================================================================== */

const PALETTE_KEYS = ["primary", "secondary", "glow", "tint"] as const;

/** Every `oklch()` string in a palette, as numbers. */
function readAll(palette: AuroraPalette): { l: number; c: number; h: number }[] {
  return PALETTE_KEYS.map((key) => {
    const match = /oklch\(([^)]+)\)/.exec(palette[key]);
    if (!match) {
      throw new Error(`${key} is not an oklch() string: ${palette[key]}`);
    }
    const [l, c, h] = match[1]
      .split("/")[0]
      .trim()
      .split(/\s+/)
      .map(Number);
    return { l, c, h };
  });
}

/** A solid RGBA block of `count` pixels. */
function solid(r: number, g: number, b: number, count = 16): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function environment(
  pixels: Uint8ClampedArray,
  overrides: Partial<PaletteEnvironment> = {},
): PaletteEnvironment {
  return {
    createImage: () => ({
      naturalWidth: 300,
      naturalHeight: 300,
      decode: async () => undefined,
    }),
    createCanvas: () => ({
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: () => ({ data: pixels }),
      }) as unknown as CanvasRenderingContext2D,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  clearPaletteCache();
});

/* ==========================================================================
   THE RESTRAINT WINDOW
   ========================================================================== */

describe("restrain", () => {
  it("puts every hue inside the cool window, from any input at all", () => {
    // The invariant. A sweep of the whole wheel plus out-of-range values: no
    // input can produce a warm or acid hue, which is what makes "no rainbow"
    // a property of the code rather than a hope about the artwork.
    for (let hue = -720; hue <= 720; hue += 1) {
      const out = restrain({ l: 0.6, c: 0.2, h: hue });
      expect(out.h, `input ${hue}`).toBeGreaterThanOrEqual(AURORA_HUE_MIN);
      expect(out.h, `input ${hue}`).toBeLessThanOrEqual(AURORA_HUE_MAX);
    }
  });

  it("covers the whole window rather than collapsing to one value", () => {
    // If the remap were a clamp, everything warm would land on 170 and the
    // ambience would be a single flat colour. A modulo keeps the relative
    // position of every hue.
    const hues = new Set<number>();
    for (let hue = 0; hue < 360; hue += 1) {
      hues.add(Math.round(restrain({ l: 0.6, c: 0.1, h: hue }).h));
    }
    // The window is 170 degrees wide, so at least that many distinct values
    // have to be reachable or the mapping is losing information.
    expect(hues.size).toBeGreaterThanOrEqual(AURORA_HUE_MAX - AURORA_HUE_MIN);
  });

  it("leaves a hue that is already inside the window alone", () => {
    for (const hue of [170, 200, 250, 300, 339]) {
      expect(restrain({ l: 0.6, c: 0.1, h: hue }).h, `input ${hue}`).toBe(hue);
    }
  });

  it("treats the window as half-open, wrapping the upper bound to the lower", () => {
    // Not a defect: the remap is a modulo over a span of `MAX - MIN`, so the
    // upper bound is the first hue OUT of window. Asserted because a reader
    // seeing `AURORA_HUE_MAX` will otherwise reasonably assume 340 is
    // reachable, and then be surprised by a hue of 170 in a test.
    expect(restrain({ l: 0.6, c: 0.1, h: AURORA_HUE_MAX }).h).toBe(
      AURORA_HUE_MIN,
    );
    expect(restrain({ l: 0.6, c: 0.1, h: AURORA_HUE_MAX }).h).toBeLessThan(
      AURORA_HUE_MAX,
    );
  });

  it("scales chroma down globally, and never above the ceiling", () => {
    // The global scale is the design, not an incidental: artwork is
    // consistently more saturated than an ambient wash should be, so every
    // input comes down, and the RELATIONSHIP between covers survives. A soft
    // knee would only differ above 0.12, where the cap is already flattening
    // everything and hue is what still tells two vivid covers apart.
    const scale = 0.45;
    expect(restrain({ l: 0.6, c: 0.2, h: 250 }).c).toBeCloseTo(0.2 * scale, 6);
    expect(restrain({ l: 0.6, c: 0.04, h: 250 }).c).toBeCloseTo(0.04 * scale, 6);

    // Above the ceiling everything converges, and never exceeds it.
    for (const input of [0.3, 0.5, 1, 4]) {
      expect(restrain({ l: 0.6, c: input, h: 250 }).c, `input ${input}`).toBeLessThanOrEqual(
        AURORA_CHROMA_MAX,
      );
    }
  });

  it("keeps chroma monotonic, so a more vivid cover is never less colourful", () => {
    // Monotonicity is the property that makes the wash track the artwork. A
    // knee-based implementation could break it, and the resulting regression -
    // a neon cover producing a greyer ambience than a pastel one - would look
    // like a bug report rather than a maths error.
    let previous = -1;
    for (let input = 0; input <= 0.5; input += 0.01) {
      const chroma = restrain({ l: 0.6, c: input, h: 250 }).c;
      expect(chroma, `input ${input.toFixed(2)}`).toBeGreaterThanOrEqual(previous);
      previous = chroma;
    }
  });

  it("never produces a negative chroma, which `oklch()` would reject", () => {
    expect(restrain({ l: 0.6, c: -1, h: 250 }).c).toBe(0);
  });

  it("keeps lightness inside its window, so the wash never blackens or bleaches", () => {
    for (const l of [0, 0.1, 0.5, 0.9, 1]) {
      const out = restrain({ l, c: 0.1, h: 250 });
      expect(out.l, `input ${l}`).toBeGreaterThanOrEqual(AURORA_LIGHTNESS_MIN);
      expect(out.l, `input ${l}`).toBeLessThanOrEqual(AURORA_LIGHTNESS_MAX);
    }
  });

  it("is total, for NaN and nonsense included", () => {
    for (const source of [
      { l: Number.NaN, c: Number.NaN, h: Number.NaN },
      { l: Number.POSITIVE_INFINITY, c: Number.POSITIVE_INFINITY, h: Number.POSITIVE_INFINITY },
      { l: -1e9, c: -1e9, h: -1e9 },
    ]) {
      const out = restrain(source);
      for (const value of [out.l, out.c, out.h]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(out.h).toBeGreaterThanOrEqual(AURORA_HUE_MIN);
      expect(out.h).toBeLessThanOrEqual(AURORA_HUE_MAX);
      expect(out.c).toBeLessThanOrEqual(AURORA_CHROMA_MAX);
    }
  });
});

/* ==========================================================================
   THE TWO SOURCES
   ========================================================================== */

describe("paletteFromIdentity", () => {
  it("is deterministic, because the fallback must not shimmer between tracks", () => {
    // The identity path is what runs in the wild (see the CORS tests), so a
    // non-deterministic fallback would mean the ambient light changing for
    // reasons nobody can explain.
    const first = paletteFromIdentity("https://cdn.test/a.jpg");
    const second = paletteFromIdentity("https://cdn.test/a.jpg");
    expect(second).toEqual(first);
  });

  it("differs between different artworks, so the ambience actually tracks", () => {
    const a = paletteFromIdentity("https://cdn.test/a.jpg");
    const b = paletteFromIdentity("https://cdn.test/b.jpg");
    expect(b.primary).not.toBe(a.primary);
  });

  it("stays inside the restraint window", () => {
    for (let i = 0; i < 200; i += 1) {
      const palette = paletteFromIdentity(`https://cdn.test/cover-${i}.jpg`);
      for (const { l, c, h } of readAll(palette)) {
        expect(h).toBeGreaterThanOrEqual(AURORA_HUE_MIN);
        expect(h).toBeLessThanOrEqual(AURORA_HUE_MAX);
        expect(c).toBeLessThanOrEqual(AURORA_CHROMA_MAX);
        expect(l).toBeGreaterThanOrEqual(AURORA_LIGHTNESS_MIN);
        expect(l).toBeLessThanOrEqual(AURORA_LIGHTNESS_MAX);
      }
    }
  });

  it("declares its source, so a caller can tell pixels from a guess", () => {
    expect(paletteFromIdentity("https://cdn.test/a.jpg").source).toBe("identity");
  });

  it("produces four DISTINCT colours, so it is a palette and not one hue", () => {
    const palette = paletteFromIdentity("https://cdn.test/a.jpg");
    const values = PALETTE_KEYS.map((key) => palette[key]);
    expect(new Set(values).size).toBe(4);
  });
});

describe("paletteFromPixels", () => {
  it("derives a real palette from real pixels", () => {
    const palette = paletteFromPixels(solid(30, 90, 200));
    expect(palette).not.toBeNull();
    expect(palette?.source).toBe("pixels");
  });

  it("constrains a vivid, warm, fully saturated input to the window", () => {
    // The test that matters most: pure orange at full chroma is the input that
    // would produce an orange interface if the window were advisory.
    const palette = paletteFromPixels(solid(255, 140, 0));
    for (const { l, c, h } of readAll(palette!)) {
      expect(h).toBeGreaterThanOrEqual(AURORA_HUE_MIN);
      expect(h).toBeLessThanOrEqual(AURORA_HUE_MAX);
      expect(c).toBeLessThanOrEqual(AURORA_CHROMA_MAX);
      expect(l).toBeGreaterThanOrEqual(AURORA_LIGHTNESS_MIN);
      expect(l).toBeLessThanOrEqual(AURORA_LIGHTNESS_MAX);
    }
  });

  it("returns null for no pixels, rather than a black palette", () => {
    expect(paletteFromPixels(new Uint8ClampedArray(0))).toBeNull();
  });
});

describe("meanColor", () => {
  it("averages the pixels it is given", () => {
    expect(meanColor(solid(10, 20, 30))).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("ignores fully transparent pixels rather than averaging them in", () => {
    // Artwork is frequently letterboxed or has an alpha ramp. Weighting a
    // transparent black at full value drags the mean toward black and makes
    // every partly-transparent cover produce the same dull ambience.
    const pixels = new Uint8ClampedArray([
      200, 200, 200, 255,
      0, 0, 0, 0,
    ]);
    expect(meanColor(pixels)).toEqual({ r: 200, g: 200, b: 200 });
  });

  it("weights by alpha, so a 10% pixel does not count as much as an opaque one", () => {
    // THE BUG THIS NOW GUARDS. Weighting each pixel by its alpha and then
    // dividing by the pixel COUNT would darken the result in proportion to how
    // much of the artwork is transparent - a 20% transparent cover coming out
    // 20% darker for no reason, which is exactly what the premultiplication is
    // supposed to prevent. The sum of alpha is the divisor.
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 26,
    ]);
    const mean = meanColor(pixels)!;
    expect(mean.r).toBeGreaterThan(200);
    expect(mean.r).toBeLessThan(255);
  });

  it("is unchanged by a uniform alpha, so opacity cannot darken the result", () => {
    // The companion to the test above, and the same property from the other
    // side: a cover that is uniformly 50% opaque is the same COLOUR as one that
    // is 100% opaque, and the mean must not report it as half as bright.
    const opaque = meanColor(new Uint8ClampedArray([200, 100, 50, 255]))!;
    const halfAlpha = meanColor(new Uint8ClampedArray([200, 100, 50, 128]))!;
    const quarterAlpha = meanColor(new Uint8ClampedArray([200, 100, 50, 64]))!;
    expect(halfAlpha).toEqual(opaque);
    expect(quarterAlpha).toEqual(opaque);
  });

  it("returns null when every pixel is transparent, which is not a colour", () => {
    expect(meanColor(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("srgbToOklch", () => {
  it.each([
    ["black", 0, 0, 0],
    ["white", 255, 255, 255],
    ["mid grey", 128, 128, 128],
  ])("handles %s without producing nonsense", (_label, r, g, b) => {
    const { l, c, h } = srgbToOklch(r, g, b);
    for (const value of [l, c, h]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(l).toBeGreaterThanOrEqual(0);
    expect(l).toBeLessThanOrEqual(1);
    // Achromatic colours have no meaningful hue, so chroma must be ~0 rather
    // than an arbitrary angle: a grey that reported a hue would be given a
    // colour by the restraint window.
    expect(c).toBeLessThan(0.001);
  });

  it("puts a saturated blue where blue belongs, before restraint", () => {
    const { h, c } = srgbToOklch(20, 40, 220);
    // oklch hue for a blue is around 260-270 degrees.
    expect(h).toBeGreaterThan(230);
    expect(h).toBeLessThan(300);
    expect(c).toBeGreaterThan(0.1);
  });
});

describe("formatOklch", () => {
  it("produces a value a browser accepts, with no trailing float noise", () => {
    const value = formatOklch({ l: 0.5, c: 0.1, h: 250 });
    expect(value).toMatch(/^oklch\(\s*[\d.]+%?\s+[\d.]+\s+[\d.]+(\s*\/\s*[\d.]+%?)?\s*\)$/);
    expect(value).not.toMatch(/\d{6,}/);
  });
});

describe("hashString", () => {
  it("is stable and spreads similar inputs apart", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

/* ==========================================================================
   RESOLUTION, AND THE CORS FALLBACK
   ========================================================================== */

describe("resolveArtworkPalette", () => {
  it("uses the pixels when the canvas is readable", async () => {
    const palette = await resolveArtworkPalette(
      "https://cdn.test/a.jpg",
      environment(solid(20, 60, 180)),
    );
    expect(palette.source).toBe("pixels");
  });

  it("falls back to the identity when the canvas is tainted", async () => {
    // THE NORMAL CASE IN THE WILD. Provider artwork is cross-origin, so
    // `getImageData` throws a SecurityError. `crossOrigin="anonymous"` is
    // attempted first precisely so this is rare - but when it happens, the
    // ambience has to keep working rather than throw inside a hook that runs off
    // the playback path.
    const tainted = environment(solid(20, 60, 180), {
      createCanvas: () => ({
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => {
            throw new Error("SecurityError: tainted canvas");
          },
        }) as unknown as CanvasRenderingContext2D,
      }),
    });
    const palette = await resolveArtworkPalette("https://cdn.test/a.jpg", tainted);
    expect(palette.source).toBe("identity");
    for (const { h, c } of readAll(palette)) {
      expect(h).toBeGreaterThanOrEqual(AURORA_HUE_MIN);
      expect(h).toBeLessThanOrEqual(AURORA_HUE_MAX);
      expect(c).toBeLessThanOrEqual(AURORA_CHROMA_MAX);
    }
  });

  it("falls back when the host refuses the CORS request entirely", async () => {
    const refused = environment(solid(20, 60, 180), {
      createImage: () => ({
        naturalWidth: 0,
        naturalHeight: 0,
        decode: async () => {
          throw new Error("load failed");
        },
      }),
    });
    const palette = await resolveArtworkPalette("https://cdn.test/a.jpg", refused);
    expect(palette.source).toBe("identity");
  });

  it("falls back when there is no browser at all", async () => {
    // A server render, or a test. `resolveArtworkPalette` never returns null
    // for a non-empty address, because a missing ambience is a silent
    // downgrade nobody would report and a crash is not an option here.
    const palette = await resolveArtworkPalette("https://cdn.test/a.jpg", {});
    expect(palette.source).toBe("identity");
  });

  it("asks for CORS, which is the only reason pixel extraction ever succeeds", async () => {
    let seen: string | null | undefined;
    await resolveArtworkPalette(
      "https://cdn.test/a.jpg",
      environment(solid(20, 60, 180), {
        createImage: (src, crossOrigin) => {
          seen = crossOrigin;
          return {
            naturalWidth: 300,
            naturalHeight: 300,
            decode: async () => undefined,
          };
        },
      }),
    );
    expect(seen).toBe("anonymous");
  });

  it("never rejects, whatever the environment throws", async () => {
    const hostile: PaletteEnvironment[] = [
      {},
      {
        createImage: () => {
          throw new Error("boom");
        },
        createCanvas: () => {
          throw new Error("boom");
        },
      },
      {
        createImage: () => ({
          naturalWidth: 300,
          naturalHeight: 300,
          decode: async () => {
            throw new Error("boom");
          },
        }),
        createCanvas: () => null,
      },
      {
        createImage: () => ({
          get naturalWidth(): number {
            throw new Error("boom");
          },
          naturalHeight: 300,
        }),
      },
    ];
    for (const environment of hostile) {
      await expect(
        resolveArtworkPalette("https://cdn.test/x.jpg", environment),
      ).resolves.toEqual(expect.objectContaining({ primary: expect.any(String) }));
    }
  });
});

/* ==========================================================================
   THE CACHE
   ========================================================================== */

describe("the palette cache", () => {
  it("answers a repeat request without touching the browser again", async () => {
    // "Memoized", in the mission's words. A cache miss on every render would
    // mean a canvas and a `getImageData` per re-render of whatever is playing,
    // which is per-frame analysis by another name.
    let created = 0;
    const counting = environment(solid(20, 60, 180), {
      createCanvas: () => {
        created += 1;
        return {
          getContext: () => ({
            drawImage: () => undefined,
            getImageData: () => ({ data: solid(20, 60, 180) }),
          }) as unknown as CanvasRenderingContext2D,
        };
      },
    });

    const url = "https://cdn.test/cached.jpg";
    const first = await resolveArtworkPalette(url, counting);
    const second = await resolveArtworkPalette(url, counting);
    const third = await resolveArtworkPalette(url, counting);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Once: the second and third are cache hits.
    expect(created).toBe(1);
    expect(paletteCacheSize()).toBe(1);
  });

  it("is bounded, so a long session cannot grow it without limit", () => {
    // An unbounded Map keyed by artwork URL is a memory leak with a very long
    // fuse: a queue of 500 tracks played in full produces 500 palettes.
    for (let i = 0; i < 200; i += 1) {
      rememberPalette(`https://cdn.test/${i}.jpg`, paletteFromIdentity(`https://cdn.test/${i}.jpg`));
    }
    expect(paletteCacheSize()).toBeLessThanOrEqual(32);
  });

  it("caches the fallback too, so a tainted host is not re-read every time", () => {
    const url = "https://cdn.test/tainted.jpg";
    const palette = paletteFromIdentity(url);
    rememberPalette(url, palette);
    expect(cachedPalette(url)).toEqual(palette);
  });

  it("reports a miss honestly", () => {
    expect(cachedPalette("https://cdn.test/never-seen.jpg")).toBeUndefined();
  });
});
