# Aurora Music — Product Audit Report

**Date:** 2026-09-27
**Auditor pass:** full product audit (routes, features, providers, database, auth, API, security, player, a11y, performance, tests, LAN, PWA)
**Repository state:** working tree with all changes of this session uncommitted on top of `1a2ffb3`; nothing was reset, restored or cleaned.
**Companion artifacts:** `docs/scope-boundaries.md` (deliberate exclusions), `ARCHITECTURE.md`, `PRODUCT_SPEC.md`, `docs/security.md`, `docs/deployment.md`.

---

## 1. Scope, method and baseline

### 1.1 Method

1. **Inspect first.** Every claim below is grounded in a read of the source,
   a document, a test, a build artifact, or a live browser session — not in
   intent. Where evidence came from a static read it is marked *(static)*,
   where it came from a run it is marked *(measured)*.
2. **Fix only what the audit justifies.** P0/P1 findings were implemented;
   P2–P4 were classified and left with a recommendation. No speculative
   feature work, no cosmetic refactors.
3. **Docs are a source of truth.** A doc that disagrees with the code is a
   finding in its own right (§18) and was corrected in the same change
   where the code is authoritative.

### 1.2 Baseline measured for this pass

| Gate | Command | Result |
|---|---|---|
| Lint | `bun run lint` | 0 errors *(measured)* |
| Typecheck | `bun run typecheck` | 0 errors *(measured)* |
| Unit suite | `bun run test` | 193 files / 2786 tests passed *(measured)* |
| DB suite | `bun run test:db` | green in prior pass, not re-run this session *(see §21)* |
| Production build | `bun run build` | 0 errors *(measured)* |
| Client-bundle gate | `bun run verify:client-bundle` | 0 violations, 35 chunks *(measured)* |
| E2E (full) | `bunx playwright test` | run A: 161 passed / 20 skipped / 4 failed · run B: 162 passed / 20 skipped / 3 failed *(measured)* |

The three persistent E2E failures are the pre-existing
`canonical-dedupe.spec.ts:114/:134/:155` trio that also fails on the
untouched baseline; the fourth failure in run A (an equalizer keyboard test)
did not reproduce in run B or in isolation (`3 passed` when run alone) and is
a parallel-run flake, recorded as AUR-020.

### 1.3 Environment constraints that shaped this audit

- Production is deployed at a **plain-HTTP** origin (`http://<host>:<port>`),
  reachable from this machine but not deployable to from here.
- No physical phone; mobile verification is host-side only.
- Provider credentials in `.env` are invalid for YouTube Data / Spotify /
  Deezer, so live provider behaviour is limited to the keyless InnerTube path.
- OAuth over plain-HTTP private IP is refused by Google; GitHub OAuth is
  unverified (no real credentials).

---

## 2. What this audit changed

| File | Change |
|---|---|
| `src/components/pwa/service-worker-register.tsx` | P0 fix AUR-001: `!("serviceWorker" in navigator)` presence test before dereferencing the container |
| `scripts/verify-client-bundle.mjs` | new `scanServiceWorkerGuard()` gate wired into `main()` (compiled `.register(` must be preceded by a presence test) |
| `src/lib/pwa/__tests__/client-bundle.test.ts` | 4 tests for the new gate (compiled good/bad/ordering/unrelated fixtures) |
| `e2e/pwa.spec.ts` | regression test "startup survives an origin with no service worker API" |
| `src/lib/db.ts`, `scripts/verify-db.mts` | P1 fix AUR-002: error messages carry the scheme, never the connection string |
| `ARCHITECTURE.md`, `PRODUCT_SPEC.md`, `docs/security.md`, `docs/scope-boundaries.md`, `docs/deployment.md` | P1 documentation corrections (§18) |

No product behavior outside the two fixes was altered. No new state
authority, framework, provider or library was introduced.

---

## 3. Route matrix *(static)*

**12 pages + 3 API routes + 18 server-action modules (40 exported actions).**
There is no `middleware.ts`; page-level access control is a sign-in CTA, and
real authorization lives in `requireUser()` / `requirePlaylistOwner()`.

| Route | File | Access | Purpose |
|---|---|---|---|
| `/` | `src/app/(app)/page.tsx:20` | public | home sections, capability-gated per section |
| `/search` | `src/app/(app)/search/page.tsx:32` | public | unified search + link classification + 8-item history |
| `/library` | `src/app/(app)/library/page.tsx:19` | sign-in | likes, playlists (50), recently played (20) |
| `/library/playlists/[id]` | `…/playlists/[id]/page.tsx:9` | owner | `notFound()` for non-owner (`:18,:24`) |
| `/album/[id]` | `…/album/[id]/page.tsx:17` | public | album detail |
| `/artist/[id]` | `…/artist/[id]/page.tsx:21` | public | artist detail + follow |
| `/track/[id]` | `…/track/[id]/page.tsx:12` | public | track detail + like |
| `/radio` | `…/radio/page.tsx:22` | public | radio entry |
| `/settings` | `…/settings/page.tsx:55` | public | appearance, audio/EQ, language |
| `/playlist/share/[token]` | `…/playlist/share/[token]/page.tsx:60` | public read-only | 404 on bad/private token |
| `/e2e-library` | `…/e2e-library/page.tsx:27` | flag-gated, fails closed | E2E fixture |
| `/e2e-playback/[videoId]` | `…/e2e-playback/[videoId]/page.tsx:16` | flag-gated, fails closed | live playback fixture |

| API route | Methods | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | public | env validation + `SELECT 1` → 200/503 (`force-dynamic`) |
| `/api/app-config` | GET | public | static capability surface (`force-static`) |
| `/api/auth/[...nextauth]` | GET, POST | Auth.js | session/OAuth, re-anchored by `toBrowserOrigin()` |

Server actions are guarded by `guardServerAction` (feature flag → rate
bucket → session). Unguarded/bucketless actions are listed in AUR-013.

---

## 4. Feature matrix *(static + measured)*

| Feature | Status | E2E | Unit |
|---|---|---|---|
| Unified search + link classification | Implemented | `search-navigation`, `search-link`, `live-search` | `unified-search` ×2, search page suites |
| Playback (play/pause/resume/seek/volume/next/prev) | Implemented | `live-playback`, `error-recovery`, `app-shell` | `playback/*` controller/recovery/resolver |
| Queue (replace/next/prev/play-next/clear/move/remove/shuffle/repeat, snapshot cap 200) | Implemented | `authenticated-queue`, `autoplay-control` | `queue-manager`, `queue-snapshot`, queue-panel/reorder |
| Library, likes, playlists CRUD/reorder | Implemented, auth | `authenticated-library`, `authenticated-playlist` | `dal/*.db.test.ts` |
| Playlist sharing (24-byte token, read-only) | Implemented | `playlist-share` | `playlist-sharing.db.test.ts` |
| Radio (batch 5, extend at 2) | Implemented, partial by design | `authenticated-radio` | `radio/*` |
| Recommendations (local, deterministic) | Implemented | partial (`acceptance-journeys`) | `recommendations` |
| EQ (Aurora V-Shape, 10 bands, preamp) | Implemented | `equalizer`, `equalizer-playback` | `eq*` suites |
| Appearance (4 presets ×6 values, 5 backgrounds, 8 sliders) | Implemented | no dedicated spec (see AUR-015) | `appearance/*` |
| i18n (`vi` default + `en`, cookie + account) | Implemented | partial (4 specs assert switching) | `i18n` |
| Auth (Google/GitHub OAuth, JWT) | Implemented | `auth.setup` + `authenticated-*` | `auth/options`, `availability` |
| PWA (manifest, SW, install, offline page) | Implemented | `pwa` | `pwa/*`, `service-worker-register` |
| Search history (cap 8), recently played | Implemented, auth | `search-navigation` | `recently-search.db.test.ts` |
| Push notifications | Not implemented (deliberate) | — | `platform.test.ts` asserts the probe only |
| Crossfade / gapless / sleep timer / lyrics / social / offline music | Not implemented (deliberate) | — | — |

---

## 5. User-flow matrix *(static + measured)*

| Flow | Steps covered | Verified by |
|---|---|---|
| Anonymous: land → search → results → play → controls → clear search | render, search, clear, play/pause/resume, seek, volume, queue UI | **manual on the production build over an insecure origin this session** + `app-shell`, `search-navigation` |
| Anonymous → sign-in (Google/GitHub) → session cookie → signed-in shell | provider availability, invalid-provider rejection, teardown | `auth.setup`, `auth.teardown`, `auth/options` unit |
| Authenticated: library → create/edit/reorder/delete playlist → share → read-only viewer | CRUD, ownership 404, token round-trip | `authenticated-playlist`, `playlist-share`, DAL DB tests |
| Queue: play from list → play-next → reorder → clear → restore after reload | snapshot persistence (cap 200), foreign-owner yield | `authenticated-queue`, `playback-session-durability` (35 tests) |
| Recovery: stream failure → bounded retry (2 attempts, 200/800 ms) → honest error | recovery ladder, no silent retry loop | `error-recovery`, `playback/recovery` unit |
| Settings: EQ toggle → graph engage → persist (cookie + account) | switch semantics, radio-group labels, persistence | `equalizer`, `eq-panel` (39 tests) |
| Locale: switch `vi`/`en` → cookie + account → shell re-renders | cookie write, worker hand-off | `pwa`, `search-navigation`, `mobile-layout` |
| Offline: kill network → navigation → built-in offline page in visitor language | worker classifier, locale memory | `pwa`, `public/sw.js` unit |
| Failure: player error → PlayerHost stays alive, no shutdown loop | **new regression added this session** | `e2e/pwa.spec.ts` "startup survives an origin with no service worker API" |

---

## 6. Provider audit *(static)*

Registration order YouTube → Deezer → Spotify (`src/lib/providers/server.ts:11-20`).

| Provider | Credentials | Registers without them | Capabilities | Degradation |
|---|---|---|---|---|
| YouTube (InnerTube primary, Data API fallback) | `YOUTUBE_API_KEY` gates **registration** (`youtube/bootstrap.ts:49-52`) | no | search/get tracks, search/get artists, artist tracks, stream | provider absent; playback still resolves keyless |
| Deezer | none | **yes** | + albums, + `tracks.popular` | `kind:"failed"` → section placeholder |
| Spotify | ID + secret pair | no | metadata only (no artist tracks/popular) | provider absent |

Boundary rule: `youtubei.js` may only be imported inside
`providers/youtube/{playback,innertube}` (enforced by
`youtube/__tests__/boundary.test.ts:48-85`) and by the client-bundle gate
(`verify-client-bundle.mjs` forbidden markers). Verified TRUE.

**Home sections (AUR-021, P3):** `fetchHomeSections` uses only the
preferred provider (`server.ts:111`), and YouTube advertises none of
popular/featured/recommendations/albums, so those sections render only when
the active provider supports them. The spec table has been corrected to say
so (§18-D9); the product renders an honest empty state rather than failing.

---

## 7. Database audit *(static)*

- **14 models** (`prisma/schema.prisma`), 8 migrations, client emitted to
  `src/generated/prisma`.
- Playback URL hygiene is enforced by a gate: `PlaybackState` must not
  contain `streamUrl`/`previewUrl`/`googlevideo`
  (`dal/__tests__/playback-schema.test.ts:90-104`).
- Migration allowlist fails closed: `KNOWN_MIGRATIONS` (8 entries, each with
  a rollback note) vs the directory listing (`:106-114`). **TRUE.**
- `RecentlyPlayed` is one row per (user, track) — `@@unique([userId,trackId])`
  — and the doc that said "play events" was wrong (corrected, §18-D5).
- Raw SQL exists only as `SELECT 1` in `/api/health`; `$queryRawUnsafe`
  appears only inside a DB test.

---

## 8. Authentication audit *(static)*

- Auth.js v5 beta, `PrismaAdapter`, **JWT strategy**, `trustHost: true`,
  `AUTH_SECRET` required in production and trimmed
  (`src/lib/config/env.ts:105-116`).
- Google/GitHub are registered only when ID **and** secret are present;
  `signInWith` re-validates the provider name against that registry.
- No credentials/password path exists at all — OAuth only.
- `getCurrentUser()` re-reads the user row per call, so a deleted user's
  still-valid JWT resolves to `null` (`dal/session.ts:7-28`).
- Sign-out redirects to a fixed `/` — no open redirect anywhere (searched).
- **CSRF posture is layered** (Auth.js token for `/api/auth/*`; Next's
  Origin↔Host check + `SameSite=Lax` for the sign-in/out server actions,
  because next-auth's server-action path passes `skipCSRFCheck`). This was
  not previously written down; it now is (`docs/security.md`, §18-D7).
- Cookie flags are Auth.js defaults and are not overridden anywhere —
  matching the documented claim. **TRUE.**

---

## 9. API surface audit *(static + measured)*

Three HTTP routes only; everything else is RSC + server actions — matching
`ARCHITECTURE.md:1396-1402`. **TRUE.**

- Headers come from one place (`next.config.ts:49-60`) and are asserted by
  `src/security-headers.test.ts` (4 tests), `src/quality-gates.test.ts:707`,
  and the live `scripts/smoke-prod.mjs:169-174`.
- Every API response carries a correlation id
  (`quality-gates.test.ts:671`), **but** three components mint three
  different UUIDs for one denial event (AUR-016).
- No `Access-Control-*` header is ever set; a wildcard ACAO fails the build
  (`quality-gates.test.ts:748-750`). **TRUE.**

---

## 10. Security audit *(static + measured)*

| Control | State | Evidence |
|---|---|---|
| CSP | `default-src 'self'`; `script-src 'self' 'unsafe-inline'` (+`unsafe-eval` **dev only**); `style-src 'self' 'unsafe-inline'`; `img-src` allows `http:`/`https:`/`data:`/`blob:`; `media-src https:`; `connect-src 'self' ws: wss:`; frames/forms/base/worker `'none'` | `next.config.ts:27-47`, matches `docs/security.md:67-78` |
| Other headers | `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` camera/mic/geo off | `next.config.ts:49-60` |
| HSTS / COOP / COEP / CORP | deliberately absent (documented) | `docs/security.md:79-81` |
| Secrets | no `NEXT_PUBLIC_*` anywhere; bundle gate fails on `AUTH_SECRET`/`YOUTUBE_API_KEY`/`client_secret`/tokens in chunks; `.gitignore` ignores `.env*` except `.env.example` | `quality-gates.test.ts:86-119`, `verify-client-bundle.mjs:27-36` |
| Logging | logger drops secret-shaped keys, URLs and non-primitives; no email/IP/UA/cookie logged | `diagnostics/logger.ts:42-94` |
| Rate limiting | 7 fixed-window buckets, bounded 10k-key map, per-identity, denied requests don't extend the window, single instance | `http/rate-limit.ts:78-196` |
| Validation | zod at action boundaries; artwork URL `http/https` ≤2048; background image **https only**, no embedded credentials; playlist visibility enum; queue snapshot `.strict()` rejects URL-shaped fields | `validation/schemas.ts`, `appearance.ts:137-166` |
| Injection | parameterised Prisma everywhere; no `eval`, no `dangerouslySetInnerHTML`, no `innerHTML` in production source, no `redirect()` | searched |
| Dev origins | `allowedDevOrigins` returns `[]` outside development; bare `*`/`**` rejected | `config/dev-origins.ts:124-244` |

**Residual, deliberate, documented:** `'unsafe-inline'` in `script-src` and
`style-src`, broad `img-src`/`media-src`/`connect-src`, edge TLS as a
deployment responsibility. None of these were changed.

---

## 11. Player / audio audit *(measured this session on the production build)*

| Check | Result |
|---|---|
| App boots on insecure LAN origin, PlayerHost mounts once | `app_initialized` ×1, `app_shutdown` ×0 *(measured)* |
| Route change does not kill the player | `/ → /search → /library`, still 1 init / 0 shutdowns *(measured)* |
| Search → results (22 play affordances) → play | `mediaSession.playbackState = "playing"`, position advancing *(measured)* |
| Pause / resume / seek / volume | toggle → `paused`, resume → `playing`, seek to 1:00 applied, volume 0.42 applied *(measured)* |
| Track end → clean stop (no error, no crash) | 0 console errors *(measured)* |
| Equalizer engage on play | `eq_audio_context_state: running`, `eq_audio_graph_health.engaged: true` *(measured)* |
| **Web Audio over the cross-origin stream** | Chrome logged *"MediaElementAudioSource outputs zeroes due to CORS access restrictions"* — **the known, measured, deliberately deferred limitation** already documented at `ARCHITECTURE.md` §33.8 and `docs/scope-boundaries.md` ("No CORS-clean media delivery"). Re-confirmed today; **not a new finding**, and both candidate fixes are explicitly out of scope there (same-origin relay = SSRF surface + bandwidth bill; pre-engagement probe = re-architecture of the engagement lifecycle). |
| Media element | held outside the document query tree; `mediaSession` metadata/position remain correct |

---

## 12. Accessibility audit *(static + measured)*

- **434 `getByRole(...)` selectors** across `e2e/` — role-first is the
  dominant idiom, so most flows are asserted by accessible name.
- Dedicated suites: `phase6f-a11y.test.tsx`, `dialog.test.tsx` (Tab trap,
  focus restore, autofocus), `eq-panel.test.tsx` (radiogroup semantics,
  state spelled in words), `appearance-panel.test.tsx` (radiogroup keyboard
  incl. wrap-around), `search-field.test.tsx` (accessible names),
  `e2e/keyboard.spec.ts` (full keyboard journeys),
  `e2e/mobile-layout.spec.ts:253` (44 px touch targets),
  `reduced-motion.test.ts`, `design-tokens.test.ts` (contrast).
- **Gap (AUR-015):** no automated axe/WCAG scanner anywhere, so a new
  control can ship without an accessible name or below 44 px unless a test
  is written for it by hand.

---

## 13. Performance audit *(measured)*

| Budget | Limit | Measured (gzip) | State |
|---|---|---|---|
| Total client JS | 400 KiB | 335.8 KiB (+10.1% vs baseline) | ok |
| Largest JS chunk | 100 KiB | 71.6 KiB (+0.1%) | ok |
| Total client CSS | 20 KiB | 14.9 KiB (+21.9%) | ok |

- Budgets live in one place (`verify-client-bundle.mjs:90-109`), each a
  measured value plus ~25% headroom, re-baselined only via
  `AURORA_RECORD_BUDGETS=1`.
- **No runtime performance measurement exists** (no Lighthouse, no
  web-vitals, no LCP/CLS/INP assertions) — AUR-015.
- Preloaded font fetches: see AUR-019.

---

## 14. Test coverage audit *(static + measured)*

| Metric | Value |
|---|---|
| Unit test files | 202 total (193 in the default suite + 9 DB) |
| Unit test declarations | ~2749 (lib 1936, components 553, app 229, root gates 31) |
| Default suite result this session | **193 files / 2786 tests passed** |
| E2E specs / declarations | 26 / 153 |
| E2E result (run B) | **162 passed, 20 skipped, 3 failed** (pre-existing trio) |
| Structural gates | `quality-gates.test.ts` (24), `security-headers.test.ts` (4), 8 boundary suites, migration allowlist, `production-boundary` (5) |
| `vi.mock(` blocks | 124 (`engine-factory` ×16) |
| Snapshots | 0 |
| Coverage tooling / thresholds | none (no `@vitest/coverage-*`, no config block) |
| CI jobs | `validate` (typecheck, lint, test), `db` (test:db, db:verify), `e2e` (build, verify:client-bundle, playback tests, smoke:prod ×2) |

**CI gaps (AUR-015):** live playback tests self-skip (flag never reaches
Vitest), the `mobile-chromium` / `mobile-landscape` Playwright projects are
never run by `package.json:19`'s `--project=chromium`, and `smoke:prod`
runs twice per push.

**Coverage gaps:** 8 of 18 server-action modules have no test file
(`track`, `artist`, `search`, `locale`, `install`, `auth`,
`resolve-search-link`, `appearance`-action); whole component directories
without tests (`auth/`, `i18n/`, `radio/`, `recommendations/`, most of
`shell/`); `src/lib/api/` is 9 modules / 3 tests; `rate-limit-server.ts`
is only read as text by a gate, never executed.

**Test-quality smells:** one tautological assertion
(`quality-gates.test.ts:630` — `expect(clientBoundary).not.toBe("")`),
duplicated button tests coupled to Tailwind class names, 9 identical
"skeleton" assertions, and one suite (`search-components.test.ts:31-34`)
that asserts only that a mock was called.

---

## 15. LAN / plain-HTTP production-origin audit *(measured)*

| Property | `http://192.168.1.32:3100` (LAN) | `http://127.0.0.1:3100` (loopback) |
|---|---|---|
| `window.isSecureContext` | false | true |
| `"serviceWorker" in navigator` | **false** | true |
| App boots, no uncaught error | ✔ after AUR-001 (0 page errors) | ✔ |
| PlayerHost init / shutdown | 1 / 0 | 1 / 0 |
| Search, clear search, playback, queue, library, settings | ✔ all exercised | — |
| SW registration | skipped honestly (no API) | registered, scope `http://127.0.0.1:3100/` |
| Clipboard / Web Share / `crypto.randomUUID` / `crypto.subtle` / notifications | unavailable → documented fallbacks | available |
| Google OAuth over private IP | refused by Google (documented) | refused by Google |

The deployed origin is plain HTTP as well, which is exactly why AUR-001
reached production; the docs that claimed "production is served over TLS"
were corrected (§18-D1).

---

## 16. PWA audit *(static + measured)*

- Service worker (`public/sw.js`) is application-shell scope only: same-origin
  `/_next/static/*` cache-first, navigations network-first with a built-in
  offline fallback, everything else (POST, `/api/*`, cross-origin incl.
  googlevideo) network passthrough. Googlevideo is never cached — asserted by
  unit tests and by the classifier itself.
- Update is deferred, never forced: no `skipWaiting()`; control is handed
  over at `pagehide`.
- Manifest, icons (incl. maskable), shortcuts `/search` `/library` `/radio`,
  install affordance and iOS path all present and asserted by `pwa.spec.ts`.
- **Registration invariant (new, AUR-001):** the register path is now
  feature-detected with an `in` test, gated both on the *source* (E2E) and on
  the *compiled output* (`verify:client-bundle`).
- **Font preload warning (AUR-019):** not reproducible after the fix. On the
  current build the preloaded file
  `caa3a2e1cccd8315-s.p.0wgildi0cnwt9.woff2` (Geist latin subset) returns 200
  and its `FontFace` reports `status: "loaded"` — i.e. it *is* used; `/` and
  `/library` produced **zero** preload warnings *(measured)*. Chrome's hint is
  raised when a preloaded face is not consumed within a few seconds, which is
  consistent with the pre-fix crash tearing down the client tree before the
  text that consumes it painted. Harmless either way (`font-display: swap`),
  so no config was changed: `font-preload.test.ts` already pins the mono face
  to `preload: false` and deliberately keeps the sans face preloaded.

---

## 17. Findings

Severity scale: **P0** shipping blocker / data loss · **P1** serious defect or
security-relevant inaccuracy · **P2** real gap, not blocking · **P3/P4**
cosmetic, informational, hygiene.

---

### AUR-001 — Uncaught `TypeError` in a root-layout effect crashes production on any insecure origin

- **Category:** Client runtime / PWA registration
- **Severity:** P0 (fixed)
- **Location:** `src/components/pwa/service-worker-register.tsx` effect #1 (line ~64); shipped chunk `.next/static/chunks/*.js`
- **Evidence:**
  - Live production URL threw
    `TypeError: Cannot read properties of undefined (reading 'register')` at
    chunk offset 15028, followed by an `app_shutdown` / `app_initialized` loop
    that killed `PlayerHost` (observed in the browser console on
    `http://zeus…:24584`).
  - `"serviceWorker" in navigator === false` on that origin —
    `navigator.serviceWorker` is a `[SecureContext]` interface, so the
    property does not exist at all; `typeof navigator.serviceWorker` is
    `"undefined"`.
  - **Dead-code elimination proven by marker experiment:** an unconditional
    `console.debug` outside the guard survived minification while an
    identical statement *inside* `if (!container) return undefined;` did not —
    same chunk size (16886 bytes) both times, so the compiler had discarded
    the guard as unreachable. Not console-stripping, not a stale cache, not
    the wrong source (deployed chunk byte-identical to the local build).
  - Same-class scan of all 35 client chunks: clipboard (`e?.writeText`), Web
    Share (`typeof navigator.share`), `randomUUID` fallback and the PWA
    capability probe are all safe; the unsafe double-deref-inside-`typeof`
    pattern was unique to this site (only chunk containing `.register(`).
- **Impact:** every visitor on a plain-HTTP origin (the deployed origin, any
  LAN/IP deployment, any non-HTTPS mirror) got an unusable page: the root
  effect threw, React unmounted the tree, and the player initialised and shut
  down in a loop until the session died. Search, playback and navigation were
  all unreachable.
- **Root Cause:** the guard tested the *value* (`!container`) rather than the
  *presence of the interface* (`!("serviceWorker" in navigator)`), and the
  production compiler — permitted to assume `navigator.serviceWorker` is
  always defined — deleted that branch, leaving an unguarded
  `typeof container.register` on `undefined`.
- **Recommended Fix:** presence-test the interface before any dereference;
  keep the truthiness check only for TypeScript narrowing; prove it on the
  compiled artifact rather than the source.
- **Implemented:** yes.
  1. `if (!("serviceWorker" in navigator)) return;` before the container is
     read, with the root-cause comment at the site.
  2. `scanServiceWorkerGuard()` in `verify-client-bundle.mjs` fails the build
     if any chunk containing `serviceWorker` has a `.register(` not preceded
     by `serviceWorker"in navigator` (wired into `main()`, exit 1).
  3. `e2e/pwa.spec.ts`: "startup survives an origin with no service worker
     API" — deletes `Navigator.prototype.serviceWorker`, asserts the `in`
     test is false, `app_initialized` without `app_shutdown`, no page errors
     and no `register` TypeError.
  4. Documentation: `ARCHITECTURE.md` (registration invariant), `PRODUCT_SPEC.md`
     (secure-context-only registration), `docs/scope-boundaries.md`
     (plain-HTTP origins incl. the deployed one).
- **Validation:** fixed build compiled to
  `if("u"<typeof navigator||!("serviceWorker"in navigator))return;…` with
  `firstIn=14947 < firstRegister=15097` and 3 `in`-tests; live browser on the
  insecure LAN origin → `secureContext:false`, `hasSW:false`, 0 errors,
  0 `app_shutdown`; secure origin → SW registered with correct scope;
  `bun run verify:client-bundle` → OK with 1 chunk presence-tested; unit
  fixtures → 4/4; full E2E run B → 162 passed (new test included).

---

### AUR-002 — `DATABASE_URL` (with password) interpolated into thrown error messages

- **Category:** Secrets / logging
- **Severity:** P1 (fixed)
- **Location:** `src/lib/db.ts:16-19`, `scripts/verify-db.mts:17-20`
- **Evidence:** both threw
  `` `Unsupported DATABASE_URL scheme: ${url}. …` ``; `db.ts` throws at boot
  where the stack lands in stderr and any crash capture, and `verify-db.mts`
  prints to stdout (CI log). Directly contradicts `docs/security.md:64`
  ("Never log secret values").
- **Impact:** the database password is disclosed to log aggregation, CI
  output and crash dumps on every configuration mistake.
- **Root Cause:** the message interpolated the whole value where only the
  scheme is diagnostic.
- **Recommended Fix:** include the scheme only.
- **Implemented:** yes — both sites now report
  `scheme = url.slice(0, indexOf(":")+1)` (or `(none)`), keeping the message
  actionable without the credential.
- **Validation:** `grep` shows no remaining interpolation of the full URL
  (`verify-data-integrity.mts` and `verify-restore.mts` already reported only
  the protocol); lint/typecheck/unit/build/bundle-gate re-run green.

---

### AUR-003 — `docs/security.md` claimed "No rate limiting in-app"

- **Category:** Documentation vs implementation (security decision)
- **Severity:** P1 (fixed)
- **Location:** `docs/security.md:206-208` (was) vs `docs/security.md:100-112`, `ARCHITECTURE.md` §24, `src/lib/http/rate-limit.ts:188-196`
- **Evidence:** seven fixed-window buckets behind `guardServerAction` exist
  and are tested (`rate-limit-e2e.test.ts`); the same document's own
  "Rate limiting (Phase 52)" section described them.
- **Impact:** an operator reading the deployment-assumptions list would
  provision an edge limiter for a protection that exists, or — worse —
  dismiss the in-app limits as absent when reasoning about abuse.
- **Root Cause:** a stale bullet from before Phase 52 was never removed.
- **Recommended Fix:** state what is limited and what is deliberately not.
- **Implemented:** yes — bullet rewritten to describe the guard, its buckets
  and the single-instance limitation, pointing at the section above.
- **Validation:** doc-only change; reviewed against
  `rate-limit.ts:188-196` and `action-guard.ts:77-110`.

---

### AUR-004 — `docs/security.md` named the wrong module and wrong count for the `youtubei.js` import

- **Category:** Documentation vs implementation (security boundary)
- **Severity:** P1 (fixed)
- **Location:** `docs/security.md:8-10` (was) vs `innertube/session.ts:33` (value import), `playback/innertube-client.ts:27` (type-only), `youtube/__tests__/boundary.test.ts:48-85`
- **Evidence:** the named file imports only `import type { Innertube, Types }`;
  the boundary test explicitly admits two directories, and
  `innertube-client.ts:4` calls itself "one of the two modules".
- **Impact:** a reviewer auditing "is the browser bundle clean of
  `youtubei.js`?" would look at the wrong file and conclude the boundary was
  violated when it is not — undermining confidence in a real control.
- **Root Cause:** the sentence was written for an earlier one-module layout
  and never updated when the InnerTube session was split out.
- **Recommended Fix:** describe the actual boundary (one value import,
  confined to two provider-internal directories, `type`-only elsewhere).
- **Implemented:** yes.
- **Validation:** re-read of both import sites and the boundary test.

---

### AUR-005 — Migrations documented as "purely additive" (and counted as two) while one deletes rows

- **Category:** Documentation vs implementation (operational safety)
- **Severity:** P1 (fixed)
- **Location:** `ARCHITECTURE.md:649,669` and `docs/deployment.md:36-38,147` (were) vs `prisma/migrations/20260926130000_recently_played_one_row_per_track/migration.sql:31-36`
- **Evidence:** that migration executes
  `DELETE FROM "RecentlyPlayed" WHERE "id" NOT IN (…)`; eight migrations
  exist, not two; the delete is already reviewed in
  `playback-schema.test.ts:72-82`.
- **Impact:** a rollback decision made from "migrations are additive"
  assumes old code runs against the new schema *and* that no rows are lost —
  the second half was wrong, and the migration count made the analysis look
  smaller than it is.
- **Root Cause:** the sentence predates the dedupe migration and was copied
  into two documents.
- **Recommended Fix:** state the exception and the real count, pointing at
  the allowlist test that carries the rollback notes.
- **Implemented:** yes — `ARCHITECTURE.md` §13 and `docs/deployment.md`
  (migration step + Rollback) corrected; the count now says eight and names
  the allowlist test.
- **Validation:** re-read of `migration.sql`, the allowlist test, and
  `prisma/migrations/` directory listing (8 entries).

---

### AUR-006 — The equalizer was listed as a non-goal while §18 ships it

- **Category:** Documentation vs implementation (scope)
- **Severity:** P1 (fixed)
- **Location:** `PRODUCT_SPEC.md:863` and `docs/scope-boundaries.md:59` (were) vs `PRODUCT_SPEC.md:972-1088` (§18), `src/lib/audio/eq.ts`, `e2e/equalizer*.spec.ts`
- **Evidence:** the spec both shipped and forbade the feature; the same file
  documents the Phase 53 addendum.
- **Impact:** contradictory scope authority — a contributor could delete a
  shipped, tested feature believing it out of scope, or reject a fix as
  unauthorized.
- **Root Cause:** the non-goal list was written in Phase 1 and the
  equalizer's later adoption updated §18 but not §14.
- **Recommended Fix:** keep the three genuinely-absent features as non-goals
  and point at §18 for the equalizer.
- **Implemented:** yes, in both documents.
- **Validation:** re-read of `PRODUCT_SPEC.md` §18 and `docs/scope-boundaries.md`
  Phase 53 addendum.

---

### AUR-007 — Docs asserted "Production is served over TLS" for an origin that is plain HTTP

- **Category:** Documentation vs implementation (environment)
- **Severity:** P1 (fixed)
- **Location:** `docs/scope-boundaries.md:144-146` (was) vs the deployed `http://<host>:<port>` production URL
- **Evidence:** the production origin is not a secure context:
  `"serviceWorker" in navigator === false` there, and that is precisely how
  AUR-001 reached real users instead of staying a dev-only condition.
- **Impact:** the app was allowed to assume a secure context in a document
  that also told readers the opposite condition was dev-only — the enabling
  error for the P0.
- **Root Cause:** TLS was treated as an edge responsibility
  (`docs/deployment.md`) and then read back as a property of production.
- **Recommended Fix:** say the deployed origin is plain HTTP today, that TLS
  is an edge duty, and that nothing in the app may assume a secure context.
- **Implemented:** yes — the bullet now covers dev *and* deployed origins,
  names the crash that assumption caused, and points at the invariant.
- **Validation:** cross-checked against `docs/deployment.md:162-165` ("Edge
  responsibilities … TLS termination") and the live origin probe (§15).

---

### AUR-008 — `ARCHITECTURE.md` listed the infinite-listening *read* in the rate-limited set

- **Category:** Documentation vs implementation
- **Severity:** P1 (fixed)
- **Location:** `ARCHITECTURE.md:1391-1394` (was) vs `src/app/actions/listening.ts:33-54`
- **Evidence:** `getKeepListeningAction` calls neither `guardServerAction`
  nor a bucket; only the write passes the guard (feature gate, no bucket).
- **Impact:** the doc's own §24.3 rule ("reads that are cheap are not behind
  a bucket") was violated by the list itself, so neither the guard's coverage
  nor its absence could be trusted from the document.
- **Root Cause:** the sentence conflated the guarded write with the read.
- **Recommended Fix:** separate the two and state why the read is unguarded.
- **Implemented:** yes.
- **Validation:** direct read of `listening.ts:33-75`.

---

### AUR-009 — Caching section described an app-set `Cache-Control` and a cookie-only offline locale

- **Category:** Documentation vs implementation
- **Severity:** P1 (fixed)
- **Location:** `docs/security.md:143-150` (was) vs no `Cache-Control` in production source; `public/sw.js:168-182`
- **Evidence:** grep finds no `Cache-Control`/`no-store` setter in production
  code (the guarantee is Next's default + the worker's classifier), and
  `resolveOfflineLocale` prefers the remembered two-letter value, consulting
  `aurora-locale` only as a fallback — because a Chromium navigation reaches
  a worker with no cookie header.
- **Impact:** readers would look for a header the app never sets, and would
  mis-reason about which locale wins offline (the stated product guarantee in
  `PRODUCT_SPEC.md:430-439` is the remembered one).
- **Root Cause:** the paragraph described intent, then the implementation
  changed under it.
- **Recommended Fix:** attribute each guarantee to the component that
  actually enforces it.
- **Implemented:** yes.
- **Validation:** re-read of `public/sw.js:147-182` and a repo-wide grep for
  `Cache-Control`.

---

### AUR-010 — `likeTrackAction` writes a fully unvalidated client `Track` into the shared catalog

- **Category:** Input validation / data integrity
- **Severity:** P2 (classified, not implemented)
- **Location:** `src/app/actions/track.ts:7-17`; `src/lib/validation/schemas.ts:117-121`
- **Evidence:** no zod schema is applied before `upsertTrack`, while the
  playlist path validates with `addTrackSchema`; that schema's nested
  `title`/`artistName` are unbounded `z.string()`.
- **Impact:** arbitrary-length display fields (and arbitrary keys that
  `upsertTrack` happens to accept) can be written into a table shared by all
  users — storage/integrity abuse, not injection (Prisma is parameterised and
  `streamUrl`/`previewUrl` are excluded at the DAL).
- **Root Cause:** the like path was written before the Phase 49 write-path
  rules and never re-validated.
- **Recommended Fix:** a `trackInputSchema` (bounded strings, required
  identity fields, URL-shaped fields stripped) applied in both actions, plus
  length bounds in `addTrackSchema`.
- **Implemented:** no — needs a schema + DAL contract decision and DB tests;
  doing it inside an audit pass would be a behavior change without a failing
  test driving it.
- **Validation:** static (grep for `upsertTrack` call sites, read of both
  actions and the schemas).

---

### AUR-011 — Auth.js's own CSRF check is skipped on the sign-in/out server-action path

- **Category:** Security posture (documented gap)
- **Severity:** P2 (documented; code unchanged)
- **Location:** `node_modules/next-auth/lib/actions.js:44,65,81` (`skipCSRFCheck`); `next.config.ts` (no `serverActions.allowedOrigins`)
- **Evidence:** next-auth's server-action path passes `skipCSRFCheck`; Next
  16's Origin↔Host comparison then applies, and per Next's own docs a
  request with **no** `Origin` header is allowed with a warning.
- **Impact:** low but undocumented: protection for these two mutations rests
  on Next's origin check + `SameSite=Lax`, not on Auth.js's double-submit
  token.
- **Root Cause:** framework default; nothing in the app weakens it, and
  nothing recorded it.
- **Recommended Fix:** either record the posture (chosen) or add an explicit
  origin assertion in `signInWith`/`signOutUser`.
- **Implemented:** posture recorded in `docs/security.md` (Auth / session);
  no code change.
- **Validation:** re-read of the cited next-auth and Next docs in
  `node_modules`.

---

### AUR-012 — OAuth tokens stored plaintext in the database, undocumented

- **Category:** Security posture
- **Severity:** P2 (classified)
- **Location:** `prisma/schema.prisma:58-64` (`access_token`, `refresh_token`, `id_token`)
- **Evidence:** no encryption-at-rest configured in app code; `docs/security.md`
  does not mention the column.
- **Impact:** database disclosure yields long-lived provider tokens for every
  linked account.
- **Root Cause:** Auth.js adapter default.
- **Recommended Fix:** document the reliance on DB encryption/backup
  discipline, or encrypt at rest via a KMS/envelope key.
- **Implemented:** no (deployment/architecture decision, not an audit fix).
- **Validation:** static.

---

### AUR-013 — Ten server actions and all three HTTP routes carry no rate bucket

- **Category:** Abuse resistance
- **Severity:** P2 (classified)
- **Location:** `appearance.ts`, `artist.ts`, `audio-eq.ts`, `auth.ts`,
  `install.ts`, `locale.ts`, `playback-state.ts` (save/clear),
  `search.ts` (history), `track.ts` (like/unlike); `/api/health`,
  `/api/app-config`, `/api/auth/*`
- **Evidence:** `grep guardServerAction|guardRateLimit` across
  `src/app/actions/`; buckets enumerated in `rate-limit.ts:188-196`.
- **Impact:** cheap DB writes (likes, history, appearance, locale) can be
  hammered per identity; `/api/health` and `/api/app-config` are unthrottled
  (the latter is `force-static`).
- **Root Cause:** buckets were added for provider-touching/expensive paths
  only — the documented rule — and the list was never revisited.
- **Recommended Fix:** bucket the write-shaped actions
  (`track.like`, `search.history`, `appearance`, `audio-eq`) with generous
  windows; leave pure reads.
- **Implemented:** no (would change user-visible failure modes; needs a
  deliberate window choice).
- **Validation:** static (per-action guard grep).

---

### AUR-014 — Most server actions swallow the underlying error and log nothing

- **Category:** Observability
- **Severity:** P2 (classified)
- **Location:** `playlist.ts:60,88,137,157,204,225,250,264`, `listening.ts:51-53,72-74`,
  `locale.ts:39-41`, `appearance.ts:157-159`, `track.ts:14-16,29-31`
  (contrast: `playback-resolve.ts:109-121` logs properly)
- **Evidence:** each returns a fixed string with no `logger.*` call.
- **Impact:** safe for disclosure (no stack/PII to the client) but invisible
  in operations — a failing playlist write looks identical to "nothing
  happened" in the logs.
- **Root Cause:** disclosure-first habit applied uniformly.
- **Recommended Fix:** `logger.warn` with the error class + action name (no
  payload), following the `playback-resolve` pattern.
- **Implemented:** no (touches 8 files; classify first so the pattern can be
  chosen once).
- **Validation:** static (grep of `catch` blocks in `src/app/actions`).

---

### AUR-015 — CI does not run live playback, the mobile projects, coverage or an a11y scanner

- **Category:** Test/CI gaps
- **Severity:** P2 (classified)
- **Location:** `package.json:19` (`--project=chromium`),
  `.github/workflows/ci.yml:77-80`, `vitest.live.config.mts`, `playwright.config.ts:31-90`
- **Evidence:** live specs self-skip without `AURORA_E2E_LIVE_PLAYBACK`,
  which CI never sets for Vitest; `mobile-chromium` (Pixel 7) and
  `mobile-landscape` (iPhone 15 Pro Max) projects exist but are never invoked
  by any script; no `@vitest/coverage-*` in `package.json`; no axe
  integration; `smoke:prod` runs twice per push (`ci.yml:94` and `:95-106`).
- **Impact:** mobile layout and live playback regressions can merge green;
  there is no objective coverage or WCAG number to regress against.
- **Root Cause:** live/mobile/opt-in decisions made for local runs and never
  revisited for CI.
- **Recommended Fix:** add a scheduled or labelled CI job for
  `--project=mobile-chromium`, add coverage reporting (report-only first),
  add `@axe-core/playwright` on 2–3 core pages, drop the duplicated smoke
  step.
- **Implemented:** no (CI policy change; classify).
- **Validation:** static (read of `ci.yml`, both vitest configs, the
  playwright config and `package.json` scripts).

---

### AUR-016 — Three different request ids are minted for one rate-limit denial

- **Category:** Observability / support
- **Severity:** P3 (classified)
- **Location:** `rate-limit-server.ts:179`, `action-guard.ts:85,106`, `api/transport.ts:39-44`
- **Evidence:** each site calls `newRequestId()` independently; the id a user
  sees in the response is not the id in the log line.
- **Impact:** the correlation promise in `docs/security.md:121-126` is only
  partially true, slowing incident diagnosis.
- **Root Cause:** ids minted per call site instead of once per request.
- **Recommended Fix:** mint in the transport layer and pass down.
- **Implemented:** no (P3).
- **Validation:** static.

---

### AUR-017 — CSP remains permissive in three directives

- **Category:** Security posture (documented tradeoff)
- **Severity:** P3 (classified, no change)
- **Location:** `next.config.ts:27-47`
- **Evidence:** `'unsafe-inline'` in `script-src` and `style-src`;
  `img-src https: http: data: blob:`; `media-src https:`; `connect-src ws: wss:`
  — all mirrored and justified in `docs/security.md:67-78`.
- **Impact:** XSS blast radius is larger than a nonce-based CSP would allow.
- **Recommended Fix:** nonces via a middleware-level CSP when a rendering
  strategy allows it; tighten `img-src` to the hosts actually used.
- **Implemented:** no — explicitly documented and out of scope for this pass.
- **Validation:** static + `security-headers.test.ts`.

---

### AUR-018 — `rateLimiter.forget()` promises a sign-out reset that never happens

- **Category:** Hygiene / dead code
- **Severity:** P3 (classified)
- **Location:** `src/lib/http/rate-limit.ts:59-60`
- **Evidence:** declared with a "clear on sign-out" comment; no production
  call site.
- **Impact:** none functionally (budgets are per-identity), but the comment
  states a behavior the app does not have.
- **Recommended Fix:** either call it from `signOutUser` or rewrite the
  comment to say why it exists.
- **Implemented:** no (P3).
- **Validation:** static (grep for `forget(`).

---

### AUR-019 — Preloaded font reported as unused (secondary warning)

- **Category:** PWA / performance hygiene
- **Severity:** P3 (classified harmless; no change)
- **Location:** `src/app/layout.tsx:17-30` (`Geist`, `subsets:["latin"]`,
  preload left on), preloaded file
  `.next/static/media/caa3a2e1cccd8315-s.p.0wgildi0cnwt9.woff2`
- **Evidence (measured):** on the fixed production build `/` and `/library`
  produce **no** preload warnings; the face returns 200 and
  `document.fonts` reports it `status: "loaded"` (used), alongside the
  latin-ext and vietnamese subsets. The mono face is already `preload: false`
  under `src/app/__tests__/font-preload.test.ts`, which is the guard for this
  exact warning class.
- **Impact:** at worst one ~29 KiB fetch that goes unconsumed on a page view
  where the text never paints (consistent with the pre-fix crash tearing the
  tree down); `font-display: swap` guarantees a fallback either way.
- **Root Cause:** Chrome raises the hint when a preloaded face is not
  consumed within a few seconds of the preload.
- **Recommended Fix:** none required. If it ever recurs on a healthy page,
  narrow the subsets or set `preload:false` for the offending face — but only
  with the `font-preload.test.ts` guard updated, never by suppressing the
  warning.
- **Implemented:** no change (per instruction: do not churn code to silence a
  warning that investigation shows is harmless).
- **Validation:** font-face status + zero-warning console query on the fixed
  build (§16).

---

### AUR-020 — `canonical-dedupe.spec.ts` fails on baseline and on every run of this session

- **Category:** Test/product defect (pre-existing)
- **Severity:** P2 (classified; **not** attributable to this session's changes)
- **Location:** `e2e/canonical-dedupe.spec.ts:114,134,155` (helpers at
  `:87,110,165`)
- **Evidence:** fails identically on the untouched baseline and on both runs
  this session (run A and run B, 3/3 each time). Failure modes are locator
  timeouts (`Actions for <title>` not clickable, `locator.fill` timeout) and
  one deep-equality mismatch — while the server logs
  `PLAYBACK_RESOLUTION_ERROR` for `e2e-track-1` throughout. A fourth,
  unrelated failure in run A (equalizer keyboard) did not reproduce in run B
  or in isolation.
- **Impact:** three canonical-dedupe guarantees (one membership per playlist,
  one queue entry per track across provider renderings) are unverified in CI;
  either the dedupe or the fixture path has regressed.
- **Root Cause:** **not established in this session.** Two live hypotheses:
  (a) the UI fixture path depends on playback resolution that fails for
  `e2e-track-*`, so the action menu never reaches its final state; (b) a real
  dedupe regression.
- **Recommended Fix:** run the three tests with `--debug` against a fixture
  whose resolution succeeds (or mock the resolver) and assert the *data*
  rather than the menu state; if (b), fix the canonicalisation.
- **Implemented:** no (root cause unknown; a fix without one would be
  speculative).
- **Validation:** both full E2E runs + screenshots/error context under
  `test-results/`.

---

### AUR-021 — Home sections are capability-gated, but the spec said "Implemented" flatly

- **Category:** Documentation vs implementation
- **Severity:** P3 (fixed)
- **Location:** `PRODUCT_SPEC.md:40` (was) vs `providers/server.ts:111`,
  `youtube-provider.ts:50-56,267-295`, `page.tsx:107,119,131,144`
- **Evidence:** `fetchHomeSections` queries only the preferred provider, and
  YouTube advertises none of popular/featured/recommendations/albums; the
  page renders those sections only when supported and shows an honest empty
  state otherwise. Only the fake test provider advertises them.
- **Impact:** a reader would expect five populated sections on a
  key-configured deployment and find two.
- **Recommended Fix:** say the sections are capability-gated.
- **Implemented:** yes — capability row now reads "recommendations always;
  popular / featured / albums / artists when the active provider advertises
  those capabilities".
- **Validation:** static (re-read of `server.ts`, `youtube-provider.ts`,
  `page.tsx`).

---

## 18. Documentation vs implementation discrepancy list

Each row: **(D#) doc claim — code reality — disposition.**

| # | Document claim | Implementation reality | Disposition |
|---|---|---|---|
| D1 | `scope-boundaries.md` — "Production is served over TLS" | deployed origin is plain HTTP (not a secure context) | **corrected** (AUR-007) |
| D2 | `security.md` — "No rate limiting in-app" | 7 buckets behind `guardServerAction` | **corrected** (AUR-003) |
| D3 | `security.md` — "`youtubei.js` imported by exactly one module (`playback/innertube-client.ts`)" | value import in `innertube/session.ts`; type-only in the named file; two directories admitted | **corrected** (AUR-004) |
| D4 | `ARCHITECTURE.md` / `deployment.md` — "migrations purely additive", "both current migrations" | 8 migrations; one contains a reviewed `DELETE` | **corrected** (AUR-005) |
| D5 | `ARCHITECTURE.md` — `RecentlyPlayed` = "play events" | one row per (user, track), explicitly *not* a play-event log | **corrected** |
| D6 | `PRODUCT_SPEC.md` §14 + `scope-boundaries.md` — "Equalizer" is a non-goal | §18 ships it, with tests and E2E | **corrected** (AUR-006) |
| D7 | `security.md` — CSRF described as Auth.js's | sign-in/out server actions skip Auth.js's check (Next origin check + Lax) | **documented** (AUR-011) |
| D8 | `ARCHITECTURE.md` — infinite-listening *read* is rate limited | read has no guard/bucket | **corrected** (AUR-008) |
| D9 | `PRODUCT_SPEC.md` — home sections "Implemented" | capability-gated; popular/featured/albums absent with YouTube | **corrected** (AUR-021) |
| D10 | `security.md` — dynamic routes send `private, no-cache` | no app code sets `Cache-Control`; Next defaults + SW classifier do the work | **corrected** (AUR-009) |
| D11 | `security.md` — offline page built from the `aurora-locale` cookie | remembered two-letter value first, cookie second | **corrected** (AUR-009) |
| D12 | `scope-boundaries.md` — "30 packages / 27 route files / 15 scripts" | 26 direct packages / 12 pages + 3 API routes / 17 scripts | **corrected** |
| D13 | `deployment.md` — `## Rollback## Rollback` heading | malformed heading | **corrected** |
| D14 | `security.md:42-43` + `env.ts:24-26` — E2E flags "registered in the schema rather than read ad hoc" | 4 direct `process.env` reads (boot still fails closed via `parseEnv`) | listed, **not changed** (P4: the boot guard holds; wording only) |
| D15 | `e2e/pwa.spec.ts:414-415` — comment still says the offline locale comes from the cookie | worker prefers the remembered value | listed, **not changed** (P4: test comment) |
| D16 | `PRODUCT_SPEC.md` §? — appearance preset "exactly those five values" | presets set six (incl. `backgroundDim`) | **corrected** |

---

## 19. Classification summary

| Severity | Count | IDs | Implemented |
|---|---|---|---|
| P0 | 1 | AUR-001 | **1 / 1** |
| P1 | 9 | AUR-002…AUR-009, AUR-011(doc part) | **9 / 9** (AUR-011 posture documented, code deferred as P2) |
| P2 | 6 | AUR-010, AUR-012, AUR-013, AUR-014, AUR-015, AUR-020 | 0 (classified with recommendations) |
| P3/P4 | 5 | AUR-016…AUR-019, D14, D15 | 1 doc-adjacent (AUR-019 investigated, no change by design) |

Deliberately **not** findings, because they are documented exclusions:
CORS-clean media delivery / pre-engagement EQ probe (`ARCHITECTURE.md` §33.8,
`docs/scope-boundaries.md`), push notifications, crossfade/gapless/sleep
timer, lyrics/social, edge TLS, single-instance rate limiting, no
`window-controls-overlay`.

---

## 20. Validation results

*(final run of this session; logs under `%TEMP%\opencode\`)*

| Gate | Result |
|---|---|
| `bun run lint` | **PASS** (exit 0) |
| `bun run typecheck` | **PASS** (exit 0) |
| `bun run test` | **PASS** — 193 files / 2786 tests, 0 failures (43 s) |
| `bun run build` | **PASS** — "Compiled successfully", exit 0 |
| `bun run verify:client-bundle` | **PASS** — 35 chunks scanned, 39 assets measured, 1 service-worker registration chunk presence-tested; budgets 335.8/400 KiB JS, 71.6/100 KiB chunk, 14.9/20 KiB CSS |
| `bunx playwright test` (run B, full) | **162 passed, 20 skipped, 3 failed** (pre-existing `canonical-dedupe` trio = AUR-020) |
| `bunx playwright test` (run A, full) | 161 passed, 20 skipped, 4 failed — the 4th (equalizer keyboard) did not recur |
| `bunx playwright test e2e/equalizer.spec.ts:217` (isolation) | **3 passed** (run A failure was a flake) |
| Live browser, insecure LAN origin | 0 page errors, 0 `app_shutdown`, `hasSW:false`, shell + player + search + library all functional |
| Live browser, secure loopback origin | SW registered with correct scope, 0 errors |

`e2e/.auth/` cleaned after the runs; the temporary LAN-QA account
(`lan-qa@aurora.local`) was deleted with its cascade and its two helper
scripts removed from the tree.

---

## 21. Blocked / not verifiable in this environment

- **Real-device QA (Android/iPhone):** no physical device. The 27-step phone
  flow, install prompt on device, iOS standalone shell and touch-target feel
  are **BLOCKED**; host-side evidence only (mobile Playwright projects are
  defined but, per AUR-015, are not run by CI either).
- **Deployment of AUR-001 to the production URL:** no deploy access from this
  machine. The fix was verified locally under identical insecure-origin
  conditions; the deployed origin still shows the pre-fix crash until the
  next deploy.
- **Google OAuth over plain HTTP private IP:** refused by Google
  (`device_id and device_name are required for private …`); **GitHub OAuth:**
  unverified (no real credentials). Sign-in coverage is therefore fixture-
  and unit-level.
- **Secure-context-only capabilities on plain HTTP:** PWA install/offline,
  Web Share, `crypto.subtle`, `crypto.randomUUID`, notifications are withheld
  by the browser — capability limits of the origin, not Aurora bugs.
- **Live provider catalog behaviour:** `.env` credentials for YouTube Data /
  Spotify / Deezer are invalid; only the keyless InnerTube path was
  exercised.
- **`bun run test:db` / `db:verify` / restore drill:** not re-run in this
  session (they need a live PostgreSQL); they are green in CI and were run in
  an earlier pass.
- **AUR-020 root cause:** not established (see the finding).
