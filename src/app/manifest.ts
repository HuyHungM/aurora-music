import type { MetadataRoute } from "next";

import {
  APP_BACKGROUND_COLOR,
  APP_CATEGORIES,
  APP_DESCRIPTION_BY_MANIFEST_LOCALE,
  APP_DISPLAY,
  APP_DISPLAY_OVERRIDE,
  APP_ICONS,
  APP_ID,
  APP_MANIFEST_DIR,
  APP_MANIFEST_LOCALE,
  APP_NAME,
  APP_ORIENTATION,
  APP_SCOPE,
  APP_SHORTCUTS,
  APP_SHORT_NAME,
  APP_START_URL,
  APP_THEME_COLOR,
} from "@/lib/app-metadata";

/**
 * Canonical web app manifest (Phase 51).
 *
 * Framework-native (`app/manifest.ts`) rather than a static file in
 * `public/`, so every field is derived from `@/lib/app-metadata` — the one
 * place Aurora states its own identity — and is type-checked against
 * `MetadataRoute.Manifest`. Next.js serves this at `/manifest.webmanifest`,
 * which is the same URL the previous static file used, so the `<link
 * rel="manifest">` in the root layout and any installed copy are unaffected.
 *
 * This route is a special Route Handler and is cached by default: it
 * declares no request-time API, so every visitor receives byte-identical
 * metadata. That is deliberate — the manifest is the application's stable
 * identity and must not vary per request, session or build (RULE 16).
 *
 * Replaces `public/manifest.webmanifest`, which was removed rather than left
 * in place: two manifest sources would let the launcher's identity and the
 * application's identity drift apart (RULE 11, RULE 81).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: APP_ID,
    name: APP_NAME,
    short_name: APP_SHORT_NAME,
    description: APP_DESCRIPTION_BY_MANIFEST_LOCALE,
    lang: APP_MANIFEST_LOCALE,
    dir: APP_MANIFEST_DIR,
    start_url: APP_START_URL,
    scope: APP_SCOPE,
    display: APP_DISPLAY,
    display_override: [...APP_DISPLAY_OVERRIDE],
    orientation: APP_ORIENTATION,
    theme_color: APP_THEME_COLOR,
    background_color: APP_BACKGROUND_COLOR,
    categories: [...APP_CATEGORIES],
    icons: APP_ICONS.map((icon) => ({ ...icon })),
    shortcuts: APP_SHORTCUTS.map((shortcut) => ({
      name: shortcut.name,
      short_name: shortcut.short_name,
      url: shortcut.url,
    })),
  };
}
