# Aurora Music — Architecture

Canonical technical architecture. Describes the system **as implemented**.
Documenting, not changing, the architecture.

Hierarchy: production code > Prisma schema / executable contracts >
automated tests and gates > `PRODUCT_SPEC.md` > this document >
`docs/security.md` > `docs/deployment.md` > `docs/scope-boundaries.md` >
historical phase reports.

---

## 1. Architectural overview

Playback path:

```text
UI (React Server + Client Components)
 ↓
server actions / API routes
 ↓
domain / MusicEngine (facade)
 ↓
playback (PlaybackController) / queue (PlayerStore + QueueManager)
 ↓
providers / resolver (PlaybackResolver → YouTubeResolver)
 ↓
browser media (PlayerEngine → HTMLAudioElement)
```

Persistence path:

```text
server actions
 ↓
DAL (ownership + transactions)
 ↓
Prisma
 ↓
PostgreSQL
```

Auth path:

```text
Auth.js (Google/GitHub, JWT)
 ↓
JWT cookie
 ↓
auth()
 ↓
requireUser() / getSessionUserId()
 ↓
DAL (ownership recheck)
```

Key files: `src/lib/music/music-engine.ts`, `src/lib/player/engine.ts`,
`src/lib/player/store.ts`, `src/lib/music/queue-manager.ts`,
`src/lib/playback/controller.ts`, `src/lib/playback/resolver.ts`,
`src/lib/playback/recovery.ts`,
`src/lib/providers/youtube/playback/youtube-resolver.ts`,
`src/lib/providers/extractor-manager.ts`, `src/lib/dal/*`,
`src/instrumentation.ts`, `src/app/api/health/route.ts`.

## 2. Single-authority invariants

| Authority | Owner | Owns |
|---|---|---|
| `MusicEngine` | `src/lib/music/music-engine.ts` + `instance.ts` | Sole high-level facade; orchestration only |
| `PlayerEngine` / store | `src/lib/player/engine.ts` + `store.ts` | One persistent audio element; sole queue/state container |
| `QueueManager` | `src/lib/music/queue-manager.ts` | Typed queue facade; zero state (delegates to store) |
| `PlaybackController` | `src/lib/playback/controller.ts` | Sole playback orchestration; active source, intent, generations |
| Recovery | `src/lib/playback/recovery.ts` (policy) + controller (execution) | One bounded retry budget |
| Media Session | `src/lib/player/media-session.ts` | Sole OS-media-key surface |
| Diagnostics | `src/lib/diagnostics/logger.ts` | Sole logging path, secret-safe |
| DAL ownership | `src/lib/dal/*` | Sole persistence + ownership authority |

## 3. MusicEngine

Canonical high-level facade over existing subsystems (`No duplicated player,
queue, persistence, registry, or resolver state`).

- Transport delegates to the player store (which routes through
  `PlaybackController` when bound); search delegates to `UnifiedSearch`;
  events derive from `PlayerEngine` signals plus command transitions.
- Exposes state (`currentTrack`, `queue`, `currentIndex`, `isPlaying`,
  `position`, `duration`, `volume`, `shuffle`, `repeat`, `isResolving`,
  `error`) and subscriptions; `EMPTY_ENGINE_STATE` for SSR/unmounted.
- Lifecycle holder (`instance.ts`): `set/get/subscribeMusicEngine`;
  `PlayerHost` mounts and clears it — one mounted facade at a time.
- Does **NOT** own: player element, queue array, persistence, provider
  registry, resolver state, matching, or merging.

## 4. PlayerEngine

Single persistent audio engine (`src/lib/player/engine.ts`):

- Exactly one `AudioSurface` (`HTMLAudioElement` abstraction, injectable for
  tests); `src` + `load()` mutated per track.
- `play / pause / seek / volume / mute`; `PlayerError(kind: unavailable |
  playback | autoplay)` with user-safe messages; media error codes carried
  for controller classification only, never serialized to UI.
- `timeupdate` relay throttled (`TIMEUPDATE_THROTTLE_MS = 250`) to bound
  React re-renders; idempotent listener cleanup (StrictMode-safe).
- Owns no queue, resolution, persistence, or UI.

## 5. QueueManager / PlayerStore

The Zustand `PlayerStore` is the authoritative state container
(`currentTrack`, `queue`, `playOrder`, `position`, `shuffle`, `repeat`,
`volume`, `qualifiedTrackKey`, `userActionGeneration`, restore guards).

- Physical `queue: Track[]` + logical `playOrder: number[]`; `position` is
  the cursor within `playOrder`. Shuffle reorders `playOrder` only.
- Public indices are positions within `playOrder`, not raw queue indices.
- `QueueManager` owns **no** queue array, listeners, timers, or caches —
  reads fresh store state per call, delegates every mutation via the single
  `QueueManager → PlayerStore` path. Shuffle/repeat/navigation edge cases
  deliberately stay in the store (covered by its suites).
- `QueueManager` does not own a second queue array. A shadow queue cannot
  diverge by construction.

## 6. PlaybackController

Sole playback orchestration authority:

```text
TrackIdentity → PlaybackController → PlaybackResolver → AudioSource
  → PlayerEngine → HTMLAudioElement
```

- Owns the active resolved source (memory only), transport intent
  (`wantPlay`), monotonic resolution generations, and the ephemeral recovery
  machine. Owns no queue, persistent state, recently-played logic, identity
  mutation, or URL persistence.
- Single playback path: the **only** way a URL reaches `PlayerEngine` is
  `withPlaybackSource` carrying a freshly resolved `AudioSource`. Legacy
  `streamUrl` / `previewUrl` are never read — not even as fallback. A track
  without a resolvable YouTube source reports unavailable; the queue stays
  valid.
- Generations: every load claims a monotonic generation; stale results are
  inert (ignored, not aborted). Pause/next/stop win by flag or superseding
  generation.
- Recovery execution: one cycle per generation, same stable identity, bounded
  attempts with backoff, reload at saved position (latest seek wins),
  pause-wins-on-intent, suppression after exhaustion.
- Expiry: expired sources never load; play/resume re-resolves once per
  request; mid-playback expiry surfaces reactively (engine error/stall),
  never via polling.

## 7. PlaybackResolver

```text
identity / source → provider resolution → source validation → AudioSource
```

- Inspects an identity's sources **in order**, delegates to the first source
  type with a registered resolver. Today that means `youtube` only;
  Deezer/Spotify sources are skipped as metadata-only, producing a staged
  `match` failure ("No playable source in this identity").
- Enforced separations: no matching, no merging (identities untouched,
  ordering preserved), no ranking (identity order wins, not provider
  prestige), no persistence.
- Exact YouTube IDs: `youtube-resolver` handles only `youtube:VIDEO_ID`,
  validates the ID, rejects private/upcoming/live/mismatched responses with
  staged `PlaybackResolutionError(resolve | stream)`.
- Temporary URLs are memory-only; expiry is checked before handoff
  (`isAudioSourceExpired`); re-resolution is the recovery path, never reuse.

## 8. YouTube playback adapter

`src/lib/providers/youtube/playback/` (`innertube-client.ts`,
`format-selection.ts`, `format-validation.ts`, `youtube-resolver.ts`,
`types.ts`). Server-only (`youtubei.js` imported by exactly one module).

- **Innertube:** sole import of `youtubei.js`; format discovery;
  deciphering; in-flight request dedup (simultaneous resolutions share one
  request); results never cached (an expired URL can never be re-served);
  library objects treated as untrusted input, fail closed.
- **Format discovery:** adaptive audio formats preferred; muxed audio+video
  acceptable last resort; video-carrying formats never outrank audio-only;
  MIME `audio/mp4` > `audio/webm` > other; higher bitrate wins;
  URL-lexicographic tie-break.
- **Browser-shaped range validation (critical rule):**

  ```text
  Some adaptive URLs may return 403 for the browser's initial open-ended
  range request even when bounded ranges can return 206. These candidates
  are therefore validated before becoming AudioSources.
  ```

  The probe mirrors the browser's first request (`Range: bytes=0-`,
  status only, body cancelled, 5s timeout, URL never logged/returned);
  only 200/206 is consumable. A resolved YouTube URL is **not**
  automatically considered browser-playable. Rejected adaptive candidates
  fall through to the documented muxed fallback while preserving
  audio-only preference.
- **Expiry:** `expiresAt` carried on the `AudioSource`; expired candidates
  skipped at selection and rejected at load.

## 9. Provider architecture

```text
ExtractorManager
 ↓
YouTube / Deezer / Spotify (single canonical registry)
```

- One registry (`Map<ProviderId, MusicProvider>`); `ExtractorManager` owns
  no store — fan-out search ordering (`youtube, deezer, spotify`) and outcome
  aggregation only.
- **Capability gating:** `ProviderCapability` set per provider
  (`search.tracks/artists/albums`, `tracks.get/popular/featured/
  recommendations`, `albums/albums.tracks`, `artists/artists.tracks`,
  `stream`); server `safeFetch` maps to `success / unsupported / failed`.
- **Normalization:** provider payloads → canonical domain (`Track`,
  `Artist`, `Album`); meaningful distinctions preserved, never destroyed.
- **Metadata/playback separation:** only YouTube carries playback
  resolution (and only when its playback client is injected). Deezer and
  Spotify declare `stream: false`; `previewUrl` is 30s-preview metadata.
  No Spotify Web Playback SDK, no Deezer direct playback, no audio
  extraction/ripping (asserted by boundary tests).
- **Provider independence:** UI never imports provider internals (only
  `@/lib/providers/server` from `.tsx`); registration is credential-gated
  and idempotent (YouTube: `YOUTUBE_API_KEY`; Spotify: client-id + secret
  pair; Deezer: unconditional, keyless).

## 10. Track model

```text
Track ── provider-scoped catalog row (frozen streamUrl/previewUrl, never playback input)
TrackIdentity ── logical track (Aurora cuid id, sources[], primarySource)
SourceReference ── stable per-provider external id (source:id, display url, isrc/channel/album/artist metadata)
SearchResult ── engine search envelope (items, query, sources, total, nextOffset)
AudioSource ── ephemeral play-time source (url, mimeType, durationMs, expiresAt, bitrate)
```

- Internal Aurora ID (`cuid`) is never derived from a provider hash.
- `sources` grows **only** through explicit `mergeSourceReference`; automatic
  cross-provider matching that invents references is forbidden.
- Playback persists only `TrackRef` (`provider` + `providerTrackId`); a
  fresh `AudioSource` is resolved on restore. No persisted temporary stream
  URL anywhere (no DB columns, storage APIs, SW caching, or test fixtures).

## 11. TrackMatcher

Deterministic pairwise `TrackIdentity × TrackIdentity → exact | strong |
possible | rejected`. Pure, symmetric, no I/O, no randomness.

- Same-provider same-source id → `exact` immediately.
- Otherwise weighted evidence (title, artists, duration, ISRC, album,
  version) plus an independent hard-rejection layer (semantic contradictions
  reject regardless of score). False positives treated as worse than misses;
  only same-source agreement is exact by construction.
- **When matching is used:** unified search grouping of cross-provider
  candidates into canonical identities.
- **When matching is forbidden:** exact YouTube resolution (no search, no
  substitution); playback recovery (same stable identity, no matcher, no new
  sources); identity growth outside explicit `mergeSourceReference`.

## 12. DAL / persistence

Sole persistence + ownership authority (`src/lib/dal/*`):

- Modules: `catalog` (upsert/find, provider-keyed), `session`
  (`getCurrentUser / requireUser / getSessionUserId`), `like`, `follow`,
  `recently-played` (qualified-play gating), `search-history`,
  `playback-state`, `playlist`, `library` (overview), `mappers`.
- **Transaction boundaries:** playlist reorder uses two-phase position
  shifts under the `@@unique([playlistId, position])` constraint; catalog
  upserts precede playlist-track links.
- **Unique constraints:** `Like(userId, trackId)`, `Follow(userId,
  artistId)`, `PlaylistTrack(playlistId, trackId)` and `(playlistId,
  position)`, catalog `@@unique(provider, providerXId)`.
- **Playback-state CAS:** `revision` compare-and-swap (`updateMany where
  revision`); first checkpoint accepts only revision 0; newer-save-wins;
  stale writes return `false`, never overwrite.
- Every mutation takes a server-resolved `userId`; ownership rechecked
  (`requirePlaylistOwner` → `ResourceNotFoundError` / `AuthorizationError`).
  Client `isOwner` flags are display-only.

## 13. Database

PostgreSQL via Prisma 7 (`prisma/schema.prisma`; migrations in
`prisma/migrations/`; live: `postgresql_baseline`, `add_playback_state`).
Client emitted to `src/generated/prisma`.

| Model | Purpose |
|---|---|
| `User` | Identity; owns library rows |
| `Account` | OAuth linkage (`@@unique(provider, providerAccountId)`) |
| `Session` | DB session rows (JWT strategy primary) |
| `VerificationToken` | Auth.js verification (`@@unique(identifier, token)`) |
| `Artist` | Catalog artist (`@@unique(provider, providerArtistId)`) |
| `Album` | Catalog album (`@@unique(provider, providerAlbumId)`) |
| `Track` | Catalog track (`@@unique(provider, providerTrackId)`; frozen `streamUrl/previewUrl` never playback input) |
| `Like` | User–track favorite (`@@unique(userId, trackId)`) |
| `Follow` | User–artist follow (`@@unique(userId, artistId)`) |
| `RecentlyPlayed` | Play events (`@@index(userId, playedAt)`) |
| `SearchHistory` | Query log (`@@index(userId, searchedAt)`) |
| `Playlist` | User playlist (title, description, artwork URL) |
| `PlaylistTrack` | Membership (`position`, `addedAt`; dual uniques) |
| `PlaybackState` | One row per user (`userId @unique`: provider, providerTrackId, position, revision) |

Migrations are purely additive to date; deploy explicitly via
`prisma migrate deploy` — never auto-migrated at boot. New migrations fail
the allowlist test closed until the rollback analysis is redone.

## 14. Authentication architecture

- Auth.js (NextAuth v5 beta): Prisma adapter, **JWT session strategy**,
  `trustHost: true`, `secret = AUTH_SECRET` (production-required).
- Providers built conditionally (`buildProviders`): Google and GitHub each
  added only when its ID + secret pair is present; zero providers is a valid
  boot state.
- Session callback maps `token.sub → session.user.id`; no custom cookie or
  session code; Auth.js default secure cookies.
- Server data access: `auth()` → `getCurrentUser()` (nullable) /
  `requireUser()` (throws `AuthenticationError`) / `getSessionUserId()`.
  Mutations require a user; the DAL rechecks ownership per resource.
- Sign-out redirects to fixed `/`; no open redirects anywhere.

## 15. PWA architecture

- **Manifest** (`public/manifest.webmanifest`): `Aurora`, standalone,
  `start_url/scope /`, theme/background `#08070d`, 192/512/maskable icons.
- **Service worker** (`public/sw.js`, Phase 20): application-shell scope
  only — never resolves, proxies, or caches audio; never touches provider,
  auth, or user data. Classifier: same-origin `/_next/static/*` →
  cache-first; top-level navigations → network-first with built-in offline
  fallback; everything else (POST, `/api/*`, cross-origin incl.
  `googlevideo.com`, images) → network passthrough with zero worker
  overhead.
- **Cache version:** single `aurora-sw-v1:static`; activation deletes older
  `aurora-` caches, never foreign caches; no HTML ever cached.
- **Offline fallback:** built-in page ("music playback requires an internet
  connection") with retry link.
- **googlevideo passthrough + API passthrough:** identified first, never
  intercepted beyond identification, never cached (unit-tested classifier).

## 16. Error architecture

```text
domain errors → technical classification → user-facing mapping → ErrorFallback / UI
```

```text
playback → PlayerError → controller classification → recovery or terminal state
```

- Domain/technical layer: `AuroraError` family (`Config`, `Api`,
  `Provider`, `Authentication`, `Authorization`, `ResourceNotFound`,
  `Conflict`) + domain errors (`Extractor`, `Normalization`,
  `PlaybackResolutionError` with `match/resolve/stream` stages,
  `TrackNotFound`, `TrackMatch`) + `PlayerError`.
- User-facing mapping (`toUserFacingError`): pure, total, never throws,
  never leaks — curated messages, URL scrubbing, offline detection,
  `preservePlayback: true` always. Categories: network, offline,
  authentication, not-found, unsupported, playback-unavailable,
  provider-unavailable, validation, unknown.
- UI: route `error.tsx` boundaries map via `toUserFacingError(error,
  { online })`; `ErrorFallback` (`role=alert`, Try again / Back home) never
  resets the engine; per-section inline warnings for provider `failed`;
  `notFound()` UI for missing/unsupported catalog entities.

## 17. Diagnostics architecture

- Sole logger (`src/lib/diagnostics/logger.ts`, Phase 25): synchronous
  console only — no timers, buffering, remote collector, persistence, or
  telemetry sink. Structured primitive fields chosen at each call site.
- **Levels:** production emits info+; test emits error+; else all.
  Overridable in tests (`setLogLevel/setLogSink`).
- **Redaction:** forbidden keys (`secret|token|passwd|password|cookie|
  authori|credential|session|private-key|api-key|database|connectionstring`)
  dropped; `*url` keys dropped fail-closed; URL-shaped values redacted;
  exact presence-bit flags (`database`, `authSecret`, `youtube`, `spotify`)
  allowlisted as booleans. Client-safe, no Node APIs, no import side
  effects.
- **Event categories:** server boot, configuration errors, playback
  resolution/recovery, format skips, persistence checkpoints — always
  secret-free.
- **No external telemetry provider is part of the architecture.**

## 18. Security boundaries

- **Client/server boundary:** providers are server-only (`youtubei.js` via
  exactly one module); no `.tsx` imports provider implementations (only
  `@/lib/providers/server`); browser receives serialized `AudioSource`s.
- **Server-only providers:** credentials live in server env, never
  `NEXT_PUBLIC_*` (none exist in source or `.env.example`); absent
  credentials disable providers, never break boot.
- **Environment protection:** `DATABASE_URL` required everywhere;
  `AUTH_SECRET` production-required; boot validation reports names only.
- **CSP/headers** (`next.config.ts`): `nosniff`,
  `strict-origin-when-cross-origin`, `DENY` framing, camera/mic/geolocation
  off; CSP compatibility-scoped (`unsafe-inline` kept for App Router
  hydration + style attributes; dev-only `unsafe-eval`); `frame-ancestors
  'none'`, `object-src 'none'`, `media-src https:`, `form-action 'self'`.
  Deliberately absent: HSTS (edge TLS concern), COOP/COEP/CORP (breaks
  cross-origin media/artwork).
- **Auth/session protection:** JWT HttpOnly/SameSite=Lax cookies;
  server-side ownership enforcement; fixed sign-out target.
- **Playback URL handling:** memory-only ephemeral URLs; resolver accepts
  exact provider ids only; no generic fetch/proxy endpoint.
- **SW cache boundaries:** statics only; never HTML/API/auth/provider/
  playback.
- **Client bundle scanner:** `verify:client-bundle` fails the pipeline on
  server markers in production chunks.

## 19. Production / runtime architecture

```text
instrumentation boot validation → next start → health → smoke
```

- **Boot:** `src/instrumentation.ts `register()` (dev/start only, never
  build/tests) validates env via `parseEnv()` and crashes on invalid config
  — no partially initialized serving; no auto-migrations, provider calls,
  seeding, or telemetry at boot.
- **Migration deploy:** explicit `prisma migrate deploy` before starting the
  new artifact (migrations additive: old code runs on new schema).
- **Readiness:** `GET /api/health` (dynamic, Node runtime) → `200 {ok}` iff
  config valid **and** bounded read-only DB probe (`SELECT 1`, 3s)
  succeeds, else `503 {error|degraded}` with fixed
  `{environment, database}` shape; providers excluded; no versions, paths,
  user data, or secrets.
- **Smoke lifecycle:** `smoke:prod [--spawn --port]` refuses occupied
  ports, requires `.next/BUILD_ID`, owns server lifecycle, waits for
  readiness, runs shell/header/manifest/SW/proxy/fixture/auth checks
  (exit 0/1/2), terminates the child with no orphans.
- **Shutdown:** plain `SIGTERM`/`SIGINT`; Next.js drains; no custom
  handlers, no background work; client playback torn down by React unmount.
- **CI release checks:** `validate` (typecheck, lint, unit) → `db`
  (Postgres + `test:db` + `db:verify`) → `e2e` (build +
  `verify:client-bundle` + Playwright + `smoke:prod --spawn`).

## 20. Testability

- **Deterministic unit tests** (`vitest.config.mts`): `src/**/*.test.ts(x)`,
  DB/live suites excluded, Node env.
- **DB tests** (`vitest.db.config.mts` + `scripts/db-test-env.ts`): only
  `*.db.test.ts`, no file parallelism, Postgres service.
- **Playwright** (`playwright.config.ts`, `e2e/`): Chromium; app-shell,
  acceptance, keyboard, error-recovery, PWA, authenticated library/playlist/
  session (setup/teardown harness), E2E-only routes (`e2e-playback`,
  `e2e-library`) gated out of production.
- **Live playback gating** (`vitest.live.config.mts`): only
  `*.live.spec.ts`, 60s timeouts, self-skip without
  `AURORA_E2E_LIVE_PLAYBACK=1` — out of CI by default.
- **Test auth harness** (`e2e/auth/*`): DB-backed fixtures, prepare/clean/
  read scripts, isolated from production auth.
- **`smoke:prod`**, **client-bundle scanner**, **dependency audit
  baseline/gate**, **migration allowlist test**, **quality/security gates**
  (Phase 24/26) complete the contract. No suite output is copied here.

## 21. What is not guaranteed

- Production deployment occurred; zero-downtime deployment.
- All browsers support playback (adaptive-URL behavior varies; validation
  is best-effort prediction, not a guarantee).
- External provider uptime (readiness excludes providers by design).
- Automatic DB rollback (Prisma provides none — restore from backup).
- Full offline playback (shell-only offline by design).
- WCAG certification (concrete guarantees only, §10 of product spec).
- Unrestricted provider API availability (credentials, quotas, and catalog
  gaps apply).

---

## ARCHITECTURAL INVARIANTS

1. Single `MusicEngine` — one mounted facade; orchestration only.
2. Single `PlayerEngine`/store — one persistent audio element; sole
   queue/state container.
3. Single `QueueManager` — facade with zero state; no second queue array.
4. Single `PlaybackController` — sole playback orchestration authority; the
   only path by which a URL reaches the engine.
5. Single recovery authority — one bounded policy + one executor; same
   identity, same source order, no matcher.
6. Single Media Session adapter — sole OS-media-key surface.
7. Metadata/playback separation — Deezer/Spotify never resolve playback;
   `previewUrl`/`streamUrl` never playback input.
8. No persisted temporary playback URLs — memory-only `AudioSource`s;
   persist `TrackRef`, re-resolve on restore.
9. Exact YouTube identity — `youtube:VIDEO_ID` or fail; no matching, search,
   or substitution during resolution.
10. YouTube/Deezer/Spotify-only providers — single registry; removed
    providers stay removed; test doubles stay test-only.
11. Browser-shaped playback validation — open-ended range probe before an
    `AudioSource` exists; 200/206 only.
12. Adaptive/muxed fallback — audio-only preferred, muxed last resort,
    video never outranks audio-only.
13. Provider logic stays below `MusicEngine` — UI never imports provider
    internals (server boundary module only).
14. UI never imports provider internals — enforced by boundary tests +
    client-bundle scanner.
15. Auth/ownership enforced server-side — `requireUser` + DAL recheck;
    client flags display-only.
16. PWA is shell-only offline — statics + fallback page; never audio, API,
    auth, provider, or HTML caching.
17. Diagnostics must remain secret-safe — allowlisted fields, deny-listed
    keys, redacted URLs, no external sink.
18. Production client bundles must not contain server-only provider
    internals — `verify:client-bundle` gate.

---

## UNRESOLVED DOCUMENTATION CONFLICTS

None found beyond the stale wording resolved below. If a future conflict
requires a product decision, record it here rather than inventing an answer.

Resolved during Phase 32 (objective, code-supported):

- Home page copy "Playlist creation and editing arrive in a later phase"
  (`src/app/(app)/page.tsx`) is stale: playlist create/edit/delete now
  exists via dialogs and server actions. Product spec documents the
  implemented behavior; the copy is a UI-text fix for a later phase
  (no behavior change made here).
