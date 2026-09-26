"use strict";
/**
 * Aurora Music application-shell service worker (Phase 20).
 *
 * Scope: static shell delivery ONLY. This worker is not part of the
 * playback engine: it never resolves, proxies, or caches audio, and it
 * never touches provider, auth, or user data.
 *
 * Classification (explicit, conservative — default is network passthrough):
 * - same-origin `/_next/static/*` (hashed, immutable) ... cache-first
 * - top-level navigations ........................... network-first,
 *   offline -> built-in fallback page (no HTML is ever cached, so no
 *   personalized page can leak across users or sessions)
 * - everything else (POST, /api/*, cross-origin incl. provider hosts
 *   and playback hosts, server actions, images) .... network passthrough
 *   with zero worker overhead
 *
 * Hard exclusions (never intercepted beyond identification, never cached):
 * googlevideo playback hosts, authenticated/API routes, POST requests.
 *
 * Versioning: a single versioned static cache; activation deletes any
 * older `aurora-` caches and never touches foreign caches.
 *
 * Update flow (Phase 51): a new worker does NOT skip waiting. It parks in
 * the `waiting` state and the page hands over control at `pagehide` — the
 * moment the current document is going away anyway. Taking control
 * mid-session would swap the worker underneath a running page whose hashed
 * chunks belong to the previous build, and Aurora is a music player where
 * the session must survive a deploy. The consequence is deliberate and
 * predictable: a new build is picked up on the next launch, never while the
 * user is listening.
 */

const AURORA_SW_VERSION = "aurora-sw-v2";
const STATIC_CACHE = `${AURORA_SW_VERSION}:static`;
const PLAYBACK_HOST_SUFFIX = "googlevideo.com";
const LOCALE_COOKIE = "aurora-locale";
const DEFAULT_LOCALE = "vi";

/** Message the page sends to hand over control at a safe moment. */
const ACTIVATE_MESSAGE = "aurora:activate";

/** Message the page sends to tell the worker which language the visitor chose. */
const LOCALE_MESSAGE = "aurora:locale";

/**
 * Where the worker keeps the visitor's language, and why not the cookie.
 *
 * MEASURED, not assumed: on a Chromium navigation the worker receives a request
 * with `credentials: "include"` and `mode: "navigate"` whose header set is
 *
 *   accept, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform,
 *   upgrade-insecure-requests, user-agent
 *
 * with NO `cookie` header and no `accept-language`, even though
 * `document.cookie` in the very page making that request is populated.
 * Chromium attaches cookies at the network layer, below the point where the
 * service worker's `Request` object is built. So reading the locale cookie out
 * of the navigation request - the obvious implementation - silently always
 * yields the default locale in the most common browser on earth. That is the
 * bug the E2E test kept reporting, and the test was right.
 *
 * The page CAN read the cookie, so the page tells the worker, and the worker
 * persists it. Cache Storage is the store: it is already in use here, it
 * survives the worker being killed - which is exactly when a visitor needs the
 * offline page - and it needs no dependency and no IndexedDB schema.
 *
 * The cookie is still read as a fallback, because it costs nothing and it is
 * the only source on a browser that does expose the header.
 */
const META_CACHE = `${AURORA_SW_VERSION}:meta`;
const META_LOCALE_URL = "/__aurora-locale";

/** Locales the worker will accept. Anything else is the default. */
function normalizeLocale(value) {
  return value === "en" ? "en" : DEFAULT_LOCALE;
}

/** Localized offline copy. Vietnamese is the shipped default, so it is the
 *  fallback when the visitor's cookie is absent or unrecognised — the page
 *  is never shown English text to a Vietnamese default-locale user. */
const OFFLINE_COPY = {
  vi: {
    lang: "vi",
    title: "Bạn đang ngoại tuyến",
    body: "Aurora vẫn có thể mở, nhưng nghe nhạc cần có kết nối internet.",
    retry: "Thử lại",
    reload: "Tải lại",
  },
  en: {
    lang: "en",
    title: "You're offline",
    body: "Aurora can still open, but music playback requires an internet connection.",
    retry: "Retry",
    reload: "Reload",
  },
};

function offlineCopy(locale) {
  return OFFLINE_COPY[locale] === OFFLINE_COPY.en
    ? OFFLINE_COPY[locale]
    : OFFLINE_COPY[DEFAULT_LOCALE];
}

/**
 * Persists the visitor's language, as told to us by the page.
 *
 * Never rejects: a failure here must not surface as an unhandled rejection in
 * the worker's event loop, and the next navigation will simply re-ask.
 */
async function rememberLocale(locale) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(
      META_LOCALE_URL,
      new Response(normalizeLocale(locale), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  } catch {
    // Storage unavailable (private mode, quota). The offline page falls back
    // to the default locale, which is the shipped one.
  }
}

/** The language the page last told us about, or `null` if it never has. */
async function readRememberedLocale() {
  try {
    const cache = await caches.open(META_CACHE);
    const hit = await cache.match(META_LOCALE_URL);
    if (!hit) {
      return null;
    }
    return normalizeLocale((await hit.text()).trim());
  } catch {
    return null;
  }
}

/**
 * Reads the locale preference off the navigation request. Same-origin
 * navigations carry the `Cookie` header, and the worker sees the request that
 * the browser is actually making, so this costs no extra round-trip and no
 * cache read. Any failure resolves to the shipped default rather than
 * rejecting the navigation.
 */
function localeFromRequest(request) {
  try {
    const raw = request && request.headers && request.headers.get
      ? request.headers.get("cookie")
      : null;
    if (typeof raw !== "string" || raw.length === 0) {
      return DEFAULT_LOCALE;
    }
    for (const part of raw.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === LOCALE_COOKIE) {
        const value = decodeURIComponent(rest.join("=")).trim();
        return value === "en" ? "en" : DEFAULT_LOCALE;
      }
    }
  } catch {
    // A malformed Cookie header must never break the fallback page.
  }
  return DEFAULT_LOCALE;
}

/**
 * Reads the locale preference for the offline page.
 *
 * Order matters. The remembered value comes first because it is the ONLY one
 * that works on Chromium (see `META_CACHE`); the cookie is consulted second
 * because it is free and it is the only source on a browser that exposes the
 * header. Either way the answer is a supported locale, never raw input.
 */
async function resolveOfflineLocale(request) {
  const remembered = await readRememberedLocale();
  if (remembered) {
    return remembered;
  }
  return localeFromRequest(request);
}

function offlineHtml(locale) {
  const copy = offlineCopy(locale);
  return `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${copy.title} — Aurora Music</title>
<style>
  body { margin: 0; background: #08070d; color: #f4f2ff;
    font-family: system-ui, sans-serif; display: grid;
    place-items: center; min-height: 100vh; }
  main { text-align: center; padding: 2rem; max-width: 28rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  p { color: #8b86a0; line-height: 1.6; }
  a { color: #a78bfa; }
</style>
</head>
<body><main><h1>${copy.title}</h1><p>${copy.body}</p><p><a href="/">${copy.retry}</a></p></main></body>
</html>`;
}

function isPlaybackUrl(url) {
  const host = typeof url.hostname === "string" ? url.hostname : "";
  return host === PLAYBACK_HOST_SUFFIX || host.endsWith(`.${PLAYBACK_HOST_SUFFIX}`);
}

function isSameOrigin(url) {
  try {
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}

/**
 * Classifies a request into exactly one strategy:
 * "static" | "navigation" | "passthrough".
 */
function classifyRequest(request) {
  if (!request || request.method !== "GET") {
    return "passthrough";
  }
  let url = null;
  try {
    url = new URL(request.url);
  } catch {
    return "passthrough";
  }
  // Playback hosts are identified first so absolute media URLs can never
  // fall through to a cacheable branch, whatever their path looks like.
  if (isPlaybackUrl(url)) {
    return "passthrough";
  }
  if (!isSameOrigin(url)) {
    // Providers, fonts, artwork, and every other external host.
    return "passthrough";
  }
  if (url.pathname.startsWith("/_next/static/")) {
    return "static";
  }
  if (url.pathname.startsWith("/api/")) {
    return "passthrough";
  }
  if (request.mode === "navigate") {
    return "navigation";
  }
  return "passthrough";
}

/**
 * The built-in offline page. Built per request from the visitor's locale
 * cookie rather than served as one fixed English document; nothing is read
 * from or written to any cache, so no personalised or authenticated HTML can
 * ever leak between users or sessions.
 */
function offlineFallbackResponse(locale) {
  return new Response(offlineHtml(locale), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function handleStatic(event) {
  event.respondWith(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.match(event.request).then((hit) => {
        if (hit) {
          return hit;
        }
        return fetch(event.request).then((response) => {
          // Same-origin immutable assets only; errors and opaque
          // responses are never stored.
          if (response && response.ok && response.type === "basic") {
            cache.put(event.request, response.clone()).catch(() => undefined);
          }
          return response;
        });
      }),
    ).catch(() => fetch(event.request)),
  );
}

function handleNavigation(event) {
  event.respondWith(
    fetch(event.request).catch(async () =>
      offlineFallbackResponse(await resolveOfflineLocale(event.request)),
    ),
  );
}

self.addEventListener("install", (event) => {
  // Nothing to precache: the offline fallback is built in and static
  // assets populate on first use. No skipWaiting() — see the update-flow
  // note at the top of this file. The new worker waits until the page
  // explicitly hands over control at `pagehide`, so an in-progress listening
  // session is never re-parented onto a new build.
  event.waitUntil(Promise.resolve().catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("aurora-") && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .catch(() => undefined),
  );
});

/**
 * Safe, decoupled hand-over. The page posts this once at `pagehide`, when the
 * current document is already leaving, so activation can never interrupt
 * playback or a live UI. The worker waits, activation claims, and the next
 * launch is served by the new build.
 */
self.addEventListener("message", (event) => {
  const data = event && event.data;
  if (data && data.type === ACTIVATE_MESSAGE) {
    event.waitUntil(self.skipWaiting().catch(() => undefined));
    return;
  }
  if (data && data.type === LOCALE_MESSAGE) {
    // Sent by the page on load and again whenever the visitor switches
    // language, because the page is the only context that can read the cookie
    // (see `META_CACHE` for the measurement that forces this design).
    event.waitUntil(rememberLocale(data.locale));
  }
});

self.addEventListener("fetch", (event) => {
  const kind = classifyRequest(event.request);
  if (kind === "static") {
    handleStatic(event);
    return;
  }
  if (kind === "navigation") {
    handleNavigation(event);
    return;
  }
  // Passthrough: the worker deliberately does not call respondWith, so the
  // browser handles playback, provider, API, and POST traffic natively.
});

// Test surface (no behavior change): exposes the pure classifier, version,
// localization, and fallback copy so unit tests exercise this exact file.
self.__auroraSW = {
  AURORA_SW_VERSION,
  STATIC_CACHE,
  META_CACHE,
  META_LOCALE_URL,
  ACTIVATE_MESSAGE,
  LOCALE_MESSAGE,
  DEFAULT_LOCALE,
  classifyRequest,
  OFFLINE_COPY,
  offlineCopy,
  localeFromRequest,
  normalizeLocale,
  rememberLocale,
  readRememberedLocale,
  resolveOfflineLocale,
  offlineHtml,
  offlineFallbackResponse,
};
