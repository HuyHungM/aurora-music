# Aurora Music — Security posture (Phase 26)

This document records the production security boundaries that are enforced
by automated gates. It is a statement of what holds, not a wishlist.

## Boundaries

- **Providers are server-only.** `youtubei.js` is imported by exactly one
  module (`lib/providers/youtube/playback/innertube-client.ts`); no `.tsx`
  file imports provider implementations (only `@/lib/providers/server`).
  The browser receives serialized `AudioSource` objects, never internals.
- **Client bundle gate:** `npm run verify:client-bundle` fails the build
  pipeline if server markers (`youtubei`, `Innertube`, secrets, tokens)
  appear in production client chunks.
- **Temporary playback URLs** are memory-only: no DB columns (PlaybackState
  holds provider/providerTrackId/position/revision), no storage APIs in
  production source, no service-worker caching, no persistence in tests.

## Environment

- `DATABASE_URL` required; `AUTH_SECRET` required only when
  `NODE_ENV=production`. Everything else is optional/server-only.
- No `NEXT_PUBLIC_*` variables anywhere in source or `.env.example`.
- Never log secret values; `src/lib/diagnostics/logger.ts` drops
  secret-shaped fields and redacts URL shapes fail-closed.

## HTTP headers (`next.config.ts`)

- `nosniff`, `strict-origin-when-cross-origin` referrer, `DENY` framing,
  camera/mic/geolocation disabled.
- CSP is compatibility-scoped: `script-src`/`style-src` keep
  `'unsafe-inline'` because Next.js App Router hydrates through inline
  scripts and components use style attributes — removing either breaks the
  app. Everything else is locked (`frame-ancestors 'none'`,
  `object-src 'none'`, `media-src https:`, `form-action 'self'`).
- Deliberately absent: HSTS (TLS termination is a deployment concern; must
  not break http development origins), COOP/COEP/CORP (cross-origin media
  and artwork ship no CORP headers — enabling them breaks playback).

## Auth / session

- Auth.js with JWT sessions; secure `HttpOnly`/`SameSite=Lax` cookies via
  Auth.js defaults (`__Secure-` prefix in production). No custom cookie or
  session code. `trustHost: true` assumes the deployment sanitizes the Host
  header upstream (standard for Next + Auth.js behind a proxy).
- Mutations require a session user; DAL rechecks resource ownership
  (`AuthorizationError`); sign-out redirects to the fixed `/` target
  (no open redirects anywhere — verified by search).

## Caching

- Dynamic routes are uncached (`private, no-cache`); immutable
  `/_next/static/*` is long-cached by Next. The service worker caches only
  same-origin immutable statics, never HTML/API/auth/provider/playback, and
  serves a built-in offline page for failed navigations.

## Playback URL rules

- googlevideo traffic is never intercepted or cached (service worker
  denylist + unit tests + live observation). Resolver accepts exact
  provider ids only — there is no generic URL fetch endpoint and no proxy.

## Release smoke checks

- `npm run smoke:prod [baseUrl]` (needs `npm run start`): shell status,
  security headers, manifest/icons, service worker content, proxy absence
  (404), E2E fixture gating, auth endpoint sanity. Exit 0 only when all
  pass. Also wired into CI after the E2E job.

## Known deployment assumptions

- Spotify/YouTube credentials stay server-side or absent (providers stay
  unregistered without them). No rate limiting in-app (documented
  limitation — enforce at the edge if needed).
- In this stack, programmatic `notFound()` renders the not-found UI with
  HTTP 200 (verified across routes; filesystem misses still 404). Gates
  assert behavior (no fixture content served), not the status code.
