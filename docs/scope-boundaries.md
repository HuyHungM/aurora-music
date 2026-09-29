# Aurora Music — Scope boundaries (Phase 31)

This document records deliberate exclusions, deferred features, and the
dependency audit baseline. It is a statement of what is **out of scope**,
not a roadmap. Nothing here authorizes implementation work.

Complements: `PRODUCT_SPEC.md` (intended current product scope),
`ARCHITECTURE.md` (technical architecture and invariants),
`docs/security.md` (operational security posture), `docs/deployment.md`
(release/deployment procedure). Phase reports are historical evidence, not
the primary ongoing specification.

## SOURCE-OF-TRUTH POLICY

- `PRODUCT_SPEC.md` defines intended current product scope.
- `ARCHITECTURE.md` defines technical architecture and invariants.
- `docs/scope-boundaries.md` (this file) records deliberate
  exclusions/deferred features.
- `docs/security.md` defines operational security posture.
- `docs/deployment.md` defines release/deployment procedure.
- Phase reports are historical evidence, not the primary ongoing
  specification.

When sources conflict, actual production code outranks all documents;
among documents, the hierarchy above applies. Conflicts that require a
product decision are recorded under `UNRESOLVED DOCUMENTATION CONFLICTS`
in `ARCHITECTURE.md` rather than silently resolved.

Documentation maintenance rule: behavior changes must update
`PRODUCT_SPEC.md` and/or `ARCHITECTURE.md` in the same change; deliberate
exclusions/deferrals must update this file; operational posture changes
must update `docs/security.md` / `docs/deployment.md`.

## Deliberate non-goals

The following are explicitly out of current product scope (verified: no
implementation exists; several additionally asserted by boundary tests):

- Spotify Web Playback SDK / Spotify audio playback
- Deezer full audio; Deezer preview-as-playback
- Arbitrary URL playback / generic URL fetch / audio proxying
- Persisted stream URLs (DB columns, storage APIs, service-worker caching)
- Offline music / downloads / audio caching (MP3, OGG, blobs, segments)
- Anonymous playback-session persistence: the persistent playback session is
  auth-required. Browser storage stays banned by the quality gates, so an
  anonymous visitor's queue and position are not restored — this is a
  deliberate exclusion, not a gap awaiting local persistence.
- Lyrics display (only the `explicit_lyrics` boolean is mapped)
- Social features (comments, feeds, activity)
- Collaborative playlists and any shared editing. Playlist sharing (Phase 47)
  is deliberately two-state — private or shared, read-only for the viewer;
  comments, per-viewer edits, and multi-owner playlists stay excluded.
- Upload-based cover management. Playlist artwork is a URL in the existing
  `Playlist.artwork` column; there is no object storage, no file-upload
  endpoint, and no image proxy.
- Payments / subscriptions
- Analytics / external telemetry
- Live radio / live streams (resolver rejects live/upcoming)
- Sleep timer / crossfade / gapless playback
- New providers beyond YouTube / Deezer / Spotify
- Queue history navigation across sessions
- Additional UI locales beyond Vietnamese / English; Accept-Language
  sniffing; `/en`|/`vi` route-prefixed locales; browser-storage
  (`localStorage` / `sessionStorage` / `indexedDB`) locale persistence

## Deliberately partial features

- **Radio:** seed-based discovery stations are now product scope (see
  PRODUCT_SPEC §13): track/artist/discovery seeds, deterministic
  rule-based batches, continuous extension near exhaustion. Still
  explicitly closed: live radio streaming, offline radio, radio-specific
  repeat semantics, and any new audio source. The previously listed
  "autoplay / related-track insertion" exclusion is narrowed further in
  Phase 47: an active, user-started radio session may append tracks, manual
  play/replace/clear always wins, and — since §39-§44 — an opt-in
  "Autoplay" preference (internally `keepListening`) may continue any queue
  the listener started. Only live radio streaming, the Spotify Web Playback
  SDK, and Deezer full-audio playback remain excluded.
- **Autoplay control surfaces:** the player bar (≥1024px) and the full player
  (below it) carry the control, and the queue panel repeats it with
  explanatory text. The mini player deliberately does not. It is a two-item
  row at 360px, and a fifth 44px control left roughly 20px for the track
  title — so the control there would be reachable and unreadable, and the
  full player is one tap away. This is a layout budget decision, not a
  missing feature: autoplay is reachable at every supported width.
- **Playlist sharing:** private or shared, read-only, one link. There is no
  unlisted or friends-only state, no password, no expiry, no view count, and
  no per-viewer personalization of a shared collection. A shared playlist
  shows the owner's current tracks; the viewer can view, play, queue, like,
  and add to their own playlist, and nothing else.
- **Playlist artwork UI:** a URL only. The owner may paste a validated
  http/https URL or pick from artwork the playlist's own tracks already
  carry. Byte-level file validation, image dimension limits, and upload
  abuse controls are excluded because there is no upload path to validate.
- **Install/update UX:** an install card exists (sidebar on desktop, top of
  content on small viewports) and is capability-gated — a real Install button
  only where the browser exposes a native prompt, Share → Add to Home Screen
  instructions on iOS, nothing at all when already installed or already
  declined. A *reload-to-update* prompt is deliberately excluded: the worker
  applies updates at `pagehide`, so no UI is needed and a deploy cannot
  interrupt playback.

## Deferred (not scheduled)

Live radio streaming and any item under non-goals above
are deferred without a scheduled phase (mood stations are not a product:
the static labels were removed in favor of real seed-based stations).
Converting a deferred item into work requires a new phase authorization —
this file never authorizes it.

### Cloudflare Workers DB TLS (historical; target superseded by Vercel)

Aurora previously deployed to Cloudflare Workers via OpenNext. The Workers
target could not trust Aiven's per-project CA in-app: on workerd `pg` resolves
to `pg-cloudflare`, whose `startTls(options)` forwards the caller's options to
`cloudflare:sockets`' `Socket.startTls`, which accepts **only**
`expectedServerHostname` and drops `pg`'s `ca`/`rejectUnauthorized`; the
database TLS upgrade therefore failed and the only external fixes were
Hyperdrive or a publicly-trusted certificate. This is retained as **history,
not as an open deferral**: the production target is now native Next.js on
Vercel (docs/deployment.md), where the inline-CA mechanism works.

`AURORA_DATABASE_CA_CERT` carries the public CA as inline PEM text, is read by
the shared TLS builder (`src/lib/db-tls.ts`), takes precedence over the file
path `AURORA_DATABASE_CA_CERT_PATH` when both are set, fails closed on a value
that is not a PEM certificate, and keeps verification ON. It is the production
mechanism for the filesystem-less Vercel Functions runtime, and it is proven to
connect to the Aiven database with verification on (system trust store fails
with `SELF_SIGNED_CERT_IN_CHAIN`; the inline CA succeeds).

Certificate and hostname verification must stay ON on every target:
`sslmode=disable`, `no-verify`, `ssl=false` and `NODE_TLS_REJECT_UNAUTHORIZED=0`
are and remain refused in production.

### Phase 48 deferral: no mobile bottom sheet for the playlist picker

The add-to-playlist picker is a viewport-anchored popover at every width,
including mobile, rather than a `position: fixed` bottom sheet. It is
deliberately **not** converted in Phase 48:

- It is the most invasive change in the layering work, and it is not a
  defect. The picker is anchored, flips within the viewport, escapes its
  scroll container via the existing `createPortal`, and now participates in
  the shared presence lifecycle like every other overlay.
- A sheet is a different interaction, not a different position: it changes
  dismissal, focus order, and the back-button story, which is a product
  decision rather than a positioning fix.
- It carries live E2E coverage (`authenticated-playlist.spec.ts` and the
  add-to-playlist menus) that asserts the popover's current placement.

Converting it is legitimate future work. It is not authorized here, and it
must not be treated as an open bug.

### LAN development over plain HTTP: what is deliberately not solved

The dev server is reachable at `http://<lan-ip>:3000` and the application is
usable there end to end (render, HMR, API, server actions, auth, search,
playback, queue, likes, playlists, sharing, radio, appearance). Two
things on that origin are left unsolved on purpose:

- **No TLS for the dev origin — and none for the deployed origin either.** A
  private IP over plain HTTP is not a secure context, so the browser withholds
  `serviceWorker`, the async clipboard API, Web Share, `crypto.subtle` and
  `crypto.randomUUID`, and reports notifications as denied. Aurora degrades
  honestly — the share control falls back to a selection copy and then to a
  selectable link field, identity ids fall back to `getRandomValues`, and the
  service worker simply does not register — but **PWA install/offline and the
  system share sheet cannot work on a plain-HTTP origin.** Registration
  therefore feature-detects instead of dereferencing, and the compiled result
  of that is gated by `verify:client-bundle` and `e2e/pwa.spec.ts` — see
  `ARCHITECTURE.md` for why a source-level guard was not enough. Adding a dev
  certificate is environment work, not a product feature, and it is not
  authorized here.
- **TLS exists at the public origin but not at the origin the process listens
  on, and the two must never be treated as the same host.** The deployed
  public origin (`https://app.auroramuzik.dpdns.org`) terminates TLS at the edge,
  so it *is* a secure context; the origin Next.js is bound to
  (`http://127.0.0.1:24584`) is not. This was previously recorded the other way
  round — the claim that the deployed URL is reached over plain HTTP was
  measured to be false, and the correction is why the public origin is now a
  declared value (`AURORA_PUBLIC_URL`, `ARCHITECTURE.md` §14) rather than
  something inferred from a `Host` header that may carry the internal port.
  Registration still feature-detects rather than assuming a secure context,
  because the dev and LAN origins genuinely are not one, and a LAN browser
  must still degrade honestly.
- **Google OAuth refuses a private-network redirect URI.** Google answers
  the LAN callback with `invalid_request: device_id and device_name are
  required for private IP`, so Google sign-in cannot complete from
  `http://<lan-ip>:3000` regardless of Aurora's configuration. This is the
  provider's policy, and the fix is an origin Google accepts (a public TLS
  host), not a relaxed `redirect_uri`, callback allowlist or cookie policy.
  GitHub OAuth accepts the same origin and remains the usable provider on
  the LAN.

## Phase 52 — production hardening: what is deliberately partial

### The rate limiter is in-process, not distributed

`src/lib/http/rate-limit.ts` holds its window counters in the Node process.
Behind a single instance this is exact. Behind N instances, each enforces the
limit independently and the effective limit is `limit x N`.

Accepted deliberately. The alternative is no limiter until a shared store
exists, and no limiter is the state that lets one tab exhaust a provider API
quota. The counters are keyed by a hash of IP and user agent, never the raw
address, and the map is bounded, so the failure mode is "the limit is looser
than documented", not "the process runs out of memory".

Revisit when a second instance is actually deployed. The trigger is
horizontal scale, not an incident.

### Playlist reorder is last-write-wins, not versioned

`reorderPlaylist` validates full membership and writes in a transaction, so it
cannot corrupt a playlist. Two concurrent reorders resolve to one of the two
orderings with no conflict signal. An optimistic `revision` column on
`Playlist` is the fix and was not added here: it is a schema migration plus a
client-side reconciliation, and a migration is the one change in this phase
that cannot be undone by deleting a file.

Note what already exists and is not a gap: `Like`, `Follow`, `PlaylistTrack`
and `PlaybackState` are unique-constrained, so double-submit and duplicate
insert are database-enforced rather than application-enforced. `RecentlyPlayed`
is not unique-constrained - it is a history log where a repeated play is a true
event, not a duplicate.

### No cross-tab queue synchronisation

Playback **ownership** is coordinated across tabs. Queue and session **content**
is not, and will not be. See ARCHITECTURE.md §26.2: queue merging needs a
canonical owner, a durable shared store, and concurrent-edit conflict resolution,
bought in exchange for behaviour a user can already get by using one tab.

### No multi-device playback handoff

Playback state is per-user, but the **audio** plays in the browser tab that
started it. There is no "continue on another device", no volume/mute sync, and
no signed-URL transfer. The persisted session carries track and position only -
never volume, never mute, never an `AudioSource`, never a signed stream URL.

This is intentional. Volume is a property of the room the listener is sitting
in, not of the track. Carrying it across devices makes the second device feel
broken. A signed stream URL in a persisted session is a bearer token at rest.

### No device fingerprinting

Multi-device detection is absent rather than implemented. Nothing derives an
identity from a device, a user agent, a screen, or a canvas. The only
client-derived value the server hashes is IP + user agent, and only to rate-limit
anonymous requests - it is not stored, not logged, and not correlatable with a
user.

## Dependency audit baseline (Phase 31)
## Dependency audit baseline (Phase 31)

- Baseline: `npm audit` recorded; known advisories triaged as accepted or
  scheduled. Gate fails closed on new high/critical advisories outside the
  baseline until re-triaged. (Phase 50: the audit command is now
  `bun audit`; the recorded baseline is unchanged.)
- Lockfile canonical (`bun.lock`, Bun 1.4.0) since Phase 50; no
  npm/pnpm/Yarn migration. `package-lock.json` is removed — see the Phase 50
  section below.
- `youtubei.js` pinned at 18.0.0; upgrades require re-running format
  validation and live playback verification. Phase 55 widens the blast radius
  of an upgrade: the library is now also the primary **discovery** source, so
  an upgrade must additionally re-run `innertube/__tests__/shapes.test.ts` and
  `innertube/__tests__/transport.test.ts`, and — because those tests were
  written from captured payloads rather than from a schema — spot-check one
  live search. A version bump that moves a field fails closed (the quality gate
  routes to the official API) rather than returning nothing, but "fails closed"
  is indistinguishable from "the primary has quietly stopped working", which is
  exactly how this phase's first implementation spent most of its time. The
  live spot-check is therefore not optional politeness; it is the only signal
  that distinguishes the two.

## Provider quota reduction (Phase 55)

Deliberately **not** done, each with the reason rather than left as a gap:

- **No quota evasion of any kind.** No key rotation, no sharding across
  projects, no proxy or IP rotation, no fabricated credentials. The reduction
  comes from architecture, caching and choosing the right data source, so the
  official budget Aurora spends is the budget it declares.
- **No second `Innertube` session.** A session carries a visitor identity and
  the player scripts derived from it. Two sessions would mean two identities
  and no shared in-flight state, so the count is asserted by test rather than
  left to review.
- **No `@distube/ytsr` or `ytpl`.** `youtubei.js` is already installed and
  already the playback adapter; a second InnerTube library would be a second
  parser and a second failure surface. `@distube/ytdl-core` stays forbidden —
  it is archived, and the DisTube ecosystem itself has moved to youtubei.js.
- **No `related`-via-InnerTube.** The YouTube provider does not advertise
  `tracks.recommendations`, so wiring it up would be a new feature rather than
  an optimisation. `getRelated` also exists only on the `Music` client, not
  WEB.
- **No live search-as-you-type.** Aurora's search is submit-driven, so there
  is no keystroke-to-request path to debounce; adding a debounce would guard a
  bug that cannot happen and would delay a search the user explicitly asked
  for. The property is asserted by test (`search-field.test.tsx`) so that
  anyone who adds live search has to confront the per-keystroke cost. The
  equivalent protection that does exist is server-side coalescing plus a TTL
  cache.
- **No quota dashboard endpoint.** `/api/health` is deliberately minimal and
  provider-free because it is safe to expose to a load balancer, and there is
  no authenticated diagnostics surface to hang one on. Exposing provider
  counters publicly would need its own auth and review. The counters are
  available as a library snapshot (`snapshotYouTubeMetrics()`) and emitted as
  structured log events, which is the shape a future dashboard would read.
- **The provider is still gated on `YOUTUBE_API_KEY`.** InnerTube needs no key,
  so a keyless YouTube provider is technically possible, but it is deferred for
  two reasons: it would change which providers exist in every deployment that
  has no key today (including the whole test suite, which asserts "no key" means
  "no YouTube"), and a keyless provider has no official fallback at all, so its
  degradation path is worse than no provider. Both belong to a phase that
  designs the keyless story rather than one that moves the request path.
- **No fabricated channel attribution on channel-tab rows.** A `LockupView` from
  `channel.getVideos()` carries no channel id, and the rows on a channel's own
  videos tab are in practice all that channel — so stamping the requested
  `channelId` onto each row would fill the field and cost nothing. It is not
  done, because the day YouTube shows a compilation or a featured video on that
  tab the field becomes a confident lie, and a wrong artist is harder to notice
  than a missing one. `snippet.channelId` is therefore omitted for that
  surface; `getVideos` hydration and the provider's own request context supply
  it where it is known to be true.
- **No patch or fork of `youtubei.js`.** `Feed.page_contents` throws on any feed
  without a `Tab` node (`this.#memo.getType(Tab)?.[0].content` — the `?.`
  guards the index and then dereferences anyway), so a search response cannot be
  asked for it at all. The fix here is to read each candidate location inside its
  own `try`, which is correct against the shipped library and against a fixed
  one. Vendoring a patched copy, or pinning a fork, would trade a two-line
  defensive read for a permanent maintenance liability and an upgrade that has to
  carry a patch forever.
- **Known pre-existing defect, found by this phase and not fixed by it:**
  `src/lib/radio/session.ts` — `extend()` returns without clearing `generating`
  when the session deactivates while an extension is in flight, after which
  `maybeExtend()`'s guard blocks every later attempt. The symptom is a queue
  stuck on "Finding more tracks…" and is the cause of the intermittent
  `authenticated-radio.spec.ts` "Journey 17" failure; it reproduces identically
  with the tiered transport removed, so it is not a Phase 55 regression. It sits
  in earlier-phase uncommitted work and was left untouched rather than silently
  absorbed into a discovery phase.

## Stale scaffold cleanup (Phase 31)

- Stock `create-next-app` scaffold wording removed where it contradicted
  implemented behavior; remaining generic README text carries no product
  meaning (see `ARCHITECTURE.md` unresolved-conflicts log for the one known
  stale UI copy item).

## Repository cleanup and catalog trust boundary (Phase 49)

- **Removed:** the five stock `create-next-app` SVGs (`next`, `vercel`,
  `window`, `file`, `globe`) from `public/`. They were unreferenced by every
  source, config and stylesheet, and the public-asset quality gate itself
  described them as "unused by the app, kept as shipped". The gate's allowlist
  was narrowed at the same time, so it now forbids any unreviewed asset
  instead of grandfathering dead ones. Also removed the dead
  `src/components/tracks/track-art.tsx` back-compat wrapper (zero importers
  anywhere; its replacement `ui/artwork.tsx` has 12 live consumers) and two
  orphaned generated files (`tsconfig.tsbuildinfo`, `dev.db` — a stale SQLite
  file from before the PostgreSQL migration).
- **Known limitation, deliberately not "fixed":** a track/artist/album row is
  a shared, unowned cache written from client payloads, so an authenticated
  user can still set the *display* fields (title, artwork, duration, genres)
  on a row that other users and anonymous shared-playlist visitors read back.
  Phase 49 closed the security-relevant half of this — `streamUrl`,
  `previewUrl` and `metadata` can no longer be written from a client, and are
  excluded from the `upsertTrack` parameter type and the `addTrackSchema`
  input. Closing the display half requires re-resolving catalog fields from
  the provider on every write, which is an architectural change to a hot path
  with no defect report behind it. It is recorded here as a known boundary,
  not an open bug, and must not be presented as either a solved or an
  outstanding defect.
  - **Bounded on 2026-09-27, the boundary itself unchanged.** The remaining
    half is *who may write what size*, not *whether a client may write display
    fields*: `trackInputSchema` now bounds every client-writable field (text
    500, URLs 2048, 20 genres, finite non-negative duration) and both
    catalog-writing actions parse through it — the like path previously applied
    no validation at all. A caller can still choose the *content* of a display
    field for a track id it has legitimately discovered; it can no longer write
    an unbounded string into a table every user renders. Attribution of a
    display field to the provider is still out of scope, for the hot-path
    reason above.
- **Dead code found, not deleted, pending evidence:** `PlayerEngine.cleanup()`
  (`lib/player/engine.ts`) is implemented and only ever called from tests, so
  a torn-down `PlayerHost` leaves the audio element playing. It is reachable
  only in dev StrictMode/HMR, never by user action, because every route lives
  under `(app)/` and a hard navigation destroys the JS context. Left in place
  rather than deleted: it is the correct teardown and the call site is the
  thing that is missing, not the method.
- **No dependency, route, script or migration was removed.** Every direct
  package is used by source or config (26 today: 11 dependencies + 15
  devDependencies); every route file under `src/app` is intentional (12
  pages + 3 API routes); all 17 package scripts execute and pass;
  migration history is untouched.

## Bun migration and toolchain boundary (Phase 50)

- **Bun 1.4.0 is the canonical package manager and script runtime.**
  `bun.lock` is the only lockfile and `packageManager` pins `bun@1.4.0`.
  `package-lock.json` was removed only after a from-scratch `bun install`
  resolved 593 packages and the typecheck, build, unit, database and E2E
  suites all passed under Bun.
- **No product behavior, architecture, provider or migration changed.** This
  phase moved the toolchain; `MusicEngine`, `QueueManager`,
  `PlaybackController`, `PlayerEngine`, `PlaybackResolver`, `TrackMatcher`,
  the DAL and the provider contracts are untouched. The only source change
  was to `isPortFree` in `scripts/smoke-prod.mjs` (below), which is
  release tooling, not application code.
- **One genuine runtime incompatibility, fixed:** `isPortFree` detected a
  refused connection only via Node's `error.cause.code === "ECONNREFUSED"`.
  Bun reports the same definitive refusal as `error.code ===
  "ConnectionRefused"` with no `cause`, so the port guard treated a free
  port as ambiguous, failed closed, and `--spawn` refused to start. Both
  shapes are now recognised; the fail-closed default for genuinely uncertain
  errors (timeout, abort, TLS) is unchanged, so the guard still cannot be
  talked into testing a foreign server.
- **`tsx` is retained deliberately.** `db:verify` and `verify:share-route`
  could both run natively under Bun, but `e2e/auth/run.ts` resolves
  `node_modules/tsx/dist/cli.mjs` by absolute path to run the authenticated
  E2E scripts, so removing `tsx` would break the E2E auth harness. It is not
  a dead dependency.
- **`unrs-resolver`'s blocked postinstall is benign.** Bun blocks untrusted
  lifecycle scripts; the single blocked package is a transitive ESLint
  resolver, and `bun run lint` passes with the same result as under Node. No
  `trustedDependencies` entry was added.
- **Ordering caveat documented, not worked around:** `bun run typecheck`
  depends on `.next/types`, which only `next build`/`next dev` generates. The
  documented release order in `docs/deployment.md` now builds first so a clean
  clone validates without manual steps.
- **Node.js 22+ remains a runtime, not a package manager.** Toolchain
  internals (Prisma's engine spawn, Next's helpers) shell out to Node. CI
  provisions both Node 22 and pinned Bun 1.4.0 and installs only with
  `bun install --frozen-lockfile`; npm's cache setting was removed.

## Phase 51 — installable web app: what is deliberately absent

Phase 51 made Aurora installable from modern browsers. It changed no product
behavior and added no dependency. The following were considered and are
**excluded on purpose**, not overlooked:

- **No offline music.** There is no audio download, no stream-URL persistence,
  and no cache entry for provider media. Playback URLs are single-use signed
  provider streams; caching them would both break on expiry and violate the
  googlevideo passthrough rule. `offlineAudio` is therefore permanently
  `false` in every capability surface, and the manifest advertises only an
  offline *shell*.
- **No push notifications.** No push service, no VAPID keys, no subscription
  storage. `pushNotifications` is `false` everywhere. Adding it is a separate
  product decision (it implies a server-side delivery pipeline and a user
  prompt for a feature Aurora does not have).
- **No `window-controls-overlay`.** The mode is Chromium-desktop-only, and
  enabling it would place the application header under the OS title bar with no
  layout work to keep that area usable. It is excluded rather than shipped
  broken, and the capability field exists so a future phase can enable it
  honestly.
- **No native wrapper and no platform-specific logic.** No Capacitor, Tauri,
  Electron, Android/iOS SDK, or custom URL scheme. The `Platform` union and
  `/api/app-config` exist so a future wrapper can identify itself without this
  codebase changing shape, but `platform` is always `web` today.
- **No `share_target` manifest member.** Aurora has no flow for receiving
  content shared *into* it. Adding the member would advertise an intake path
  that does not exist; sharing is outbound only (public token URLs, plus
  `navigator.share` where the browser offers it, with a clipboard fallback).
- **No iOS 180x180 apple-touch-icon asset.** iOS scales the declared icon
  itself; the existing 192x192 launcher PNG is the correct source and a second
  rendered file would be a duplicate asset, not a new capability.
- **No per-locale manifest.** The manifest is a cached, request-independent
  document, so it advertises the shipped default (Vietnamian) rather than the
  current session. Per-locale copy still reaches the user through the
  server-rendered page and the install card. A locale-varying manifest was
  rejected because it would make the application's identity depend on a
  request, which is exactly what a stable `id` exists to prevent.
- **No settings shortcut or settings route.** *(Superseded by Phase 53: there
  now is a `/settings` page, reachable from the sidebar footer and the mobile
  header. It is deliberately still not a manifest shortcut — see the Phase 53
  section below for why the shortcut was left off.)*
- **No "reload to update" prompt.** The worker hands over at `pagehide`, so
  updates land between documents. A prompt would add a UI affordance whose only
  purpose is to interrupt a listening session.
- **Verification limits, stated honestly:** the installable surface was
  verified in headless Chromium and through the production build, unit tests
  and E2E. Real-device install flows on iOS Safari and Android Chrome, and
  `window-controls-overlay` behaviour on desktop, were **not** exercised — no
  such device or OS was available in this environment. Those paths are covered
  by capability gating and standards-compliant metadata, not by observation.

## Phase 53 — Aurora Glass: what is deliberately absent

Phase 53 added an optional glass presentation mode, background images, and
artwork-reactive ambience. Four of its boundaries are worth recording here
because they were **premises of the work, not choices made during it** — the
mission text assumed things the repository does not have, and the honest
outcome is a documented deviation rather than a quietly narrowed scope.

- **§4 asked for an "uploaded image" and there is no upload path.** §4 of the
  phase brief describes Preview / Select / Remove / Reset for a background, and
  "uploaded image" appears in the pipeline description. Aurora has no upload
  anywhere, and `docs/scope-boundaries.md` already excludes upload-based cover
  management: artwork is a URL, and it is a URL everywhere. Building a binary
  upload path would also have meant multi-megabyte blobs in a relational
  database, which §4 separately forbids. **Deviation:** the custom background is
  a validated https image **address**, plus five hand-authored SVG presets. The
  four actions exist unchanged — typing previews, applying validates, Remove
  clears one, Reset clears both. The fork was raised before implementation and
  the URL answer was chosen, so this is a recorded interpretation rather than a
  silent substitution.
- **There is no light theme, so "every supported theme" has nothing to iterate.**
  Aurora is dark-only: one `@theme` block, one set of primitives, no `data-theme`
  attribute anywhere. Any statement of the form "applies to every supported
  theme" is therefore vacuously true here, and no light-mode rendering was
  designed, tested or claimed. Glass is a second *surface treatment* on the one
  theme, not a second theme.
- **Artwork pixel analysis is unavailable for the shipped artwork source.**
  `Artwork` renders cross-origin CDN images with `unoptimized`, so a canvas
  readback is normally tainted and the mean colour cannot be computed. The
  resolver therefore returns the **identity palette** and the ambient layer
  simply does not tint. This is a real product outcome, not a degraded mode
  hidden behind a flag: a visitor whose artwork is same-origin, or served with
  permissive CORS, gets the wash, and one whose CDN does not does not. It is
  opt-in (off by default) precisely because it cannot be promised universally.
- **No hardware-based quality downgrade.** The brief allows a reduced-cost mode
  "via browser capability plus explicit preference", and the second half is what
  shipped. Capability detection is limited to `@supports` for `backdrop-filter`,
  which is a standards feature query, not a measurement. Inspecting the GPU,
  core count or memory to pick a rendering tier is device fingerprinting, and
  the Phase 52 section above excludes that. The Minimal preset exists so the
  cheap mode is one click away without the product profiling anyone.

Also deliberately not built, and not deferred by omission:

- **No `backdrop-filter` nesting, anywhere.** Not a capability limit — a
  performance and correctness decision, enforced by test.
- **No appearance preference in the playback session snapshot**, so a restored
  session on another device does not inherit a glass setting from the device
  that saved it.
- **No appearance in the deep-link allowlist beyond the `/settings` route
  itself**, and no new top-level navigation item.
- **No manifest shortcut for `/settings`**, even though the route now exists. A
  settings shortcut is a launcher entry that opens a form; it is a reasonable
  addition and it is not this phase's, and adding one would mean the Phase 51
  shortcut assertions change in a phase about glass.
- **Verification limits, stated honestly.** The glass surfaces, the background
  layers and the responsive behaviour were verified through the production
  build, the unit suite, and the token and quality gates. Real-device rendering
  of `backdrop-filter` — real GPU compositing, real colour blending, real
  performance under scrolling — was **not** exercised: no browser with a
  compositor was driven in this environment, and the reported figures come from
  the build and the gate scripts, not from a rendered frame. Any statement about
  how Aurora Glass *looks* is a claim about the cascade, not a screenshot.

## Shuffle control audit — what was found and deliberately left

The shuffle icon/state/interaction audit fixed the control's own contract
(ARCHITECTURE.md §20.1, PRODUCT_SPEC.md §5.1) and added a real unavailable
state. Two adjacent defects were found in the same audit and are **reported,
not fixed**, because the fix belongs to a shared primitive and the whole
transport row — wider than a shuffle bugfix, and the audit's own rule is not to
patch individual instances when the primitive is responsible.

- **The player bar's transport buttons declare two different box sizes.**
  Button with size="icon" already emits h-11 w-11, and all 16 size="icon"
  call sites in the repo *also* pass an explicit h-* w-*. Where the two agree
  (the full player, the mini player) the duplication is harmless. Where they
  disagree — the bar's four transport buttons, at player-bar.tsx lines 97, 108,
  125 and 135 — the button carries both h-10 w-10 and h-11 w-11, and the box
  that actually renders is decided by stylesheet order rather than by the
  author's intent. The bar's real hit target is therefore not knowable from the
  source. Shuffle keeps the bar's existing h-10 w-10 so it matches its
  neighbours; raising it to the 44px floor on its own would resize one control
  inside a row of 40px controls, and lowering the row to 40px is a layout
  decision, not a bugfix. The repair is one compact entry in Button's size map
  plus a change at those four call sites.
- **AutoplayButton carries the same latent colour conflict shuffle had.** It
  puts 	ext-accent on a Button variant="ghost", so the accent loses to the
  primitive's 	ext-text-secondary exactly as described in ARCHITECTURE.md
  §20.1. Its *ring* is real and its on-state is visible, so this is cosmetic
  rather than a state that fails to report. It is left alone here because fixing
  it changes another feature's appearance; the measurement is recorded so the
  next audit of that control has it.
## Phase 54 — mobile, tablet and foldable: what is deliberately absent

The phone work reused the one engine, the one store, the one resolver and the
one DAL. There is no mobile backend, no second player, and no mobile-only data
path; a phone is a viewport and a pointer type, not a platform fork. What is
absent, and why:

- **Two empty states deliberately have no action, and both are on the search
  page.** Of the nineteen `EmptyState` call sites, seventeen now lead with a
  control. The two that do not are `search.emptyTitle` — "no query typed yet",
  where the next action is the search field the user is already looking at and
  a button next to it would be a second, worse way to do the same thing — and
  `search.unavailableTitle`, the provider-failure state. The second is the one
  a reviewer should push back on, and the reason it is not fixed here is
  specific: `search/page.tsx` is a server component, so a retry control could
  only be a link back to the same URL, which is not a retry — it is a reload
  wearing a retry's name, and a control that re-requests a URL that just failed
  is worse than honest prose. Making it a real retry means a client boundary
  around the results region, which is an architectural change and is not
  authorized by this phase. Until then the state says what happened, in both
  shipped locales, and offers nothing that pretends otherwise.
- **No drag-to-reorder anywhere, including the queue.** A drag needs a visible
  handle to be discoverable and to avoid fighting list scrolling, and at 360px
  the queue row has no width for one: after artwork, play and overflow, a 44px
  handle leaves 68px for the track title, which is not a usable title. Below
  `sm` the move actions are in the row's overflow menu instead, which costs
  zero additional width, is keyboard- and screen-reader-navigable, and is the
  platform convention for secondary row actions. This is a real interaction
  that is not offered on pointer devices either, where a visible pair of arrow
  buttons is better. Adding drag means a handle that costs width the phone does
  not have, or a long-press gesture with no affordance — neither is an
  improvement, and both were rejected on measurement.
- **No tablet-specific layout.** The shell has one breakpoint story (`sm`,
  `md`, `lg`) plus a short-viewport variant. A tablet is a wide phone or a
  narrow desktop depending on which way it is held, and it is served correctly
  by both ends of that story. A third layout for a device that is one of the
  other two would be a maintenance cost with no user-visible gain.
- **No foldable-specific layout.** A foldable open is a wide, short or tall
  viewport; it is a viewport, and `min-aspect-ratio` plus the existing
  breakpoints already respond to it. There is no hinge-aware layout, because
  there is no reliable cross-browser API for one and a guess that reserves
  space for a seam that may not exist is worse than not guessing.
- **The 44px floor is not a blanket rule.** It is opt-in per call site, gated
  on `(hover: none) and (pointer: coarse)`. A pointer device is deliberately
  denser, and a global `min-height: 44px` would inflate dense toolbars on
  desktops that the floor exists to protect nobody from. Each opt-in names
  what yields the pixels.
- **No `overflow-x: hidden` as an overflow fix.** Zero horizontal overflow is
  guaranteed by fixing the layout, not by clipping it. Clipping hides the
  symptom and leaves the content unreachable, and it is the reason the phone
  suite asserts the overflow at 1px steps through the band where the header
  actually breaks instead of at three round widths.

## YouTube audio-only selection: why the muxed fallback is in use

Measured 2026-09-26 against live YouTube. YouTube's adaptive (DASH) audio URLs
answer a whole-body request — `Range: bytes=0-`, no `Range`, or `HEAD` — with
HTTP 403 and a `text/plain` empty body, while a bounded range returns 206 with
the correct `audio/*` type from the very same URL. A browser media element
always issues the whole-body form first, so Chromium reports
`ERR_BLOCKED_BY_ORB` and then `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) on those
URLs. Across 14 sampled videos, 13 had this property on their whole adaptive
audio ladder; the progressive (muxed, itag 18) format of the same video was
unaffected in every case, and the browser plays the muxed URL correctly
(load, play, pause, resume and seek all verified).

The consequence is that audio-only selection is currently unreachable for real
content and the documented muxed fallback is the steady state. Playback is
correct; the cost is bandwidth, because a progressive stream carries video
alongside the audio — roughly 2x the Opus bitrate, 27 MB for an 850 s video and
231 MB for a 150 minute one.

Deliberately not done:

- **No server-side re-chunking or transcoding proxy.** Re-chunking the
  progressive stream, or proxying the bounded-range audio and re-serving it
  with a whole-body-friendly response, is the only way to serve audio-only
  bytes. It means a persistent, bandwidth-bearing media proxy in front of a
  provider CDN: a new tier, a new failure mode, and a new reason for the server
  to hold media bytes. `ARCHITECTURE.md` §7 and the "Results are never cached"
  rule in `innertube-client.ts` both assume the server hands out a signed URL and
  gets out of the way. Not authorized here.
- **No `pot` / proof-of-origin token work.** The `IOS` player context hands out
  direct, unciphered adaptive URLs that still 403 on a whole-body read, so the
  refusal is not a signature, cipher or token problem. Chasing it would be
  changing provider behaviour on a guess.
- **No accepting a candidate the browser will reject.** Promoting an adaptive
  audio URL because a *bounded* read succeeded would make resolution succeed
  and playback fail, reinstating the code-4 regression the probe exists to
  prevent. The bounded read sets `boundedRangeOk` for diagnosis only.
- **No preference change.** `rankAudioFormats` is unchanged and still puts
  audio-only first; the validator is the only thing that rejects, and it
  rejects with evidence.

## Search by link — what is deliberately out of scope

The link-search work added classification to the existing search field. It
did not add a second search system, and the following are exclusions rather
than omissions:

- **Artist and channel URLs are refused, not resolved.** Spotify
  `/artist/<id>`, Deezer `/artist/<id>` and YouTube `/channel/<id>` /
  `@handle` links are on allowlisted hosts and are correctly recognised as
  links, but they classify as `unsupported-url` with readable copy. The
  parser deliberately does not gain an `artist`/`channel` kind: an artist
  link wants a *page* (top tracks, follow, radio) rather than a resolvable
  music resource, the identity and playability rules for an artist differ
  from a track's, and the alternative — rendering an artist link as a track
  card — would be a wrong answer that looks right. Deferred to a phase that
  designs artist surfaces.
- **No URL proxy, no arbitrary fetch, no Open Graph scraping.** The server
  never retrieves the URL the user pasted. Every outbound request is a
  structured provider API call built from an id that the allowlist,
  resource-type and id-shape checks already accepted; a page the link points
  at is never read for its title or artwork. This is the existing
  "arbitrary URL playback / generic URL fetch / audio proxying" non-goal
  applied to a new entry point.
- **No Spotify audio of any kind, and no playback token of any kind.**
  Spotify links resolve metadata → canonical identity → the existing
  matcher → a YouTube equivalent → the one playback resolver. There is no
  Web Playback SDK, no streaming link stored or echoed back, and no signed
  URL persisted; a Spotify card whose equivalent was not found renders
  catalog-only rather than degrading to an approximation.
- **No live detect-as-you-type resolution.** Detection is pure client-side
  string work against the value already in state — no request, no debounce,
  no spinner. Submitting is what resolves, so there is no keystroke-to-
  provider path and no pasted-link preview.
- **No automatic queue mutation on paste.** Resolving a link renders a
  result. Queueing, playing, liking and adding to a playlist stay explicit
  user actions, exactly as they are for a text search.
- **No new provider selector, no second search input, no "search URL"
  button.** One field, one submit path, one history.