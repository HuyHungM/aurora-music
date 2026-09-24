# Aurora Music — Product Specification

Canonical product source of truth. Describes the product **as implemented**,
not an imagined future product.

Source-of-truth hierarchy: actual production code > Prisma schema / executable
contracts > automated tests and gates > this document > `docs/security.md` >
`docs/deployment.md` > `docs/scope-boundaries.md` > historical phase reports.

> Scope note: `docs/scope-boundaries.md` records deliberate exclusions and
> deferred features. Phase reports (`PHASE_*.md`, `MUSIC_PROVIDER_PLAN.md`)
> are historical evidence, not the ongoing specification.

---

## 1. Product identity

**Aurora Music** is a multi-provider music discovery web application with
YouTube-backed browser playback and authenticated personal-library features.

- **Category:** music discovery + playback web app (Next.js App Router).
- **Core purpose:** discover open music across catalog providers, play it in
  the browser, and keep a personal library (likes, follows, playlists,
  history, playback position).
- **Interaction model:** server-rendered browsing surfaces (home, search,
  album/artist/track detail) + a persistent client player shell
  (desktop player bar, mobile mini/full player) driven by one `MusicEngine`
  facade.
- **Supported music sources:** YouTube, Deezer, Spotify (see §4).
- **Playback philosophy:** exact-source resolution to an ephemeral,
  browser-validated audio URL at play time. No persisted stream URLs, no
  proxying, no downloads, no offline music.

## 2. Core product capabilities

| Capability | Status |
|---|---|
| Home / discovery sections (popular, featured, recommendations, albums, artists) | Implemented |
| Unified multi-provider track search + capability-gated artist/album search | Implemented |
| Album browsing (detail + track list + play) | Implemented |
| Artist browsing (detail + track list + play + follow) | Implemented |
| Track details (player + like + recommendations) | Implemented |
| Playback (play / pause / seek / volume / mute) | Implemented |
| Queue (replace, next, previous, play next, clear, move, remove, shuffle, repeat) | Implemented |
| Library (likes, recently played, playlists overview) | Implemented, auth-required |
| Likes (like / unlike / liked state) | Implemented, auth-required |
| Follows (follow / unfollow / following state) | Implemented, auth-required |
| Playlists (create, rename, describe, artwork URL, delete, add, remove, reorder) | Implemented, owner-only |
| Recently played recording + display | Implemented, auth-required |
| Search history recording + display + clear | Implemented, auth-required |
| Playback-state persistence (track + position + revision, cross-session resume) | Implemented, auth-required |
| Media Session (OS controls, metadata, position state) | Implemented |
| PWA shell (installable manifest, shell-only offline fallback, offline indicator) | Implemented |
| Radio | **Deliberately partial** — static catalog preview only (see §13) |
| Mood stations | **Not implemented** — static labels marked "coming in a later phase" |
| Playlist artwork | **Partial** — URL field only; no upload-based cover management |

## 3. Authentication model

Three capability tiers:

- **`anonymous`** — browse home, search, album/artist/track detail,
  recommendations, resolve + play YouTube-backed audio. Like/follow state
  reads return `false`; library writes no-op or redirect to sign-in CTA.
- **`authenticated`** — everything anonymous can do, plus: like/unlike,
  follow/unfollow, create and own playlists, record recently played and
  search history, persist playback state.
- **`owner`** — the authenticated user who created a playlist. Only the
  owner can view the detail page (`notFound()` otherwise), rename, edit,
  delete, or mutate its tracks. Enforced server-side (`requirePlaylistOwner`
  → `AuthorizationError` / `ResourceNotFoundError`); the UI `isOwner` flag
  is display-only.

Mechanics:

- Auth.js (NextAuth v5 beta) with **JWT sessions**, Prisma adapter,
  `trustHost: true`, `AUTH_SECRET` required in production.
- **Google / GitHub OAuth**, each registered only when its ID + secret pair
  is configured. With neither configured the app boots provider-less and
  auth-dependent features stay unavailable — boot never breaks.
- No custom cookie or session code; secure `HttpOnly` / `SameSite=Lax`
  cookies via Auth.js defaults (`__Secure-` prefix in production).
- Sign-out redirects to the fixed `/` target (no open redirects).
- Mutations require a session user; the DAL rechecks resource ownership.

## 4. Provider model

Exactly three production providers: **YouTube, Deezer, Spotify**.
(`MUSIC_PROVIDER_PLAN.md` freezes this list and forbids recreating removed
providers — Mock, Jamendo, ZingMP3, mp3-api, Audius — as production
providers. Test doubles stay test-only.)

| | YouTube | Deezer | Spotify |
|---|---|---|---|
| Metadata / search / catalog | Yes, gated by server-side `YOUTUBE_API_KEY` | Yes, always registered (keyless catalog endpoints) | Yes, gated by `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` pair |
| Detail (track / album / artist) | Yes | Yes | Yes |
| Playback | **Yes — the only playback provider** (Innertube, server-only) | No — metadata/catalog only | No — metadata/catalog only |
| Credentials | Server-only API key; absent = unregistered | None | Server-only Client Credentials; absent = unregistered |

Explicit rules:

- **YouTube = actual playback provider. Deezer/Spotify = metadata/catalog
  providers only** in the current implementation.
- **Spotify Web Playback SDK is not used.** No Spotify audio playback of
  any kind (asserted by boundary tests).
- **Deezer preview is not a playback fallback.** `previewUrl` (30s preview)
  is descriptive metadata; the playback path never reads it — not even as a
  fallback. Legacy `Track.streamUrl` / `Track.previewUrl` fields are frozen
  and never used as playback input.
- Provider registration is idempotent and credential-rotation aware; the
  single canonical registry (`Map<ProviderId, MusicProvider>`) is the only
  registration/lookup path. Canonical search order: YouTube, Deezer,
  Spotify.
- Capability gating: artist/album search, detail, and recommendations degrade
  per-provider (`success` / `unsupported` / `failed`). Unsupported renders
  nothing or `notFound()`; failed renders an inline warning — never a crash.

## 5. Playback model

- **Exact YouTube source identity.** Resolution handles only
  `youtube:VIDEO_ID` with strict ID validation. Matching is never performed
  during exact YouTube resolution; a mismatched provider response is a
  failure, not a fallback. There is no generic URL fetch endpoint and no
  proxy. Live/upcoming/private videos are rejected.
- **Source resolution:** `TrackIdentity` → `PlaybackResolver` (first
  resolvable source in identity order; Deezer/Spotify sources skipped as
  metadata-only) → YouTube resolver → `AudioSource`.
- **Format selection:** Innertube format discovery, audio-only preferred
  (MIME `audio/mp4` > `audio/webm` > other, higher bitrate wins,
  URL-lexicographic tie-break), **muxed audio+video as acceptable last
  resort**. Video-carrying formats never outrank audio-only.
- **Browser-shaped validation (critical rule):** a resolved YouTube URL is
  **not** automatically considered browser-playable. Some adaptive URLs
  return 403 for the browser's initial open-ended range request
  (`Range: bytes=0-`) even when bounded ranges return 206, surfacing as
  `MEDIA_ERR_SRC_NOT_SUPPORTED`. Every candidate is therefore probed with a
  browser-shaped open-ended range request (status only, body cancelled,
  5s timeout); only 200/206 becomes an `AudioSource`. Rejected adaptive
  candidates fall through to the documented muxed fallback.
- **Ephemeral `AudioSource`.** Memory-only (`url`, `mimeType`,
  `durationMs`, `expiresAt`, `bitrate`). Expiry is checked before load;
  expired sources are never handed out — re-resolution is the recovery path,
  never reuse. Simultaneous resolutions of one video share a single
  in-flight request; results are never cached.
- **Bounded recovery:** one recovery cycle per generation, same stable
  identity (no matcher, no new sources), up to `MAX_RECOVERY_ATTEMPTS = 2`
  with bounded backoff (200ms, 800ms), reload at saved position (latest user
  seek wins). Permanent failures end the cycle immediately; exhaustion
  reports the terminal error with suppression so the same dead source cannot
  restart spontaneously.
- **Stale generation protection:** every logical load claims a monotonic
  generation; results apply only when still current. Pause/next/stop win by
  flag or superseding generation — stale results are inert, never cancelled.
- **User-action precedence:** any new load, stop, or shutdown supersedes
  pending work; pause wins on transport intent (pending loads complete
  paused, never autoplay). Persistence restore never overrides live user
  intent.

## 6. Queue model

- **Physical queue + logical play order.** The store holds `queue: Track[]`
  and `playOrder: number[]` (indices into `queue`); `position` is the cursor
  within `playOrder`. Shuffle reorders `playOrder`, never `queue`.
  `QueueManager` owns no second array — it is a facade delegating every
  mutation to the store (one mutation path, no shadow queue).
- **Operations:** replace queue, play collection, play track, play at
  position, next, previous, play next (insert after current), add to queue,
  clear, move item (up/down), remove item, toggle shuffle, cycle repeat.
- **Repeat:** `off` → `all` → `one` → `off`. Repeat one replays the current
  track; repeat all wraps at the ends; repeat off stops at queue exhaustion
  (no auto-advance past the last item, no looping).
- **Previous:** moves within `playOrder` history cursor semantics of the
  store; there is no separate cross-session history stack.
- **Explicitly out of scope:** queue history navigation across sessions is
  not part of current product scope; autoplay / related-track insertion is
  not part of current product scope.

## 7. Library model

Authenticated users own:

- **Likes** — like/unlike per track, liked list (library shows up to 50).
- **Follows** — follow/unfollow per artist, following state on artist pages.
- **Recently played** — recorded on qualified plays (duration-gated,
  server action), library shows up to 20.
- **Search history** — recorded per query, shown (up to 8) on the empty
  search page, clearable.
- **Playlists** — see §8.
- **Playback-state persistence** — provider + providerTrackId + position +
  revision per user (one row, `userId @unique`); CAS-guarded saves
  (newer-save-wins), restore on boot for the current user only, cleanup on
  sign-out. Playback URLs are never persisted — only the track ref.

Ownership: every library row is keyed to its user; the DAL rechecks
ownership on read and write. There is no saved-albums collection; albums
appear only as catalog detail and inside home sections.

## 8. Playlist model

- **Create** (title, optional description, optional artwork URL), **rename**,
  **description edit**, **artwork URL edit**, **delete**.
- **Add** track (upserted into catalog first), **remove**, **reorder**
  (two-phase position shift preserving the `@@unique([playlistId,
  position])` constraint), **duplicate handling** (`@@unique([playlistId,
  trackId])` — re-adding is a no-op/conflict, never a duplicate row).
- **Ownership:** create binds `userId`; all mutations require the owner.
  Detail pages `notFound()` for non-owners.
- **Persistence:** Prisma `Playlist` + `PlaylistTrack(position, addedAt)`,
  ordered reads by `position asc`.
- **Position integrity:** dense ordering maintained by the DAL reorder path;
  concurrent position writes are constrained by the unique index, not by
  client logic.
- **Verified non-goals:** collaborative playlists, privacy/sharing controls,
  upload-based cover management (URL field only), social features.

## 9. PWA / offline model

Available offline:

- Application shell (cached same-origin `/_next/static/*` assets)
- Built-in offline fallback page for failed navigations
- Offline indicator (`role=status`, event-driven, never touches playback)

Not available offline:

- Music playback (requires internet — stated verbatim on the fallback page)
- Live search
- Database-backed library
- Provider requests (`/api/*`, server actions, POST, cross-origin, and all
  `googlevideo.com` playback traffic are network passthrough, never
  intercepted, never cached; no HTML is ever cached so no personalized page
  can leak across users)

Service-worker boundaries: single versioned static cache
(`aurora-sw-v1:static`); activation deletes older `aurora-` caches only;
nothing precached at install; registration is failure-tolerant and decoupled
from player lifecycle.

## 10. Accessibility contract

Concrete guarantees (no WCAG certification claimed):

- Semantic controls throughout (real buttons, labeled menus per track).
- Keyboard navigation: seek ±5s (arrows), Home/End, dialog Tab-cycle with
  focus trap, Escape closes dialogs and the full player with focus return.
- Dialog focus: focus moves into dialogs on open, restores on close.
- ARIA names/states: `aria-label` on icon-only controls, `aria-pressed` on
  toggles, `role=group/region/status/alert` where appropriate.
- Error announcements via `role=alert` error fallback (Try again / Back
  home affordances; retries never reset playback).
- Offline status announced via `role=status aria-live=polite`.
- Touch targets: 44px minimum (`h-11 w-11` icon buttons).
- `prefers-reduced-motion` disables non-essential motion (tested).

## 11. Responsive model

- **Desktop shell:** fixed sidebar (`lg:flex w-60`), main content area,
  desktop player bar (`hidden lg:flex`, bottom, offset for sidebar).
- **Mobile navigation:** bottom nav bar (`lg:hidden`), safe-area padding.
- **Mobile mini player** (`lg:hidden`, above bottom nav, shown only when a
  track is loaded) expands to the **mobile full player** (modal dialog with
  focus management, `lg:hidden`).
- Dialogs, menus, and cards adapt grid columns by breakpoint
  (2 → 3 → 4 → 5); detail headers stack vertically on small screens.

## 12. Error model

User-visible semantics (implementation taxonomy stays in
`src/lib/errors/*` and `src/lib/errors/user-error.ts`):

- **Safe user errors:** curated messages only; never URLs, tokens, stacks,
  versions, or paths. `preservePlayback: true` on every user-facing error —
  UI retries never reset playback.
- **Retryable failures:** network/timeout/provider-transient errors map to
  retry affordances ("Couldn't reach the service…", Try again).
- **Playback failures:** `PlayerError(unavailable | playback | autoplay)` →
  controller classifies → bounded recovery or terminal track error; the
  queue stays valid and an unplayable track never poisons siblings.
- **Auth failures:** 401/403 and ownership violations → "Please sign in to
  continue." (no internals).
- **Validation failures:** malformed input → "That request doesn't look
  right." (no schema dump).
- **Provider failures:** per-section `unsupported` (silent) vs `failed`
  (inline warning); track/album/artist misses → `notFound()` UI.
- **Database failures:** readiness degrades (`/api/health` 503), UI shows
  retryable unavailability — never raw DB errors.
- **Offline behavior:** offline-mapped errors ("Music playback requires an
  internet connection"), shell stays usable, indicator announces status.

## 13. Deliberately partial features

- **Radio:** static catalog preview. Mood stations are hard-coded labels
  marked "coming in a later phase"; the page states live audio streaming
  "arrives in a later phase" and the list is "a static preview of the
  catalog, not a live stream."
- **Playlist artwork UI:** URL field only; no upload, picker, or generated
  covers.
- **Install/update UX:** manifest + service-worker registration exist; no
  update-prompt or install-prompt UI.

## 14. Non-goals

Verified against current repository evidence (no implementation exists for
any of the following; several are additionally asserted by boundary tests):

```text
NON-GOALS
```

- Spotify Web Playback SDK / Spotify audio playback
- Deezer full audio (preview-as-playback)
- Arbitrary URL playback / generic URL fetch / audio proxy
- Persisted stream URLs (DB columns, storage APIs, SW caching)
- Offline music / downloads
- Lyrics display (only the `explicit_lyrics` boolean is mapped)
- Social features (comments, feeds, activity)
- Collaborative playlists / privacy / sharing
- Upload-based cover management
- Payments / subscriptions
- Analytics / external telemetry
- Live radio / live streams (rejected by the resolver)
- Equalizer / sleep timer / crossfade / gapless playback
- New providers beyond YouTube / Deezer / Spotify

## 15. Testability contract (product view)

- Deterministic unit tests (default `vitest` suite; DB and live suites
  excluded by config).
- DB tests (`vitest.db.config.mts`, Postgres service, `db:verify` counts).
- Playwright E2E (Chromium; authenticated harness with setup/teardown
  fixtures; E2E-only routes gated out of production).
- Live playback/search/media E2E gated behind `AURORA_E2E_LIVE_PLAYBACK=1`
  and excluded from CI by default.
- `smoke:prod` post-deploy checks; `verify:client-bundle` post-build gate;
  architecture/security/dependency gates in CI.
