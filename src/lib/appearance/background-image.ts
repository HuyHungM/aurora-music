/**
 * Background image validation (Phase 53, §7, §8, §13, §49, §74).
 *
 * A user-supplied address is untrusted input that ends up in a stylesheet and
 * in a cookie, so it is checked up to four ways before it is ever accepted:
 *
 *   1. SYNTACTICALLY, with no network at all. Scheme, length, embedded
 *      credentials. This is the only check that can run on the server, and it
 *      is the one that decides whether a value is even a legal shape.
 *   2. BY DECODED TYPE, from magic bytes. Never from the file extension and
 *      never from `Content-Type`, both of which the origin controls. A `.png`
 *      that is really an SVG is a `.png` that is really an SVG.
 *   3. BY DIMENSIONS, from what the browser actually decoded. A 64x64 icon
 *      stretched across a 2560px display is a soft smear, and a 40-megapixel
 *      photo decoded as a CSS background is a memory cost nobody asked for.
 *   4. BY DECODE SUCCESS. An address that 404s, or that returns something the
 *      browser cannot decode, is rejected with a reason rather than stored
 *      and discovered later as an invisible background.
 *
 * CANDOUR ABOUT CHECK 2. Reading bytes requires CORS, and most image hosts do
 * not send it. So the byte sniff runs when the caller supplies a `fetch` and
 * the host cooperates, and is skipped when it does not - and in that case the
 * format verdict comes from the browser having decoded the image at all, which
 * is a weaker signal and is recorded as such. `info.format` and `info.bytes`
 * are `null` in that case rather than being guessed, so nothing downstream can
 * claim a check that did not happen. See `ARCHITECTURE.md` §20.2.
 *
 * The shipped panel does NOT supply a `fetch`: the application's CSP pins
 * `connect-src` to 'self', so a cross-origin fetch of a user-supplied address
 * could only be blocked and logged as a console violation. It always takes the
 * decode route. The fetch capability remains for callers whose CSP allows the
 * read.
 *
 * Like `pwa/platform.ts`, this module is pure and takes its browser
 * dependencies as arguments, so every branch below is reachable from a test
 * without a network or a real image.
 */

import { checkBackgroundUrl } from "./appearance";

/**
 * Re-exported so the validation vocabulary stays importable from the one module
 * that documents the four stages.
 *
 * The function itself lives in `./appearance` because the decoder needs it: a
 * cookie is attacker-controllable, so what comes back out of
 * `decodeAppearance` is put through the same check the settings form uses. This
 * alias exists so the two import sites are not a second thing to keep in step.
 */
export { checkBackgroundUrl, type UrlCheck } from "./appearance";

/* ==========================================================================
   LIMITS (§8)
   ========================================================================== */

/**
 * Transfer ceiling: 4 MiB.
 *
 * A background is decoration. At 4 MiB it can be the single largest response
 * in the application, which is why this is checked before the URL is stored
 * rather than discovered on a slow connection. Larger than one phone photo of
 * ordinary quality, and far below the 15-30 MB a modern camera produces, so
 * the cap costs a user nothing they would have chosen anyway.
 */
export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Smallest accepted image: 480 x 320.
 *
 * Not the display size - the smallest supported viewport is 360px wide - but
 * large enough that `background-size: cover` has real pixels to work with at
 * any breakpoint. Below this, a 2560px-wide display is upsampling.
 */
export const BACKGROUND_MIN_WIDTH = 480;
export const BACKGROUND_MIN_HEIGHT = 320;

/**
 * Largest accepted image: 16 megapixels.
 *
 * This one is a memory limit, not an aesthetic one, and the number is chosen
 * from what people actually have. A CSS background is decoded at its natural
 * size into an uncompressed buffer of roughly four bytes per pixel, so 16 MP is
 * about 64 MB held for as long as the layer exists.
 *
 * 16 MP rather than 8 because 8 MP refused 4K. 3840x2160 is 8.29 MP, so the
 * previous cap turned away the most common "good" photograph there is, on a
 * display size this application explicitly supports (2560px ultrawide). 12 MP
 * is the most common phone camera resolution and 16 MP admits essentially every
 * real photograph, while still refusing the 24-100 MP a modern mirrorless
 * produces - which is the case the limit exists for, since that is what turns
 * into several hundred megabytes of decoded buffer.
 *
 * The 4 MiB transfer cap is the cheaper first filter and usually fires first:
 * a 24 MP JPEG is over 5 MB at ordinary quality, so most oversized images are
 * refused before they are ever fetched in full.
 *
 * The limit is on the product of the dimensions rather than on either axis,
 * because a 20000x400 panorama decodes no cheaper than a 4000x5000 portrait.
 */
export const BACKGROUND_MAX_PIXELS = 16_000_000;

/** Refuse any single axis beyond this, independently of the pixel product. */
export const BACKGROUND_MAX_EDGE = 8192;

/**
 * How long the browser is given to produce the image before we give up on it.
 *
 * WHY THIS EXISTS. `image.decode()` - and the `load`/`error` handlers it falls
 * back to - settle when the image arrives OR when the request fails. There is a
 * third case they do not cover: a host that accepts the connection and then
 * sends nothing at all. Neither event fires, so the promise never settles.
 *
 * Measured in a browser before this constant existed, by stalling the response
 * (which is what a wedged or rate-limiting image host actually looks like):
 *
 *   T+2s   Apply disabled, label "Checking…"
 *   T+14s  Apply disabled, label "Checking…"
 *   T+34s  Apply disabled, label "Checking…", no error shown
 *
 * The panel was left with a permanently dead control and no explanation, and
 * the only way out was a reload. The background itself was never at fault: the
 * previous selection stayed painted and the typed address stayed in the field,
 * so nothing was lost - the UI simply could not report a wait that never ends.
 *
 * 12 seconds is chosen against the size limit rather than the connection: 4 MiB
 * is the transfer ceiling, so on any connection fast enough to be usable that
 * is comfortably inside this budget, while a host that has produced nothing in
 * 12 seconds is not going to. Long enough that a slow mobile network with a
 * large photograph is not failed for being slow; short enough that the user is
 * given an answer while they are still looking at the form.
 */
export const BACKGROUND_LOAD_TIMEOUT_MS = 12_000;

/* ==========================================================================
   FORMATS
   ========================================================================== */

export const IMAGE_FORMATS = ["webp", "jpeg", "png", "avif", "gif"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/**
 * Identifies a raster format from its leading bytes.
 *
 * Deliberately not a MIME parser and deliberately not exhaustive: the goal is
 * to answer "is this one of the four formats we ship as backgrounds", and a
 * format this does not recognise is rejected rather than guessed at. Each
 * signature is the smallest prefix that cannot be produced by another format
 * in the list.
 *
 * AVIF and HEIC share the ISO-BMFF `ftyp` box, so the brand list is checked
 * rather than the box alone - otherwise a `.heic` would be admitted as AVIF on
 * the strength of its container and then fail to decode.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 12) {
    return null;
  }
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));

  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return "webp";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (ascii(0, 4) === "GIF8") {
    return "gif";
  }
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") {
      return "avif";
    }
    // `mif1`/`msf1` is the generic HEIF brand; the compatible-brand list that
    // follows it is where a real AVIF declares itself.
    if (brand === "mif1" || brand === "msf1" || brand === "heic" || brand === "heix") {
      const scan = Math.min(bytes.length - 4, 64);
      for (let offset = 12; offset + 4 <= scan; offset += 4) {
        const candidate = ascii(offset, 4);
        if (candidate === "avif" || candidate === "avis") {
          return "avif";
        }
      }
    }
  }
  return null;
}

/* ==========================================================================
   RESULTS
   ========================================================================== */

/**
 * Every way a background can be refused. Each is a distinct message in both
 * dictionaries: "that image is too big" and "that file is not an image" are
 * different problems with different fixes, and collapsing them into one
 * "invalid image" string is how a user ends up guessing.
 */
export const BACKGROUND_REJECTIONS = [
  "empty",
  "tooLong",
  "invalidUrl",
  "insecureScheme",
  "credentialsInUrl",
  "unsupportedType",
  "tooLarge",
  "tooSmall",
  "tooManyPixels",
  "decodeFailed",
  "networkError",
  "unavailable",
] as const;

export type BackgroundRejection = (typeof BACKGROUND_REJECTIONS)[number];

/** Message key in `settings.background.*` for each rejection. */
export const BACKGROUND_REJECTION_KEYS: Record<BackgroundRejection, string> = {
  empty: "settings.backgroundError.empty",
  tooLong: "settings.backgroundError.tooLong",
  invalidUrl: "settings.backgroundError.invalidUrl",
  insecureScheme: "settings.backgroundError.insecureScheme",
  credentialsInUrl: "settings.backgroundError.credentialsInUrl",
  unsupportedType: "settings.backgroundError.unsupportedType",
  tooLarge: "settings.backgroundError.tooLarge",
  tooSmall: "settings.backgroundError.tooSmall",
  tooManyPixels: "settings.backgroundError.tooManyPixels",
  decodeFailed: "settings.backgroundError.decodeFailed",
  networkError: "settings.backgroundError.networkError",
  unavailable: "settings.backgroundError.unavailable",
};

export interface BackgroundImageInfo {
  width: number;
  height: number;
  /** `null` when the host withheld the bytes behind an opaque CORS response. */
  bytes: number | null;
  /** `null` for the same reason; see the module docstring. */
  format: ImageFormat | null;
  /** The URL after trimming, which is what gets stored. */
  url: string;
}

export type BackgroundImageResult =
  | { ok: true; info: BackgroundImageInfo }
  | { ok: false; reason: BackgroundRejection };


/** Pure, so the bounds are testable without constructing an image. */
export function checkBackgroundDimensions(
  width: number,
  height: number,
): BackgroundRejection | null {
  // A size that is not a positive number means the browser never produced an
  // image, which is a decode failure and not a size complaint. The callers
  // that care about the difference check for `width <= 0` themselves and turn
  // it into `networkError` before getting here.
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return "decodeFailed";
  }
  if (width <= 0 || height <= 0) {
    return "decodeFailed";
  }
  if (width < BACKGROUND_MIN_WIDTH || height < BACKGROUND_MIN_HEIGHT) {
    return "tooSmall";
  }
  if (width > BACKGROUND_MAX_EDGE || height > BACKGROUND_MAX_EDGE) {
    return "tooSmall";
  }
  if (width * height > BACKGROUND_MAX_PIXELS) {
    return "tooManyPixels";
  }
  return null;
}

/* ==========================================================================
   ORCHESTRATION
   ========================================================================== */

/**
 * The minimum `fetch` shape this module uses. Structural, so the browser's own
 * `fetch` satisfies it and a test can hand in two lines of stub.
 *
 * `init` is narrower than `RequestInit` on purpose, and the narrowing is the
 * documentation: the only two things this module ever sends are `mode: "cors"`
 * and `credentials: "omit"`, so those are the only two an implementation has to
 * understand. The literal types also mean the real `fetch` accepts the value
 * with no cast, which is the property that makes this an interface rather than
 * a wrapper type.
 */
export type BackgroundImageFetch = (
  input: string,
  init?: { mode?: "cors"; credentials?: "omit" },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * The minimum image shape this module reads.
 *
 * `onload`/`onerror` take an `Event` because that is what the DOM handlers
 * are typed as; a zero-argument signature here would make a real
 * `HTMLImageElement` unassignable to this type, which is the opposite of what
 * an injection interface is for.
 */
export interface BackgroundImageElement {
  decode?: () => Promise<unknown>;
  onload?: ((event: Event) => void) | null;
  onerror?: ((event: Event) => void) | null;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * The browser surface this module needs, injected so the whole flow is
 * testable. Every member is optional: a missing one is a rejection
 * (`unavailable`), never a crash, because validation runs in the settings UI
 * and a thrown error there would take the page down with it (§74).
 */
export interface BackgroundImageEnvironment {
  fetch?: BackgroundImageFetch;
  /** Present in every browser; used for the no-CORS decode path. */
  createImage?: (src: string) => BackgroundImageElement;
  /**
   * Overrides `BACKGROUND_LOAD_TIMEOUT_MS`.
   *
   * Injectable rather than module-level mutable state, so a test can prove the
   * timeout path in milliseconds and so a caller with a genuinely slow
   * connection budget can be more generous without waiting on a wall clock.
   */
  timeoutMs?: number;
}

/**
 * Reads an image's natural size without trusting the property.
 *
 * A plain `image.naturalWidth` can throw - a detached or half-constructed
 * element, a hostile stub - and this module's contract is that it never throws,
 * because its caller is the settings UI and an exception there takes the page
 * down. `null` means "no size could be read", which each caller turns into the
 * rejection that fits its path.
 */
function readSize(image: BackgroundImageElement): {
  width: number;
  height: number;
} | null {
  try {
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return null;
  }
}

/**
 * How an attempt to make an image usable ended.
 *
 * `failed` and `timedOut` are separate because the advice differs: a failure
 * means the bytes arrived and the browser rejected them, while a timeout means
 * they never arrived. Collapsing them would tell somebody whose host is
 * down to go and check their file.
 */
type SettleOutcome = "loaded" | "failed" | "timedOut";

/**
 * Waits for an image to be usable, without assuming a decode path, and WITHOUT
 * waiting forever.
 *
 * `decode()` is preferred because it settles only once the image is genuinely
 * ready to paint, which is the actual question being asked here. The
 * load/error handlers are the fallback for an element without it. All three are
 * guarded by a `done` latch because they can race: an element that has already
 * fired `onload` by the time these are attached can call both, and a second
 * `resolve` is harmless but a lost `resolve` is a hung promise.
 *
 * The timer is what makes this total. Without it, a host that accepts the
 * connection and sends nothing leaves the promise unsettled forever - see
 * `BACKGROUND_LOAD_TIMEOUT_MS` for the measurement that motivated it. The
 * timer is cleared on every exit path, so a settled image never leaves one
 * pending to fire into a dead promise.
 */
async function settleImage(
  image: BackgroundImageElement,
  timeoutMs: number,
): Promise<SettleOutcome> {
  return new Promise<SettleOutcome>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: SettleOutcome) => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(value);
    };
    // Armed before any decode work so a `decode()` that throws synchronously
    // below still leaves a timer that `finish` owns and clears.
    timer = setTimeout(() => finish("timedOut"), timeoutMs);
    try {
      if (typeof image.decode === "function") {
        void image.decode().then(
          () => finish("loaded"),
          () => finish("failed"),
        );
      } else if (image.onload || image.onerror) {
        image.onload = () => finish("loaded");
        image.onerror = () => finish("failed");
      } else {
        finish(image.naturalWidth > 0 ? "loaded" : "failed");
      }
    } catch {
      finish("failed");
    }
  });
}

/**
 * Validates a candidate background address end to end.
 *
 * Two paths, converging on one verdict:
 *
 *   - COOPERATIVE HOST. `fetch` with `mode: "cors"`. Bytes are available, so
 *     the format is sniffed from them and the transfer size is enforced. This
 *     is the path every shipped preset and most CDNs take.
 *   - OPAQUE HOST. The fetch is refused, or returns a non-OK status. The
 *     image is then loaded through an `HTMLImageElement` and `decode()`d
 *     instead, which needs no CORS because nothing is read back out of it.
 *     The browser's own successful decode IS the type check; dimensions are
 *     real; `format` and `bytes` stay `null`.
 *
 * A network error and a decode error are reported differently, because the
 * first is retryable and the second is not: a user whose address has a typo
 * and a user whose host is briefly down need different advice.
 */
export async function validateBackgroundImage(
  raw: unknown,
  env: BackgroundImageEnvironment,
): Promise<BackgroundImageResult> {
  const urlCheck = checkBackgroundUrl(raw);
  if (!urlCheck.ok) {
    return { ok: false, reason: urlCheck.reason };
  }
  const { url } = urlCheck;

  if (typeof env.fetch === "function") {
    const cooperative = await tryCooperative(url, env);
    if (cooperative) {
      return cooperative;
    }
  }

  if (typeof env.createImage !== "function") {
    return { ok: false, reason: "unavailable" };
  }

  let image: BackgroundImageElement;
  try {
    image = env.createImage(url);
  } catch {
    return { ok: false, reason: "invalidUrl" };
  }

  let size = readSize(image);
  const loaded = size !== null && size.width > 0 && size.height > 0;
  if (!loaded) {
    const settled = await settleImage(
      image,
      env.timeoutMs ?? BACKGROUND_LOAD_TIMEOUT_MS,
    );
    // Re-read: `decode()` may have been what populated the size.
    size = readSize(image);
    if (settled === "timedOut") {
      // The host never finished sending. Nothing is wrong with the image, so
      // this is a network problem rather than a decode failure - and reporting
      // it is what lets the panel stop waiting and finally tell the user
      // something, instead of holding the button disabled indefinitely.
      return { ok: false, reason: "networkError" };
    }
    if (settled === "failed" && (size === null || size.width <= 0)) {
      // Nothing arrived and nothing decoded. Distinguished from a decode
      // failure of a real payload only by the absence of any dimensions, so
      // it is reported as a network problem, which is the likelier cause.
      return { ok: false, reason: "networkError" };
    }
  }

  if (size === null) {
    // A readable image whose size cannot be read at all. Nothing downstream
    // can be trusted about it, so it is not stored.
    return { ok: false, reason: "decodeFailed" };
  }
  const rejected = checkBackgroundDimensions(size.width, size.height);
  if (rejected) {
    return { ok: false, reason: rejected };
  }
  return {
    ok: true,
    info: { url, width: size.width, height: size.height, bytes: null, format: null },
  };
}

/**
 * The CORS path, or `null` to fall through to the opaque path.
 *
 * `null` means "this host would not cooperate" and is deliberately NOT a
 * rejection: the caller has a second, CORS-free route that still produces a
 * real verdict. Only a definitive answer - too large, wrong format, undecodable
 * - comes back as a rejection here.
 */
async function tryCooperative(
  url: string,
  env: BackgroundImageEnvironment,
): Promise<BackgroundImageResult | null> {
  const cooperativeFetch = env.fetch;
  if (typeof cooperativeFetch !== "function") {
    return null;
  }
  let response: Awaited<ReturnType<BackgroundImageFetch>>;
  try {
    response = await cooperativeFetch(url, {
      mode: "cors",
      // Never attach the session to a third-party image request.
      credentials: "omit",
    });
  } catch {
    // A rejected CORS fetch and a DNS failure are indistinguishable from
    // here. Both mean "this host will not cooperate", and the image path
    // below still gets a real verdict, so this is not a rejection.
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength > BACKGROUND_MAX_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }
  const format = sniffImageFormat(bytes);
  if (format === null) {
    return { ok: false, reason: "unsupportedType" };
  }

  if (typeof env.createImage !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  let image: BackgroundImageElement;
  try {
    image = env.createImage(url);
  } catch {
    return { ok: false, reason: "invalidUrl" };
  }
  const settled = await settleImage(
    image,
    env.timeoutMs ?? BACKGROUND_LOAD_TIMEOUT_MS,
  );
  const size = readSize(image);
  if (size === null) {
    return { ok: false, reason: "decodeFailed" };
  }
  if (settled === "timedOut") {
    // The bytes were read, but the browser never finished decoding them. That
    // is a stalled element rather than a malformed payload, so it is reported
    // as a network problem - a decode failure here would send the user to
    // inspect a file that is actually fine.
    return { ok: false, reason: "networkError" };
  }
  if (settled === "failed" && size.width <= 0) {
    // The bytes sniffed as a real image but the browser would not decode
    // them. That is a truncated or deliberately malformed payload, not a
    // network problem, and it must not be stored.
    return { ok: false, reason: "decodeFailed" };
  }
  const rejected = checkBackgroundDimensions(size.width, size.height);
  if (rejected) {
    return { ok: false, reason: rejected };
  }
  return {
    ok: true,
    info: { url, width: size.width, height: size.height, bytes: bytes.byteLength, format },
  };
}
