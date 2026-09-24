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
 */

const AURORA_SW_VERSION = "aurora-sw-v1";
const STATIC_CACHE = `${AURORA_SW_VERSION}:static`;
const PLAYBACK_HOST_SUFFIX = "googlevideo.com";
const OFFLINE_TITLE = "You're offline";
const OFFLINE_BODY =
  "Aurora can still open its application shell, but music playback requires an internet connection.";

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${OFFLINE_TITLE} — Aurora Music</title>
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
<body><main><h1>${OFFLINE_TITLE}</h1><p>${OFFLINE_BODY}</p><p><a href="/">Retry</a></p></main></body>
</html>`;

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

function offlineFallbackResponse() {
  return new Response(OFFLINE_HTML, {
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
  event.respondWith(fetch(event.request).catch(() => offlineFallbackResponse()));
}

self.addEventListener("install", (event) => {
  // Nothing to precache: the offline fallback is built in and static
  // assets populate on first use. Activate the update promptly.
  event.waitUntil(Promise.resolve().then(() => self.skipWaiting()).catch(() => undefined));
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
// and fallback copy so unit tests exercise this exact file.
self.__auroraSW = {
  AURORA_SW_VERSION,
  STATIC_CACHE,
  classifyRequest,
  OFFLINE_TITLE,
  OFFLINE_BODY,
  offlineFallbackResponse,
};
