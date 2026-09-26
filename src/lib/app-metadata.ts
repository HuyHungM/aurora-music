/**
 * Canonical application identity and installable-web-app metadata (Phase 51).
 *
 * ONE source of truth for every place Aurora states its own identity: the
 * web app manifest, the root layout's `<title>`/description/viewport, the
 * Open Graph surface, the install affordance, and the icons. Nothing here
 * may be duplicated as a literal anywhere else — the tests in
 * `__tests__/app-metadata.test.ts` fail if a second copy appears or if the
 * manifest stops matching these values.
 *
 * Client-safe by construction: no Node APIs, no filesystem, no secrets, no
 * browser APIs. `appVersion` is deliberately absent because reading
 * `package.json` would either pull the whole manifest into the client bundle
 * or require a server-only module; the version is exposed once, server-side,
 * by `/api/app-config` (see `src/app/api/app-config/route.ts`).
 *
 * Colour provenance: `APP_THEME_COLOR` is the canvas expressed in hex
 * because `theme_color` / `background_color` and the iOS status-bar style
 * are consumed by browsers and by the OS splash screen, where the design
 * system's `oklch()` is not universally honoured. It corresponds to
 * `--p-neutral-0` / `--canvas-base` in `globals.css`
 * (`oklch(0.145 0.012 285)`); see `app-metadata.test.ts`, which pins the
 * relationship instead of trusting a comment.
 */

import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/lib/i18n/locale";

/** Canonical product name. Used verbatim in the launcher and the title. */
export const APP_NAME = "Aurora Music";

/**
 * Launcher-surface name. Deliberately shorter than APP_NAME because OS
 * launchers truncate; "Aurora" is the product's own short form and is
 * never expanded into a second brand ("Aurora Player", "Aurora Web", ...).
 */
export const APP_SHORT_NAME = "Aurora";

/**
 * Per-locale descriptions. Both are factual: Aurora streams and discovers
 * music through YouTube, Spotify and Deezer metadata. No unverifiable
 * superlatives ("the best music app"), no invented feature claims.
 */
export const APP_DESCRIPTIONS: Record<Locale, string> = {
  vi: "Nghe và khám phá âm nhạc cùng Aurora",
  en: "Stream and discover music with Aurora",
};

export function appDescription(locale: Locale): string {
  return APP_DESCRIPTIONS[locale];
}

/**
 * The description the cached manifest carries. Resolved once, here, from the
 * same dictionary the page metadata uses, so the launcher blurb and the
 * `<meta name="description">` can never describe the product differently.
 */
export const APP_DESCRIPTION_BY_MANIFEST_LOCALE = APP_DESCRIPTIONS[DEFAULT_LOCALE];

/** Canvas colour for browser chrome, the splash screen and the manifest. */
export const APP_THEME_COLOR = "#08070d";

/** Canvas colour painted before the first frame, to avoid a white flash. */
export const APP_BACKGROUND_COLOR = "#08070d";

/**
 * Stable application identifier (RULE 16). It MUST NOT change between
 * deployments: browsers key the installed application on it, so a new
 * value makes the same site look like a different app and strands the
 * previously installed copy. Derived from the product's own domain-shaped
 * identity, never from a build hash, route or environment value.
 */
export const APP_ID = "/";

/**
 * Launch target. A bare path with no query, hash or provider state, so a
 * cold start never depends on a temporary parameter.
 */
export const APP_START_URL = "/";

/** Every application route lives under the root path. */
export const APP_SCOPE = "/";

/** The path Next.js serves `app/manifest.ts` from. */
export const APP_MANIFEST_PATH = "/manifest.webmanifest";

/**
 * Display strategy. `standalone` is the primary mode; the override list is
 * ordered best-first so a browser that supports a richer mode takes it and
 * every other browser degrades down the list to `browser` (RULE 19).
 *
 * `window-controls-overlay` is deliberately NOT enabled: it is only honoured
 * by Chromium desktop, and enabling it would move the app's own header under
 * the OS title bar without any layout work to keep that area usable
 * (RULE 20). It is left off rather than shipped broken.
 */
export const APP_DISPLAY = "standalone";

export const APP_DISPLAY_OVERRIDE = [
  "standalone",
  "minimal-ui",
  "browser",
] as const;

/**
 * Aurora is a responsive web app: it is equally usable in portrait and
 * landscape, on phones, tablets and desktops. No orientation lock
 * (RULE 21) — locking would be an artificial product restriction.
 */
export const APP_ORIENTATION = "any";

/** Only truthful classifications. See `PLATFORM_CATEGORIES` in the manifest. */
export const APP_CATEGORIES = ["music", "entertainment"] as const;

/**
 * Manifest `lang`/`dir`. The manifest is a cached, request-independent
 * document, so it advertises the shipped default rather than the current
 * session's locale; per-locale copy still reaches the user through the
 * server-rendered page and the install affordance, which are request-aware.
 * Vietnamese is the canonical default (RULE 47).
 */
export const APP_MANIFEST_LOCALE = DEFAULT_LOCALE;
export const APP_MANIFEST_DIR = "ltr";

export interface AppIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: "image/png";
  readonly purpose: "any" | "maskable";
}

/**
 * Launcher icon set. Dimensions and maskable safe-zone fit are verified by
 * `app-metadata.test.ts`, which reads the real PNG headers rather than
 * trusting the filenames.
 */
export const APP_ICONS: readonly AppIcon[] = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  {
    src: "/icons/icon-maskable-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];

/**
 * Home-screen / launcher shortcut. iOS renders a single icon from the
 * largest `any` icon; the `192` entry is the size that survives the
 * downscale best on the surfaces that use it.
 */
export const APP_APPLE_TOUCH_ICON = "/icons/icon-192.png";

export interface AppShortcut {
  readonly name: string;
  readonly short_name: string;
  readonly url: string;
  readonly icons?: readonly AppIcon[];
}

/**
 * Shortcuts, restricted to routes that provably exist (RULE 45). Each
 * `url` is asserted against the real route table by `app-metadata.test.ts`,
 * so a shortcut can never outlive the route it points at. There is no
 * `/settings` route in Aurora, so there is deliberately no settings
 * shortcut, and no Liked Tracks shortcut: liked tracks live inside
 * `/library`, so a second entry pointing at the same page would be noise.
 *
 * Labels are the manifest-locale strings, matching the `lang` the manifest
 * declares. RULE 47 forbids shipping English copy in a document that
 * advertises itself as Vietnamese; a launcher renders these labels next to
 * the icon, so a half-translated manifest is visible.
 */
export const APP_SHORTCUTS: readonly AppShortcut[] = [
  { name: "Tìm kiếm", short_name: "Tìm kiếm", url: "/search" },
  { name: "Thư viện", short_name: "Thư viện", url: "/library" },
  { name: "Radio", short_name: "Radio", url: "/radio" },
];

/** Locales the application ships, re-exported for the metadata surface. */
export const APP_SUPPORTED_LOCALES = LOCALES;

/** Media Session artwork uses the same identity as the launcher. */
export const APP_ICON_SOURCES = APP_ICONS.map((icon) => icon.src);
