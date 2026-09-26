import { NextResponse } from "next/server";

import { jsonResponse } from "@/lib/api/transport";
import { getAppVersion } from "@/lib/app-version";
import {
  APP_MANIFEST_PATH,
  APP_NAME,
  APP_SCOPE,
  APP_SHORT_NAME,
  APP_START_URL,
  APP_SUPPORTED_LOCALES,
  appDescription,
} from "@/lib/app-metadata";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";

// Static by construction: the body depends only on the build, never on a
// request, a session, or the database. Safe to cache at the edge and safe for
// a load balancer to hit.
export const dynamic = "force-static";

/**
 * Contract version of THIS endpoint's response shape, independent of the
 * application version. A client wrapper can pin the shape it understands.
 */
const APP_CONFIG_API_VERSION = 1;

/**
 * Public route patterns a future native wrapper can map onto internal
 * navigation. Only routes that exist today are listed, and the two
 * `/e2e-*` fixture routes are deliberately excluded: they are test scaffolding,
 * not product surface, and advertising them would invite a wrapper to link
 * users into a deterministic fixture catalog.
 *
 * The URLs are ordinary same-origin https paths, so every one of them already
 * works in a browser and as a share link — there is no app-only URL that
 * cannot fall back to normal web navigation (RULE 42, RULE 89).
 *
 * `/settings` is listed because it is a real route and a real destination
 * (Phase 53). It is not a music route, so a wrapper wanting to decide whether
 * to surface it can and should: the pattern is here, and how a client chooses
 * to treat a non-content route is the client's decision, not an absence of
 * information.
 */
const DEEP_LINK_PATTERNS = [
  "/",
  "/search",
  "/radio",
  "/library",
  "/library/playlists/{id}",
  "/track/{id}",
  "/album/{id}",
  "/artist/{id}",
  "/playlist/share/{token}",
  "/settings",
] as const;

interface AppConfigBody {
  appName: string;
  appShortName: string;
  appDescription: string;
  appVersion: string;
  apiVersion: number;
  defaultLocale: string;
  supportedLocales: readonly string[];
  /** Aurora ships as a web application; a future wrapper is not implied. */
  platform: "web";
  supportedPlatforms: readonly string[];
  startUrl: string;
  scope: string;
  manifestPath: string;
  deepLinkPatterns: readonly string[];
  share: {
    /** Public, token-addressed share links. No playlist data is served here. */
    deepLink: "/playlist/share/{token}";
    /** Measured in the browser; the server cannot know, so it is not claimed. */
    webShare: "client-detected";
  };
  /**
   * Capabilities the *server contract* guarantees. Anything that depends on
   * the user's runtime (Media Session, Web Share, notifications, whether the
   * app is currently installed) is deliberately absent: it is measured in the
   * browser by `@/lib/pwa/platform`, and a server-side claim would be an
   * assertion this endpoint cannot verify (RULE 51, RULE 53).
   */
  capabilities: {
    installable: boolean;
    serviceWorkerShell: boolean;
    offlineShell: boolean;
    /** No offline download feature exists; never advertise one. */
    offlineAudio: false;
    /** No push service is implemented. */
    pushNotifications: false;
  };
}

/**
 * Safe, unauthenticated client configuration (Phase 51, RULE 86).
 *
 * There was no existing canonical configuration endpoint — `/api/health`
 * deliberately exposes nothing but liveness — so this is a new one rather than
 * a duplication.
 *
 * What it must never contain, and does not: provider API keys, OAuth secrets,
 * signed playback URLs, user or playlist data, environment values, internal
 * filesystem paths, or stack traces. Every field below is a compile-time
 * literal or the application version. It is safe to call before sign-in, from
 * a native wrapper, and from a load balancer.
 */
export async function GET(request?: Request): Promise<NextResponse<AppConfigBody>> {
  const body: AppConfigBody = {
    appName: APP_NAME,
    appShortName: APP_SHORT_NAME,
    appDescription: appDescription(DEFAULT_LOCALE),
    appVersion: getAppVersion(),
    apiVersion: APP_CONFIG_API_VERSION,
    defaultLocale: DEFAULT_LOCALE,
    supportedLocales: APP_SUPPORTED_LOCALES,
    platform: "web",
    supportedPlatforms: ["web"],
    startUrl: APP_START_URL,
    scope: APP_SCOPE,
    manifestPath: APP_MANIFEST_PATH,
    deepLinkPatterns: DEEP_LINK_PATTERNS,
    share: {
      deepLink: "/playlist/share/{token}",
      webShare: "client-detected",
    },
    capabilities: {
      installable: true,
      serviceWorkerShell: true,
      offlineShell: true,
      offlineAudio: false,
      pushNotifications: false,
    },
  };
  // Correlation id in a header only. This body is a published public contract
  // (`AppConfigBody`), and a wrapper pins the shape it understands; adding a
  // per-request field to it would make every response differ.
  return jsonResponse(body, { request });
}
