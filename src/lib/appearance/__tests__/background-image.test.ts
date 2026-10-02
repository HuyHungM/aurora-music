/**
 * Background image validation tests (Phase 53).
 *
 * The mission's requirement is specific and unusual: validate the MIME type,
 * the file size, the dimensions AND decode success - "not extension alone".
 * That is four independent facts about a remote resource, and the test file
 * exists to make sure each one is actually consulted rather than assumed, and
 * that the two genuinely different browser situations - a host that sends
 * CORS headers and a host that does not - both reach a real verdict.
 *
 * The failure cases matter more than the happy path here. A background is
 * decoration a user pastes an address for; every way this can go wrong has to
 * produce a DIFFERENT message, because "invalid image" tells somebody nothing
 * about whether to resize the file, fix the link, or try another host.
 */

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LOAD_TIMEOUT_MS,
  BACKGROUND_MAX_BYTES,
  BACKGROUND_MAX_EDGE,
  BACKGROUND_MAX_PIXELS,
  BACKGROUND_MIN_HEIGHT,
  BACKGROUND_MIN_WIDTH,
  BACKGROUND_REJECTIONS,
  BACKGROUND_REJECTION_KEYS,
  IMAGE_FORMATS,
  checkBackgroundDimensions,
  checkBackgroundUrl,
  sniffImageFormat,
  validateBackgroundImage,
  type BackgroundImageElement,
  type BackgroundImageEnvironment,
  type BackgroundImageFetch,
  type BackgroundImageResult,
} from "@/lib/appearance/background-image";
import en from "@/lib/i18n/en";
import vi from "@/lib/i18n/vi";

/* ==========================================================================
   FIXTURES
   ========================================================================== */

/** The smallest legal prefix for each supported format. */
const MAGIC: Record<string, number[]> = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00],
  webp: [0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  // `ftyp` box declaring the `avif` compatible brand, which is what a real
  // AVIF file carries. The size field is 32 bytes, which is a real one.
  avif: [
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    0x00, 0x00, 0x00, 0x00, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31,
    0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
  ],
};

function bytesFor(format: keyof typeof MAGIC, length = 64): Uint8Array {
  const prefix = MAGIC[format];
  const out = new Uint8Array(Math.max(length, prefix.length));
  out.set(prefix, 0);
  return out;
}

/**
 * `bytes` as a standalone `ArrayBuffer`, which is the shape the validator's
 * minimal `fetch` contract declares.
 *
 * The cast is not laziness: `Uint8Array.buffer` is typed `ArrayBufferLike` to
 * cover `SharedArrayBuffer`-backed views, and this buffer is always
 * `new Uint8Array(length)`, which is not one.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** A cooperative `fetch` that returns `bytes` with an OK status. */
function cooperativeFetch(bytes: Uint8Array): BackgroundImageFetch {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bufferOf(bytes),
  });
}

/** An image element of a given size that decodes. */
function sizedImage(width: number, height: number): BackgroundImageElement {
  return {
    naturalWidth: width,
    naturalHeight: height,
    decode: async () => undefined,
  };
}

/** A `fetch` that always fails, i.e. a host that refuses CORS. */
const refusingFetch: BackgroundImageFetch = async () => {
  throw new TypeError("Failed to fetch");
};

function env(overrides: Partial<BackgroundImageEnvironment> = {}) {
  return { fetch: cooperativeFetch(bytesFor("png")), createImage: () => sizedImage(1920, 1080), ...overrides };
}

function rejection(result: BackgroundImageResult): string {
  if (result.ok) {
    throw new Error("expected a rejection");
  }
  return result.reason;
}

/* ==========================================================================
   FORMAT SNIFFING
   ========================================================================== */

describe("sniffImageFormat", () => {
  it.each(IMAGE_FORMATS)("identifies %s from its leading bytes", (format) => {
    // The mission's "not extension alone": the verdict comes from the payload,
    // so a `.jpg` that is really a PDF never gets past this.
    expect(sniffImageFormat(bytesFor(format))).toBe(format);
  });

  it("rejects a payload that is not one of the supported formats", () => {
    expect(sniffImageFormat(new Uint8Array(64))).toBeNull();
    // A PDF header: a plausible thing to be handed by a mistyped address.
    expect(sniffImageFormat(new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(40)))).toBeNull();
    // An HTML error page, which is what a 200 response from a broken link
    // usually is.
    expect(sniffImageFormat(new TextEncoder().encode("<!DOCTYPE html>" + "x".repeat(40)))).toBeNull();
  });

  it("needs enough bytes to decide, and says so rather than guessing", () => {
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
    // A prefix that has been cut short: the PNG signature is 8 bytes and a
    // 4-byte buffer could be anything.
    expect(sniffImageFormat(bytesFor("png").slice(0, 6))).toBeNull();
  });

  it("does not mistake HEIC for AVIF just because both are ISO-BMFF", () => {
    // The reason the brand list is scanned rather than the box being trusted:
    // a `.heic` passes a naive `ftyp` check and then fails to decode, which is
    // a worse outcome than refusing it here.
    const heic = new Uint8Array(64);
    heic.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x66]);
    heic.set([0x6d, 0x69, 0x66, 0x66, 0x68, 0x65, 0x69, 0x63], 16);
    expect(sniffImageFormat(heic)).toBeNull();
  });

  it("finds an `avif` brand that is not the very first one", () => {
    // Real files put `mif1`/`msf1` before the compatible brand list, so a
    // fixed-offset check would miss them and reject valid files.
    const bytes = bytesFor("avif");
    bytes.set([0x6d, 0x69, 0x66, 0x31], 8);
    expect(sniffImageFormat(bytes)).toBe("avif");
  });
});

/* ==========================================================================
   ADDRESS CHECKS
   ========================================================================== */

describe("checkBackgroundUrl", () => {
  it("accepts an ordinary https address", () => {
    // `parsed` is carried out as well as the raw string, and the two are
    // different things: `url` is the exact text that was checked (so the
    // stored value is precisely what was validated) while `parsed` is the
    // `URL` the scheme and credential checks were actually run against. A
    // re-serialisation could in principle produce a different URL, which is
    // exactly why the checked text is the one that is kept.
    const check = checkBackgroundUrl("https://img.test/photo.jpg");
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("expected acceptance");
    expect(check.url).toBe("https://img.test/photo.jpg");
    expect(check.parsed).toBeInstanceOf(URL);
    expect(check.parsed.href).toBe("https://img.test/photo.jpg");
    expect(check.parsed.protocol).toBe("https:");
  });

  it("trims the address, so a pasted trailing space is not a rejection", () => {
    const check = checkBackgroundUrl("  https://img.test/photo.jpg  ");
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("expected acceptance");
    expect(check.url).toBe("https://img.test/photo.jpg");
  });

  it("requires https", () => {
    // A background is fetched by the browser from a page the CSP allows to
    // load images, but an http address on an https page is a mixed-content
    // request the browser blocks silently. Refusing it here turns a silent
    // failure into a message.
    expect(checkBackgroundUrl("http://img.test/a.jpg")).toEqual({
      ok: false,
      reason: "insecureScheme",
    });
  });

  it.each([
    ["a data URL", "data:image/png;base64,AAAA", "insecureScheme"],
    ["a javascript URL", "javascript:alert(1)", "insecureScheme"],
    ["a file URL", "file:///etc/passwd", "insecureScheme"],
    ["a bare path", "/backgrounds/aurora-night.svg", "invalidUrl"],
    ["empty", "", "empty"],
    ["whitespace only", "   ", "empty"],
    ["not a URL at all", "nonsense", "invalidUrl"],
  ])("refuses %s", (_label, value, reason) => {
    expect(checkBackgroundUrl(value)).toEqual({ ok: false, reason });
  });

  it("refuses credentials in the address", () => {
    // Aurora must never send a session or a password to an image host. The
    // check is on the address because that is where the credential would be
    // attached.
    expect(checkBackgroundUrl("https://user:pass@img.test/a.jpg")).toEqual({
      ok: false,
      reason: "credentialsInUrl",
    });
  });

  it("refuses an address longer than the stored column can hold", () => {
    const long = `https://img.test/${"a".repeat(4096)}.jpg`;
    expect(checkBackgroundUrl(long)).toEqual({ ok: false, reason: "tooLong" });
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [undefined, null, 0, {}, [], Symbol.iterator]) {
      expect(() => checkBackgroundUrl(value)).not.toThrow();
      expect(checkBackgroundUrl(value).ok).toBe(false);
    }
  });
});

/* ==========================================================================
   DIMENSION CHECKS
   ========================================================================== */

describe("checkBackgroundDimensions", () => {
  it("accepts a normal photograph, including 4K", () => {
    expect(checkBackgroundDimensions(1920, 1080)).toBeNull();
    // 4K is 8.29 MP, which an 8 MP limit refused - and refusing 4K is refusing
    // the most common good photograph there is, on a display size this
    // application supports. The regression is asserted here so the cap cannot
    // quietly be lowered back below it.
    expect(checkBackgroundDimensions(3840, 2160)).toBeNull();
    expect(checkBackgroundDimensions(4096, 2160)).toBeNull();
  });

  it("accepts a 12 MP phone camera photograph", () => {
    // The most common phone sensor size. 4 bytes per pixel is about 48 MB
    // decoded, which is the real cost of the limit.
    expect(checkBackgroundDimensions(4000, 3000)).toBeNull();
  });

  it("refuses one that is too small to be a background", () => {
    // Below the floor, `cover` on a 2560px display is upsampling, and the
    // result is the smeared image that makes people think the feature is
    // broken.
    expect(checkBackgroundDimensions(BACKGROUND_MIN_WIDTH - 1, 1080)).toBe("tooSmall");
    expect(checkBackgroundDimensions(1920, BACKGROUND_MIN_HEIGHT - 1)).toBe("tooSmall");
  });

  it("accepts exactly the floor", () => {
    expect(checkBackgroundDimensions(BACKGROUND_MIN_WIDTH, BACKGROUND_MIN_HEIGHT)).toBeNull();
  });

  it("refuses one with more pixels than a background needs", () => {
    // A 24 MP mirrorless original: over 5 MB as a JPEG, so the transfer cap
    // usually catches it first, and 96 MB decoded if it somehow does not.
    expect(checkBackgroundDimensions(6000, 4000)).toBe("tooManyPixels");
    expect(checkBackgroundDimensions(8000, 8000)).toBe("tooManyPixels");
    expect(BACKGROUND_MAX_PIXELS).toBe(16_000_000);
  });

  it("refuses one with an extreme axis, even below the pixel budget", () => {
    // A 20000x200 panorama is 4 MP but decodes into a 640000:1 strip, and a
    // browser will refuse or mangle it.
    expect(checkBackgroundDimensions(20000, 200)).toBe("tooSmall");
    expect(checkBackgroundDimensions(BACKGROUND_MAX_EDGE + 1, 400)).toBe("tooSmall");
  });

  it("treats a size that is not a size as a decode failure, not a size complaint", () => {
    // A browser reporting 0x0 never produced an image, so `decodeFailed` is
    // the honest verdict. The callers that care about the difference check for
    // it themselves and report `networkError`, which is the likelier cause.
    expect(checkBackgroundDimensions(0, 1080)).toBe("decodeFailed");
    expect(checkBackgroundDimensions(1920, 0)).toBe("decodeFailed");
    expect(checkBackgroundDimensions(-1, -1)).toBe("decodeFailed");
    expect(checkBackgroundDimensions(Number.NaN, 1080)).toBe("decodeFailed");
    expect(checkBackgroundDimensions(Number.POSITIVE_INFINITY, 1080)).toBe("decodeFailed");
  });
});

/* ==========================================================================
   END TO END
   ========================================================================== */

describe("validateBackgroundImage", () => {
  it("reports a real format, size and dimensions for a cooperative host", async () => {
    // The strong path: every one of the mission's four checks actually ran.
    const result = await validateBackgroundImage(
      "https://img.test/photo.jpg",
      env({ fetch: cooperativeFetch(bytesFor("jpeg", 2048)) }),
    );
    expect(result).toEqual({
      ok: true,
      info: {
        url: "https://img.test/photo.jpg",
        width: 1920,
        height: 1080,
        bytes: 2048,
        format: "jpeg",
      },
    });
  });

  it("refuses a file that is too large before anything is decoded", () => {
    // Before: the transfer has already happened, but before the decode -
    // decoding an 8 MB payload to then refuse it is pure waste.
    const result = validateBackgroundImage(
      "https://img.test/huge.png",
      env({ fetch: cooperativeFetch(bytesFor("png", BACKGROUND_MAX_BYTES + 1)) }),
    );
    return expect(result).resolves.toEqual({ ok: false, reason: "tooLarge" });
  });

  it("accepts a file of exactly the size limit", async () => {
    const result = await validateBackgroundImage(
      "https://img.test/exactly.png",
      env({ fetch: cooperativeFetch(bytesFor("png", BACKGROUND_MAX_BYTES)) }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a payload that is not a supported image, whatever it is named", async () => {
    // The whole reason for sniffing rather than trusting the extension: a
    // `.png` that is a text file is the single most common broken link.
    const result = await validateBackgroundImage(
      "https://img.test/fake.png",
      env({ fetch: cooperativeFetch(new TextEncoder().encode("<html>404</html>")) }),
    );
    expect(rejection(result)).toBe("unsupportedType");
  });

  it("refuses bytes that sniff as an image but will not decode", async () => {
    // A truncated or deliberately malformed payload. Distinct from a network
    // problem, and the difference matters: one is the file, the other is the
    // connection.
    const result = await validateBackgroundImage(
      "https://img.test/truncated.jpg",
      env({
        fetch: cooperativeFetch(bytesFor("jpeg")),
        createImage: () => ({
          naturalWidth: 0,
          naturalHeight: 0,
          decode: async () => {
            throw new Error("unsupported");
          },
        }),
      }),
    );
    expect(rejection(result)).toBe("decodeFailed");
  });

  it("refuses a real image whose dimensions are unacceptable", async () => {
    const result = await validateBackgroundImage(
      "https://img.test/tiny.png",
      env({ createImage: () => sizedImage(64, 64) }),
    );
    expect(rejection(result)).toBe("tooSmall");
  });

  it("still validates when the host refuses CORS, and admits what it could not check", async () => {
    // THE OPAQUE PATH. A `fetch` rejection is not a rejection of the image: it
    // is a statement about the host. The image path needs no CORS because
    // nothing is read back out of it, and the browser's successful decode IS
    // the type check. `format` and `bytes` stay null rather than being guessed,
    // so nothing downstream can claim a check that did not happen.
    const result = await validateBackgroundImage(
      "https://img.test/opaque.jpg",
      env({ fetch: refusingFetch, createImage: () => sizedImage(1920, 1080) }),
    );
    expect(result).toEqual({
      ok: true,
      info: {
        url: "https://img.test/opaque.jpg",
        width: 1920,
        height: 1080,
        bytes: null,
        format: null,
      },
    });
  });

  it("reports a network error when an opaque image never arrives at all", async () => {
    const result = await validateBackgroundImage(
      "https://img.test/gone.jpg",
      env({
        fetch: refusingFetch,
        createImage: () => ({
          naturalWidth: 0,
          naturalHeight: 0,
          onload: null,
          onerror: null,
        }),
      }),
    );
    // Distinguished from `decodeFailed` by the absence of any dimensions: there
    // was nothing to decode, which points at the connection rather than the
    // file.
    expect(rejection(result)).toBe("networkError");
  });

  it("reports a network error when the host answers with an error status", async () => {
    const result = await validateBackgroundImage(
      "https://img.test/404.jpg",
      env({
        fetch: async () => ({
          ok: false,
          status: 404,
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
        createImage: () => ({
          naturalWidth: 0,
          naturalHeight: 0,
          onload: null,
          onerror: null,
        }),
      }),
    );
    expect(rejection(result)).toBe("networkError");
  });

  it("reports `unavailable` rather than crashing when the browser cannot check", async () => {
    // §74. Validation runs inside the settings UI; a thrown error there takes
    // the page down, and "this browser cannot check images" is a survivable
    // answer while an exception is not.
    const result = await validateBackgroundImage("https://img.test/a.jpg", {
      fetch: undefined,
      createImage: undefined,
    });
    expect(rejection(result)).toBe("unavailable");
  });

  it("never throws, whatever the environment does", async () => {
    const hostile: BackgroundImageEnvironment[] = [
      {},
      {
        fetch: async () => {
          throw new Error("boom");
        },
      },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => {
            throw new Error("boom");
          },
        }),
        createImage: () => {
          throw new Error("boom");
        },
      },
      {
        fetch: cooperativeFetch(bytesFor("png")),
        createImage: () => ({
          get naturalWidth(): number {
            throw new Error("boom");
          },
          naturalHeight: 1080,
        }),
      },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => {
            throw new Error("boom");
          },
        }),
        createImage: () => ({
          get naturalWidth(): number {
            throw new Error("boom");
          },
          naturalHeight: 1080,
        }),
      },
      {
        fetch: cooperativeFetch(bytesFor("png")),
        createImage: () => ({
          naturalWidth: 1920,
          naturalHeight: 1080,
          decode: () => {
            throw new Error("boom");
          },
        }),
      },
    ];
    for (const environment of hostile) {
      // The claim under test is `resolves`, not a particular verdict: a
      // hostile environment must produce a REJECTION the settings UI can
      // render, never an exception that takes the page down.
      await expect(
        validateBackgroundImage("https://img.test/a.png", environment),
      ).resolves.toEqual(
        expect.objectContaining({
          ok: expect.any(Boolean),
        }),
      );
    }
  });

  it("reads a size defensively, so a throwing property is a rejection", async () => {
    // A plain `image.naturalWidth` here would propagate out of the function
    // and reject the promise, which in the settings UI is an error boundary
    // over somebody's settings form.
    const result = await validateBackgroundImage("https://img.test/a.png", {
      fetch: cooperativeFetch(bytesFor("png")),
      createImage: () => ({
        get naturalWidth(): number {
          throw new Error("boom");
        },
        naturalHeight: 1080,
      }),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a real payload whose decode() throws, because the size is real", async () => {
    // Deliberate leniency, and the reasoning is that the two facts disagree:
    // the bytes sniffed as a PNG and the element reports a genuine 1920x1080.
    // A `decode()` that throws on an already-sized image is a browser quirk,
    // not evidence of a bad file, and refusing a working photograph over it
    // would be the worse failure. The rejection cases are all "no size at
    // all", which is the only thing that is genuinely unknowable.
    const result = await validateBackgroundImage("https://img.test/a.png", {
      fetch: cooperativeFetch(bytesFor("png")),
      createImage: () => ({
        naturalWidth: 1920,
        naturalHeight: 1080,
        decode: () => {
          throw new Error("boom");
        },
      }),
    });
    expect(result).toEqual({
      ok: true,
      info: {
        url: "https://img.test/a.png",
        width: 1920,
        height: 1080,
        bytes: 64,
        format: "png",
      },
    });
  });

  it("checks the address before touching the network at all", async () => {
    // A rejected address must never become a request: an `http` or a
    // credentialed URL is refused on its own terms.
    let called = false;
    const spy: BackgroundImageFetch = async () => {
      called = true;
      throw new Error("should not be reached");
    };
    const result = await validateBackgroundImage("http://img.test/a.jpg", {
      fetch: spy,
      createImage: () => sizedImage(1920, 1080),
    });
    expect(rejection(result)).toBe("insecureScheme");
    expect(called).toBe(false);
  });

  it("passes the request through with CORS asked for and credentials withheld", async () => {
    // Not an assertion about politeness: a background host that receives the
    // session cookie has been handed a credential it has no business holding.
    let seen: unknown;
    const png = bytesFor("png");
    const result = await validateBackgroundImage("https://img.test/a.png", {
      fetch: async (_input, init) => {
        seen = init;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bufferOf(png),
        };
      },
      createImage: () => sizedImage(1920, 1080),
    });
    expect(seen).toEqual({ mode: "cors", credentials: "omit" });
    expect(result.ok).toBe(true);
  });
});

/* ==========================================================================
   EVERY REJECTION IS REACHABLE AND SPOKEN
   ========================================================================== */

describe("the rejection set", () => {
  it("has a distinct message in both dictionaries, for every reason", () => {
    // A rejection with no string is a rejection the user experiences as the
    // button doing nothing. A shared string is worse: "invalid image" tells
    // somebody nothing about whether to resize the file or fix the link.
    const seen = new Map<string, string>();
    for (const reason of BACKGROUND_REJECTIONS) {
      const key = BACKGROUND_REJECTION_KEYS[reason];
      expect(key, reason).toBe(`settings.backgroundError.${reason}`);

      for (const [locale, dictionary] of [
        ["vi", vi],
        ["en", en],
      ] as const) {
        const message = (dictionary.settings.backgroundError as Record<string, string>)[
          reason
        ];
        expect(message, `${locale}.${reason}`).toBeTypeOf("string");
        expect(message.trim().length, `${locale}.${reason}`).toBeGreaterThan(10);
        // Distinct within the locale, so no two failures read identically.
        const previous = seen.get(`${locale}:${message}`);
        expect(previous, `${locale}.${reason} duplicates ${previous}`).toBeUndefined();
        seen.set(`${locale}:${message}`, reason);
      }
    }
  });

  it("names all twelve reasons, so a new one cannot be added without a message", () => {
    expect([...BACKGROUND_REJECTIONS].sort()).toEqual(
      [
        "credentialsInUrl",
        "decodeFailed",
        "empty",
        "insecureScheme",
        "invalidUrl",
        "networkError",
        "tooLarge",
        "tooLong",
        "tooManyPixels",
        "tooSmall",
        "unavailable",
        "unsupportedType",
      ].sort(),
    );
  });
});

/* ==========================================================================
   THE LOAD DEADLINE

   `image.decode()` settles when the image arrives or the request fails.
   Neither event fires when a host accepts the connection and then sends
   nothing, which is what a wedged or rate-limiting image host looks like.
   Measured in a real browser before the deadline existed: the settings panel
   sat with Apply disabled and "Checking..." forever, no error, and no way out
   short of a reload.
   ========================================================================== */
describe("validateBackgroundImage load deadline", () => {
  it("gives up on an image that never settles, and says it is a network problem", async () => {
    // Never resolves, never rejects: the shape of a stalled host.
    const never = { naturalWidth: 0, naturalHeight: 0, decode: () => new Promise<never>(() => {}) };
    const result = await validateBackgroundImage("https://img.test/photo.png", {
      createImage: () => never,
      // Milliseconds rather than the shipped twelve, so the test proves the
      // deadline rather than merely waiting for it.
      timeoutMs: 20,
    });
    expect(rejection(result)).toBe("networkError");
  }, 2000);

  it("still accepts an image that arrives in time", async () => {
    // The regression the deadline could have caused: a bound that fires on a
    // working image would turn the feature into "nothing ever applies".
    const result = await validateBackgroundImage("https://img.test/photo.png", {
      createImage: () => sizedImage(1920, 1080),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("still rejects an image that fails outright", async () => {
    // The deadline must not swallow the fast, definite answers.
    const failing = {
      naturalWidth: 0,
      naturalHeight: 0,
      decode: async () => {
        throw new Error("decode failed");
      },
    };
    const result = await validateBackgroundImage("https://img.test/photo.png", {
      createImage: () => failing,
      timeoutMs: 1000,
    });
    expect(rejection(result)).toBe("networkError");
  });

  it("treats a stalled decode as a network problem, not a broken file", async () => {
    // The cooperative path sniffed real PNG bytes, so a decode failure here
    // would tell the user to go and inspect a file that is perfectly fine.
    // The bytes arrived; the element stalled. That is a network problem.
    const never = { naturalWidth: 0, naturalHeight: 0, decode: () => new Promise<never>(() => {}) };
    const result = await validateBackgroundImage("https://img.test/photo.png", {
      fetch: cooperativeFetch(bytesFor("png")),
      createImage: () => never,
      timeoutMs: 20,
    });
    expect(rejection(result)).toBe("networkError");
  }, 2000);

  it("falls back to the shipped deadline when none is supplied", () => {
    // A bounded constant, asserted so the number cannot quietly become
    // unbounded again.
    expect(BACKGROUND_LOAD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(BACKGROUND_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
