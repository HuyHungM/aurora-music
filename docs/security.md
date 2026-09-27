# Aurora Music — Security posture (Phase 26)

This document records the production security boundaries that are enforced
by automated gates. It is a statement of what holds, not a wishlist.

## Boundaries

- **Providers are server-only.** `youtubei.js` has a single value import
  (`lib/providers/youtube/innertube/session.ts`); the playback client
  (`lib/providers/youtube/playback/innertube-client.ts`) imports it as
  *types only*, and the boundary test confines both to the two
  provider-internal directories. No `.tsx` file imports provider
  implementations (only `@/lib/providers/server`). The browser receives
  serialized `AudioSource` objects, never internals.
- **Client bundle gate:** `bun run verify:client-bundle` fails the build
  pipeline if server markers (`youtubei`, `Innertube`, secrets, tokens)
  appear in production client chunks.
- **Temporary playback URLs** are memory-only. Playback resolves a fresh
  `AudioSource` per load through `PlaybackController`, and the controller
  never reads `streamUrl`/`previewUrl` as playback input — not even as a
  fallback. The persistent playback session holds
  provider/providerTrackId/position/revision plus a versioned snapshot of
  track identity and display metadata; there are no storage APIs in
  production source, no service-worker caching, and no persistence in tests.
  The session serializer and its validator reject URL-shaped fields
  (`streamUrl`, `previewUrl`, `url`, `mimeType`, `expiresAt`, `bitrate`)
  outright rather than stripping them, and a deterministic test asserts a
  serialized session cannot contain `googlevideo`, a signed stream URL,
  credentials, or session cookies.
- **The shared catalog cannot be given a media URL by a client (Phase 49).**
  `Track`/`Artist`/`Album` rows are a shared, unowned cache — there is no
  owner column, so there is nothing to authorize a write against, which makes
  the *write path* the only trust boundary that exists. The `Track` table does
  still carry legacy nullable `streamUrl`/`previewUrl` columns; they are
  never written by any production path. `upsertTrack` does not accept those
  fields (excluded from its parameter type), and `addTrackSchema` omits them
  so zod strips them from a client payload. This closes a defect where any
  authenticated user could overwrite another user's — or an anonymous shared
  playlist visitor's — track title, artwork, and URL fields. Known residual:
  display fields are still client-supplied on first write; see
  `docs/scope-boundaries.md`.
- **Test-only flags fail closed in a real deployment.**
  `AURORA_E2E_AUTH` makes `/e2e-library` readable by anonymous visitors and
  switches radio to the fixture backend; `AURORA_E2E_LIVE_PLAYBACK` enables
  the live-media probe. Both are now registered in the validated env schema
  rather than read ad hoc. `parseEnv` refuses to boot when either is set
  under `NODE_ENV === "production"` *without* `AURORA_E2E_ALLOW_TEST_FLAGS=1`.
  The acknowledgment is a separate, deliberately-named variable because
  `NODE_ENV=production` is not by itself evidence of a deploy — the E2E
  harness serves the production build via `next start` with the flags on, on
  purpose. A stray `AURORA_E2E_AUTH=1` copied into a deployment still fails
  closed, because nothing there sets the acknowledgment. Before Phase 49
  nothing detected these flags at all.
- **`AUTH_SECRET` is trimmed and must be non-blank in production.** The
  production check compares the trimmed value to `""`, so a whitespace-only
  secret (a stray space or newline from a secret manager or shell capture) is
  rejected instead of being accepted as a one-character HMAC key for every
  session JWT.
- **No audio data is persisted anywhere** — no blobs, no cached segments,
  no offline playback. Only the queue and player state are remembered.

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
- `/api/auth/*` is re-anchored to the host the browser used
  (`toBrowserOrigin()` in `src/app/api/auth/[...nextauth]/route.ts`), because
  Next 16 dev builds `request.url` from `opts.hostname || "localhost"` rather
  than from the `Host` header. The rewrite touches the origin only — scheme
  comes from `x-forwarded-proto` or the request itself and is never guessed,
  so a plain-HTTP origin still gets non-`Secure` cookies. No cookie attribute,
  safe origin, or redirect target is relaxed to make LAN sign-in work.
- Mutations require a session user; DAL rechecks resource ownership
  (`AuthorizationError`); sign-out redirects to the fixed `/` target
  (no open redirects anywhere — verified by search).
- **CSRF is layered, and the layers are named here because they are not all
  Auth.js's.** `/api/auth/*` POSTs use Auth.js's own double-submit token.
  The `signInWith` / `signOutUser` *server actions* go through next-auth's
  server-action path, which passes `skipCSRFCheck`; they are protected
  instead by Next 16's Origin↔Host comparison (`serverActions.allowedOrigins`
  is unset, so: same origin only) on top of `SameSite=Lax` cookies. Next's
  comparison admits a request that carries **no** `Origin` header with a
  warning rather than rejecting it — the residual is therefore a non-browser
  client, which has no ambient cookies to ride on. Recorded as the posture
  it is, not as an Auth.js guarantee.

## Rate limiting (Phase 52)

Every expensive operation goes through one server-side guard
(`guardServerAction`) that checks a feature flag and then a fixed-window rate
limit. There is no client-side enforcement anywhere: a limit the caller controls
is not a limit.

Identity is the authenticated user id, or a truncated `sha256(ip +
user-agent)` for signed-out traffic. The raw address is never stored or logged
by the limiter, and the counter map is bounded, so a flood of single-request
identities cannot exhaust memory. A denied request does not extend its own
window, so hammering cannot hold a lockout open.

**Limitation, stated rather than hidden:** the counters live in the Node
process, so behind multiple instances the effective limit is the per-instance
limit times the instance count. See `docs/scope-boundaries.md`.

## Error disclosure and correlation (Phase 52)

Client-facing error codes are a closed set, each with an HTTP status and a
retryability flag. `INTERNAL_ERROR` is always replaced with a fixed generic
message: an unexpected exception is the case most likely to carry a query, a
filesystem path or an identifier, and the case the client least needs it.

Every response carries `x-aurora-request-id`, either freshly generated or
propagated from an inbound header that passed an 8-64 character
`[A-Za-z0-9._-]` allowlist. A hostile inbound id is REPLACED rather than
sanitized - stripping characters from an attacker-controlled string is how
log-injection bugs get written. A request id is a label, not an identity: it
authorizes nothing, and is never written to the database.

## Backup and restore (Phase 52)

Backups are a `pg_dump` in custom format taken out of band. What makes them
trustworthy is that a restore is actually performed and verified:
`bun run db:restore-drill` creates a throwaway database, dumps the source,
restores into the copy, runs the full integrity verification against the
RESTORED copy, compares row counts, and drops the target.

The drill refuses to run without an explicit acknowledgement, refuses if the
target name equals the source name, and always drops what it created. See
`docs/deployment.md` for the runbook.

## Caching

- Dynamic routes are served uncached by Next's own defaults (no app code
  sets `Cache-Control`; there is a gate on what the *service worker* may
  cache instead of on the header); immutable `/_next/static/*` is
  long-cached by Next. The service worker caches only same-origin immutable
  statics, never HTML/API/auth/provider/playback, and serves a built-in
  offline page for failed navigations. The offline page prefers the locale
  the visitor chose, remembered in the worker's own two-letter cache (a
  Chromium navigation reaches a worker with no `cookie` header), falling
  back to the `aurora-locale` cookie when nothing is remembered; it is
  never itself cached, so no personalised or authenticated HTML can leak
  between sessions.

## Installable web app posture

Installing Aurora changes presentation only. It grants no new privilege and
introduces no new trust boundary:

- **The install opt-out is an anonymous cookie.** `aurora-install-dismissed`
  records only *when* a visitor declined; it carries no identifier, is not
  written to the database, and is never tied to an account. It is `lax` and
  deliberately not `secure`-flagged, because it must also be readable on the
  plain-HTTP localhost development origin. The browser storage APIs are gated
  out of production source, so a cookie is the only persistence mechanism
  available — and is the right one here, since the value is a UI-suppression
  bit, not data.
- **Install capability is detected, never trusted from input.** The
  `beforeinstallprompt` event is captured with `preventDefault()` and fired
  only from a user click, at most once, because the event is single-use. No
  user-agent string decides what the app may claim about itself.
- **The installed app gets the same cookie-based session as the browser.**
  There is no second auth mechanism, no token in the manifest, and no
  privileged storage; `SameSite=Lax` OAuth and session cookies behave
  identically in both modes.
- **`/api/app-config` is unauthenticated by design and deliberately inert.**
  It returns only compile-time literals plus the application version. A test
  asserts the response body contains no environment variable name, no
  `process.env`, no filesystem path, and no provider identifier. The version is
  read from `package.json` in a server-only module, so the dependency manifest
  can never reach the client bundle.
- **No capability is advertised that is not implemented.** `offlineAudio` and
  `pushNotifications` are permanently `false`; runtime-dependent capabilities
  (Media Session, Web Share, notifications, installed state) are measured in
  the browser rather than asserted by the server, so a lying client cannot be
  handed a claim the server never verified.
- **Security headers were not relaxed for the PWA work.** The existing CSP
  already permits the worker (`worker-src 'self'`, same-origin `/sw.js`) and
  the same-origin manifest via `default-src 'self'`. No header was weakened,
  and no permissive directive was added to make an install path work.
- **Private playlist data stays out of installable surfaces.** The manifest,
  the offline page, the Open Graph metadata and `/api/app-config` are all
  static or request-independent; a shared playlist's title, artwork and
  existence are reachable only through its opaque share token, and its
  not-found path is `noindex` and renders soft-404 by design.

## Playback URL rules

- googlevideo traffic is never intercepted or cached (service worker
  denylist + unit tests + live observation). Resolver accepts exact
  provider ids only — there is no generic URL fetch endpoint and no proxy.

## Release smoke checks

- `bun run smoke:prod [baseUrl]` (needs `bun run start`): shell status,
  security headers, manifest/icons, service worker content, proxy absence
  (404), E2E fixture gating, auth endpoint sanity. Exit 0 only when all
  pass. Also wired into CI after the E2E job.

## Known deployment assumptions

- Spotify/YouTube credentials stay server-side or absent (providers stay
  unregistered without them). In-app rate limiting exists for the expensive
  server actions (search, playback resolve, radio, recommendations, playlist
  mutation) as fixed-window buckets behind `guardServerAction`, single
  instance only — see the rate-limiting section above for what is
  deliberately not gated and for the per-instance multiplication.
- In this stack, programmatic `notFound()` renders the not-found UI with
  HTTP 200 (verified across routes; filesystem misses still 404). Gates
  assert behavior (no fixture content served), not the status code.
- **Opening the dev server from another device is a host configuration, not
  an application change.** The dev listener binds the LAN address and
  `allowedDevOrigins` admits it (development only); a phone on the same
  network additionally needs an inbound firewall allowance for the dev port,
  which Aurora never creates or disables — the allow rule is scoped to the
  port and the private profile, and the firewall itself is left exactly as
  it was found.
