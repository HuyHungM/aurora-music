# Aurora Music — Product Specification

Canonical product source of truth. Describes the product **as implemented**,
not an imagined future product.

Source-of-truth hierarchy: actual production code > Prisma schema / executable
contracts > automated tests and gates > this document > `docs/security.md` >
`docs/deployment.md` > `docs/scope-boundaries.md` > historical phase reports.

> Scope note: `docs/scope-boundaries.md` records deliberate exclusions and
> deferred features. Phase reports are historical evidence, not the ongoing
> specification. Where an earlier phase report once held a rule, the rule now
> lives in this document or `ARCHITECTURE.md`, and the report is not a
> citation target.

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
| Home / discovery sections (recommendations always; popular / featured / albums / artists when the active provider advertises those capabilities) | Implemented, capability-gated |
| Unified multi-provider track search + capability-gated artist/album search | Implemented |
| Same search field accepts a Spotify / YouTube / Deezer link (classified before any provider call) | Implemented |
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
| Persistent playback session (full queue + cursor + play order + shuffle/repeat + current track + position + volume/mute, automatic restore) | Implemented, auth-required |
| Media Session (OS controls, metadata, position state) | Implemented |
| PWA shell (installable manifest, shell-only offline fallback, offline indicator) | Implemented |
| Radio (seed-based track / artist / discovery stations, bounded batches, continuous extension) | Implemented (see §13) |
| Multilingual UI (Vietnamese default, English option, persisted preference) | Implemented (see §16) |
| Mood stations | **Not implemented** — no mood-station product (the static labels were removed) |
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
- **Sign-in always targets the origin the browser is on.** The authorization
  `redirect_uri` and every link `/api/auth/*` renders are built from the
  request the browser made, so opening the dev server from another device
  (`http://<lan-ip>:3000`) starts OAuth against that same origin instead of
  `localhost` — which would try to return the token to the phone itself.
- **A deployment with a public hostname declares it** as
  `AURORA_PUBLIC_URL` (`https://auroramuzik.dpdns.org`), and that declaration —
  not the `Host` header — decides the `redirect_uri`. Two things make this
  necessary rather than cosmetic. The internal origin the process listens on
  (`http://127.0.0.1:24584`) must never reach Google: with the port attached,
  the callback is rejected as `redirect_uri_mismatch` and nobody can sign in.
  And the port a server was *booted* with is not the port the *public* origin
  has, which is why the declaration exists rather than a port-stripping rule.
  A tunnel's `Host` header cannot be the authority here, because a tunnel
  configured to append the internal port to the public hostname is precisely
  the failure being fixed. Unset, the request headers decide — correct for
  localhost and LAN, which have no public origin to declare.
- Mutations require a session user; the DAL rechecks resource ownership.

## 4. Provider model

Exactly three production providers: **YouTube, Deezer, Spotify**.
This list is frozen: removed providers — Mock, Jamendo, ZingMP3, mp3-api,
Audius — must not be recreated as production providers, and no fourth
production provider may be added without a new phase authorization. Test
doubles stay test-only. Enforced by
`src/lib/providers/__tests__/provider-boundary.test.ts` and ARCHITECTURE.md
invariant 10.

| | YouTube | Deezer | Spotify |
|---|---|---|---|
| Metadata / search / catalog | Yes, gated by server-side `YOUTUBE_API_KEY` | Yes, always registered (keyless catalog endpoints) | Yes, gated by `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` pair |
| Search / track-metadata source | **InnerTube-first**, official Data API as fallback (Phase 55) | Official API | Official API |
| Detail (track / album / artist) | Yes | Yes | Yes |
| Playback | **Yes — the only playback provider** (Innertube, server-only) | No — metadata/catalog only | No — metadata/catalog only |
| Credentials | Server-only API key; absent = unregistered | None | Server-only Client Credentials; absent = unregistered |

Explicit rules:

- **YouTube = actual playback provider. Deezer/Spotify = metadata/catalog
  providers only** in the current implementation.
- **YouTube search and track metadata resolve from InnerTube, not the official
  API** (Phase 55). The official `search.list` costs 100 units against a
  separate 100/day default, so it is used only when InnerTube is unavailable
  or returns something unparseable, and it remains the only source for channel
  metadata and playlists. See `ARCHITECTURE.md` §8a and
  `docs/youtube-request-map.md`.
- **The user-visible behaviour does not change with the source.** The same
  Track comes back either way, and when the official budget is exhausted the
  product still works — it is the official API that is scarce, not YouTube.
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
  **not** automatically considered browser-playable. YouTube's adaptive (DASH)
  audio URLs return 403 for the browser's initial whole-body request
  (`Range: bytes=0-`, no `Range`, or `HEAD`) even when a bounded range returns
  206 from the same URL, surfacing as `MEDIA_ERR_SRC_NOT_SUPPORTED`. Every
  candidate is therefore probed with a browser-shaped open-ended range request
  (status only, body cancelled, 5s timeout); 200 or 206 becomes an
  `AudioSource`. Rejected adaptive candidates fall through to the documented
  muxed fallback. This is the common case, not a rare one: measured 2026-09-26
  over 14 videos, 13 refused whole-body reads and resolved via the muxed
  format, so muxed is currently the steady-state selection for real content
  and audio-only selection is unreachable (see `ARCHITECTURE.md` §7).
- **Diagnosable rejections:** a rejected candidate logs `itag`, a stable
  `reason` (`probe_status_403` / `_404` / `_416` / `_other`, `probe_timeout`,
  `probe_network_error`, `missing_url`), the observed `status`, the
  parameter-stripped `contentType`, and `boundedRangeOk` — which separates "the
  CDN refuses whole-body reads of this adaptive URL" (expected) from "this URL
  is dead". A total failure emits one `playback_resolution_failed` summary
  with candidate/valid/rejected counts, the top reasons, and `aliveButRefused`.
  No signed playback URL is ever logged, and none is ever persisted.
- **Refused-but-alive is recoverable, dead is not.** When every candidate was
  refused *and* each proved alive on the bounded confirmation read, the media
  exists and the CDN is declining the read at that moment, so the failure is
  transient and the bounded recovery below re-resolves it. Any dead candidate
  (404), an unconfirmed 403, a timeout, or a network error ends the cycle
  immediately: re-resolving the same identity cannot change the answer.
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

## 5.1 Shuffle (control)

- **One control, three surfaces.** The player bar, the mini player and the full
  player each expose shuffle, in that order in the row (shuffle, then repeat) on
  every surface. The mini player previously offered Repeat, Autoplay access and
  a queue control but no shuffle at all, so on a narrow viewport there was no
  way to see or change the one transport mode that changes what plays next.
- **It renders the engine's own state.** There is no local flag anywhere in the
  UI. Turning shuffle on reorders the play order; the current track stays
  playing. Turning it off restores the queue's own order. The physical queue is
  never touched.
- **Three states, all real.**
  - *Off* — not pressed, muted glyph, tooltip "Shuffle: Off".
  - *On* — pressed, accent glyph, and a ring as well as the accent, so the state
    survives greyscale, high contrast and a future light theme. Tooltip
    "Shuffle: On".
  - *Unavailable* — the queue is empty. There is no order to randomise, so the
    control is genuinely disabled rather than inert: it does not accept a
    pointer press, does not paint a hover state, and its tooltip explains the
    condition instead of reporting a state that cannot change. It re-enables by
    itself as soon as anything is queued. It is **not** disabled merely because
    the current state is unknown.
- **The accessible name states the action** ("Turn shuffle on" / "Turn shuffle
  off") **and the tooltip states the state** ("Shuffle: On" / "Shuffle: Off"). A
  bare "Shuffle" tells a screen-reader user the control exists and nothing about
  what it does now. `aria-pressed` is present in every state, including while
  disabled, because a toggle that cannot currently be toggled is still a toggle.
- **The glyph means shuffle and nothing else.** Two crossing lines, each ending
  in an arrowhead. It is never confused with Repeat (a loop), Repeat-one (a loop
  plus a numeral), Autoplay (a one-way flow), Queue (a stack) or Radio (a dial).
- **The hit target is the button, not the glyph**, matching the project's 44px
  accessibility floor in every surface, and the target does not change size
  between states.
- **Motion is a fade, not a movement.** The active ring fades in and out; it
  never animates layout, never shifts neighbouring controls, and is never
  constant. Press feedback respects reduced motion.

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
  not part of current product scope. Related-track insertion exists only
  as user-initiated Radio: an active radio session appends bounded
  discovery batches near queue exhaustion (§13); any manual play,
  replace, or clear ends the session and is never overridden.

## 7. Library model

Authenticated users own:

- **Likes** — like/unlike per track, liked list (library shows up to 50).
- **Follows** — follow/unfollow per artist, following state on artist pages.
- **Recently played** — recorded on qualified plays (duration-gated,
  server action), library shows up to 20.
- **Search history** — recorded per query, shown (up to 8) on the empty
  search page, clearable.
- **Search is URL-driven and navigates as an SPA** — the submitted query
  lives at `/search?q=…` and that URL alone reconstructs the page: a
  reload, a deep link, and Back/Forward all restore the same query and
  the same results, with no client bootstrap and no reliance on
  `localStorage`/`sessionStorage`. Typing is transient input state only.
  Submitting trims surrounding whitespace, preserves internal spacing,
  and percent-encodes the query; re-submitting the query already shown
  does not re-navigate. Searching never interrupts playback, replaces the
  queue, or drops an active radio session.
- **The same field accepts a provider link.** It classifies what is in it
  — ordinary text, a link Aurora can read, or a link it cannot — before
  anything is requested, and says so with a one-line hint under the field
  ("Spotify link detected" / "YouTube link detected"). A link Aurora can
  read resolves through the provider and renders one result — a track card,
  or an album/playlist page of bounded numbered rows — instead of a search
  result list: the id in the URL is used directly (a YouTube video is never
  re-searched), Spotify and Deezer supply metadata only, and any
  cross-source equivalent is found by the existing matcher. Collections are
  cross-source matched and deduplicated on canonical identity before they
  can reach the queue, a playlist or Recently Played, and pasting a link
  changes nothing on its own — playback, queueing and saving remain the
  user's explicit actions. A link Aurora cannot read is refused with copy
  and is never passed to the provider as text, while ordinary prose —
  punctuation, `?` and `—` included — keeps searching exactly as before.
  Resolution renders inline in the same page: no full-page spinner, no
  stack trace, no provider message. Refused links are not recorded in
  search history. See `ARCHITECTURE.md` §9a.
- **Playlists** — see §8.
- **Persistent playback session** — one row per user (`userId @unique`)
  holding `provider` + `providerTrackId` + `position` + `revision`, plus a
  versioned session snapshot (ordered entries, logical play order, cursor,
  media position, shuffle, repeat, volume, mute, write timestamp; capped at
  200 entries). Saving: queue mutations, track changes, and volume/mute
  changes coalesce through a trailing debounce; periodic checkpoints run
  while playing; `visibilitychange` (hidden) and `pagehide` are a final
  best-effort flush, never the primary mechanism. Clearing the queue
  deletes the row so a cleared session can never return, and replacing the
  queue overwrites it, so the previous session never comes back. Restore is
  automatic on boot for the current user only, ordered load → validate →
  migrate → queue → current entry → shuffle/repeat → position → volume/mute,
  and it never autoplays: the user presses Play and Aurora resolves a
  **fresh** source through PlaybackResolver. Cleanup happens on sign-out.
  Anonymous users get no persistence (browser storage is banned by the
  quality gates).
  Playback URLs are never persisted — only stable track refs and display
  metadata; every restored entry is re-resolved on play, because a
  persisted stream URL would have expired. Explicit seeks feed the debounced
  session snapshot via same-track position discontinuity detection.
  Volume and mute are session state, not device preferences: they ride in
  the same versioned snapshot and are restored with the queue, so a resumed
  session sounds as it was left. Restore is verified positionally — the
  session returns to the same queue *occurrence* at the persisted position
  (accepted within 3 seconds, not millisecond-exact, and clamped to the
  real duration once the fresh source reports metadata). Older snapshot
  versions are migrated forward on read and on write rather than
  discarded, so an account written by an earlier build keeps its queue.
  The session row is per user, not per tab, so with several tabs open only
  the live listening session writes it: a tab that has yielded to another
  tab which is actually playing stops persisting, and resumes as soon as
  that tab stops or goes away. With one tab open — and in any browser
  without cross-tab support — nothing changes. See ARCHITECTURE §26.4.

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
  Detail pages `notFound()` for non-owners. Authorization is server-side in
  the DAL, never a client-side or UI-only check.
- **Persistence:** Prisma `Playlist` + `PlaylistTrack(position, addedAt)`,
  ordered reads by `position asc`.
- **Position integrity:** dense ordering maintained by the DAL reorder path;
  concurrent position writes are constrained by the unique index, not by
  client logic.

### 8.1 Custom artwork

- Artwork is the pre-existing `Playlist.artwork` column — a URL, never a
  second field and never an upload. There is no object storage, no
  file-upload endpoint, and no image proxy in the product.
- Owner path: open the playlist → Edit → Change artwork → paste a URL or pick
  from artwork the playlist's own tracks already carry → Preview → Save.
  Removing it writes an explicit `null`, and every surface falls back to the
  default playlist artwork.
- Validation happens on the server and again in the client for feedback:
  `http`/`https` only, host required, ≤2048 characters. `javascript:`,
  `data:`, `blob:`, `file:` and protocol-relative values are rejected. The
  client-supplied content type is never trusted, because no bytes are ever
  accepted.
- The same value renders identically in the library card, the playlist page,
  the add-to-playlist picker, and the shared-playlist preview.
- Changing artwork never changes the playlist's tracks.

### 8.2 Sharing (read-only public link)

- Two states only: **private** (owner only) and **shared**. There is no
  unlisted, friends-only, passworded, expiring, or collaborative state.
- The owner enables sharing from the playlist's `Share` control
  (`[Play] [Share] [More]` → Share Playlist). The server mints an opaque
  token and returns a link; the owner can copy it or revoke it.
- The owner-facing dialog presents that choice as a two-state selector rather
  than a single action button whose label flips: the owner picks **private** or
  **shared**, the current state is stated in words alongside it, and the
  consequence of turning sharing off — the current public link stops working
  immediately — is stated before the choice, not after it. The link is offered
  as a copy field, plus the platform share sheet where `navigator.share` is
  available, and copy confirmation expires on its own so it never goes on
  claiming a copy that has since been undone.
- Copying degrades instead of failing: `navigator.clipboard` where it exists,
  a selection-based `execCommand("copy")` fallback where it does not (a
  plain-HTTP origin has no async clipboard API), and a selectable read-only
  link field plus an honest message when neither works. The share link itself
  is always `window.location.origin`-relative, so a page opened from another
  device on the LAN copies an address that device can reach.
- The public URL is `/playlist/share/<token>` and carries **only** the token:
  no playlist id, no owner id, no provider id, no Prisma identifier. The
  token is 24 random bytes (192 bits) rendered base64url, so it is not
  guessable and not enumerable.
- Access requires a matching token **and** `visibility = "shared"`. A private
  playlist is therefore unreachable by guessing a database id, and revoking
  nulls the token so an old link stops working immediately. A miss, a
  malformed token, a revoked link and a deleted playlist are
  indistinguishable to a prober: one 404, one metadata shape, no redirect to
  sign-in.
- The public read model (`SharedPlaylist`) has no `ownerId` and no
  `shareToken` field at all, so no public code path can hand the owner out or
  re-share the link by scraping the page. Attribution is a display name.
- **Shared viewer may:** view, play, queue, like, and add tracks to their own
  playlist. **May not:** rename, delete, change artwork, change sharing, or
  mutate the owner's tracks. Those paths are owner-gated server-side, so the
  prohibition holds for an anonymous visitor and for a signed-in non-owner
  alike.
- A shared playlist is a live, static collection: the viewer sees the
  owner's current tracks and order, and is never served a personalized or
  re-ranked version of it.
- Viewing is unauthenticated. The page uses the existing design system and
  exposes only safe metadata (title, description, artwork, owner display
  name, track display metadata).

**Verified non-goals:** collaborative playlists, per-viewer edits, social
features, upload-based cover management (URL field only), link expiry, view
counts, and password protection. See `docs/scope-boundaries.md`.

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

The offline fallback page is shown in the language the visitor chose, and
defaults to Vietnamese when no choice is known. It is built by the service
worker, which is handed the language by the page rather than reading it itself:
on Chromium a navigation request reaches a service worker with no `cookie` and
no `accept-language` header — measured, not assumed — so the worker cannot
discover the visitor's language on its own, and an earlier version that tried
silently showed Vietnamese to every offline visitor regardless of their
language. The page announces its resolved locale on load and again on every
change, and the worker keeps it in a small dedicated cache
(`aurora-sw-v2:meta`) that holds a two-letter locale and nothing else.

Service-worker boundaries: single versioned static cache
(`aurora-sw-v2:static`); activation deletes older `aurora-` caches only;
nothing precached at install; registration is production-only (development
sessions never register, so Turbopack dev chunks are never served from PWAcache), **secure-context-only** (an origin that does not expose a
`serviceWorker` API — every plain-HTTP host, the deployed production URL
among them — skips registration instead of failing), failure-tolerant, and
decoupled from player lifecycle. A new worker
waits rather than taking over: the page releases it at `pagehide`, so a deploy
never interrupts a listening session and the new build is picked up on the next
launch. The offline page is rendered in the visitor's own language.

## 9b. Installable web app

Aurora is a web application that can also be installed from the browser
(Android/Chromium, iOS/iPadOS Safari, Windows/macOS/Linux desktop browsers).
Installing changes only how the window is presented — never what the
application is. The site stays fully functional when not installed, and there
is no separate installed build, no duplicated product logic, and no second
manifest.

- **Identity:** "Aurora Music", launcher name "Aurora". Stated once and reused
  by the manifest, page titles, Open Graph, the install affordance and the
  icons. Browser tab titles carry the app name on every route.
- **Manifest** (`src/app/manifest.ts`, served at `/manifest.webmanifest`):
  stable id, `start_url`/`scope` `/`, standalone display degrading to
  `minimal-ui` then `browser`, no orientation lock, dark canvas for browser
  chrome and the splash screen, launcher icons including a distinct maskable
  icon, and shortcuts for Search, Library and Radio — real routes only.
- **Install offer:** a small dismissible card in the sidebar (desktop) and at
  the top of the content area (small viewports). It appears only when the
  browser can actually install, is never a full-width banner, and never shows
  a control that would do nothing. On iOS, where no browser install prompt
  exists, it gives Share → Add to Home Screen instructions instead. Declining
  is remembered, so it does not return on every route.
- **Display modes:** standalone, minimal-ui, fullscreen and browser are all
  detected centrally, so the shell adapts to installed mode without any
  component sniffing `window` itself.
- **Safe areas:** the viewport extends under the notch and home indicator, and
  the header, content column, navigation, mini player, full player and queue
  panel all respect the correct insets in both orientations.
- **Not offered:** no install-only experience, no native wrapper, no offline
  music, no push notifications, and no `window-controls-overlay` title bar
  until the header is laid out for one.

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
- **Overlays are removed from the accessibility tree as they close.** A
  dialog, popover, menu or sheet that is animating out is `inert` and
  `pointer-events: none` for the whole of its exit, so it cannot be reached
  by Tab, announced, or used to swallow a click meant for what is behind it.
  Focus is restored to the trigger exactly once the element has left the
  document, never while it is still mounted and never onto a node that has
  already been removed.
- `prefers-reduced-motion` disables non-essential motion (tested).
  Decorative motion — press compression, hover lift, the now-playing
  equalizer — is declared only under a `prefers-reduced-motion:
  no-preference` query, so it is never applied when reduced motion is
  requested. A blanket `reduce` rule covers any transition declared
  elsewhere, including by dependencies; it shortens motion only and never
  alters `opacity`, `visibility`, `display`, or `transform`, so focus
  rings, selection, and every control's visual state survive intact.
  Enforced by `src/app/__tests__/design-tokens.test.ts`.

## 10.1 Layer and motion model

- **One named layer stack, no exceptions.** Every surface that can overlap
  another is placed on a named layer (`rail`, `player`, `dropdown`,
  `popover`, `sheet`, `dialog`, `toast`) whose relative order is part of the
  design system. Components never write a layer number themselves, so two
  surfaces cannot silently collide by DOM order or by an invented `z-9999`.
- **The stack is total and one-directional.** Content sits below the player;
  the player sits below the bottom navigation on mobile; a toast is above
  every dialog. A full-viewport takeover (the full player) is below a panel
  that must be reachable *from* it (the queue) — otherwise the "Up next"
  control inside the full player opens a panel it immediately hides behind
  itself.
- **Every overlay has a motion vocabulary.** Tooltips, popovers, menus,
  dialogs, bottom sheets and toasts enter and leave on distinct, named
  curves; exit is faster than entry, and only `opacity` and `transform`
  animate. Nothing loops, and no overlay is driven by a JS animation loop,
  a repeated layout read, or a per-frame scroll/resize listener.
- **Closing is animated, not instantaneous.** An overlay stays in the
  document for its exit and is then removed. A rapid open → close → open
  never flickers, never leaves an element stuck half-open, and never
  unmounts before its exit has played.
- **A menu always opens whole, and never outlives its anchor.** Opening a
  track's actions from any row shows every action: the menu is inside the
  viewport, no container between it and the page cuts any part of it, and
  nothing paints over it. That holds at the bottom of a list, at the right
  edge of the screen, inside a scroll container, and at every supported
  width. Direction is measured rather than assumed — a menu opens on whichever
  side actually has the room for it, keeping clear of the player chrome. It
  dismisses on outside click, on Escape, on selecting an action, and — for a
  menu that has to be drawn outside the scroll container holding its row, so
  that the container cannot clip it — on scrolling that row away, because a
  menu anchored to a row it can no longer see is a menu about the wrong row.
  Enforced by `src/components/ui/__tests__/menu-clipping.test.ts`,
  `e2e/menu-clipping.spec.ts`, and §21.4 of `ARCHITECTURE.md`.

## 10.2 Text selection (Phase 51 addendum)

**Everything the user came to read can be selected and copied. Everything the
user aims at with a pointer does not fight the pointer.**

Selectable, always: track titles, artist and album names, playlist names and
descriptions, error messages, share URLs, ids, and anything else whose text is
the product. A user must be able to select a track title to search for it, or an
error message to send it in a bug report.

Not selectable, by design: transport buttons, the seek bar and volume sliders,
drag handles, navigation links, queue remove/move/menu controls, and icon
glyphs. A pointer drag that starts on a control should move the control, not
paint a selection across the page.

Text entry fields - search, the playlist name field, the share link - are always
selectable, even where the control sitting next to them is not.

There is no global rule. A blanket `user-select: none` would make every title
and every error message uncopyable, and the damage would be invisible in a
screenshot.

## 11. Responsive model

- **Desktop shell:** fixed sidebar (`lg:flex w-66`), main content area,
  desktop player bar (`hidden lg:flex`, bottom, offset for sidebar).
- **The sidebar rail carries the four primary destinations, and — when signed
  in — the listener's own playlists.** The playlist group is real data read
  from the owner-scoped playlist table, never a curated or suggested list; it
  is omitted entirely (not shown empty) when the listener has none or is
  signed out. Each entry is a `Link` to `/library/playlists/<id>`, so a
  playlist is deep-linkable and survives a new tab, a copy and the back
  button. The rail never names a destination the app cannot open.
- **Mobile navigation:** bottom nav bar (`lg:hidden`), safe-area padding.
- **Mobile mini player** (`lg:hidden`, above bottom nav, shown only when a
  track is loaded) expands to the **mobile full player** (modal dialog with
  focus management, `lg:hidden`).
- **Bottom stack on mobile is content → mini player → bottom navigation.**
  The navigation owns the viewport bottom; the mini player sits on top of it
  by exactly the navigation's own height plus the safe-area inset. Only the
  bottom-most element consumes `env(safe-area-inset-bottom)` — an inset
  applied twice double-counts it and opens a gap.
- **Page content is never trapped behind the player.** Main content carries
  bottom padding sized so the last element on a page can be scrolled clear of
  the player chrome at every supported width.
- Dialogs, menus, and cards adapt grid columns by breakpoint
  (2 → 3 → 4 → 5); detail headers stack vertically on small screens.
- **The header wordmark collapses to the logomark below 393px.** The header is
  one row of fixed-width items — brand, search, language, settings, and the
  account group when signed in — and below `md` the search *field* is hidden in
  favour of its icon, so the row's slack is a function of the viewport alone.
  Measured signed in, the row needs 393px of content (44px logomark + 47px
  wordmark + four 44px controls + the 98px account group + gaps + 32px page
  padding), so the wordmark is the 47px that makes the difference between
  fitting and scrolling sideways. It is gone, not truncated, and the link keeps
  its full accessible name. At 393px and above there is room and it stays.
  The threshold is derived from that measurement rather than picked as a round
  number, and the brand wrapper is elastic rather than fixed-width, so the
  row's slack is spent on the wordmark first and on the controls never.
- **The full player in landscape is a two-column composition, not a squeezed
  portrait one.** At `(max-height: 560px) and (min-aspect-ratio: 1)` —
  landscape phones, and any short wide window — the artwork moves into its own
  grid column beside the title, seek, transport and volume rows, and the
  artwork is bounded on *both* axes by `min(18rem, 52svh)`. A percentage cap
  cannot bound an item against an indefinite grid row, so the bound has to be
  a length: without it the artwork sat at its intrinsic 280px, the grid
  overflowed the panel, and the volume slider, queue, like and actions
  controls fell off a 375px-tall screen inside a container that did not
  scroll, leaving them unreachable rather than merely cramped.
- **Touch targets have a 44px floor on touch-primary devices.** Under
  `(hover: none) and (pointer: coarse)` every interactive control clears 44px in
  both axes. The floor is opt-in per call site rather than a blanket rule,
  because a pointer device is deliberately denser (`h-8`/`h-10` chips) and does
  not need 44px to be accurate; each opt-in is a decision about what yields the
  4–10px, and the honest candidate is text, which is already `truncate`.
  A mouse browser is not held to the floor, and asserting it there would fail
  by design.
- **The queue is a modal sheet below `lg` and a side panel at `lg` and above.**
  The modal half carries `aria-modal="true"`, a focus trap, a scroll lock, and
  a backdrop; the `lg` panel deliberately carries none of those, because a
  panel beside the content is not a layer over it. The backdrop is `lg:hidden`
  for the same reason.
- **Reordering the queue works on a phone, through the row's overflow menu.**
  Below `sm` the row's move-up/move-down buttons are not rendered — at 360px
  the sheet is 328px, and after artwork, play and overflow there are 124px
  left; two more 44px buttons would leave 24px and a 44px drag handle would
  leave 68px, which is not a usable track title. The move actions therefore
  live in the row menu, which is already on screen at zero additional width
  cost, is a real menu (arrow keys, Escape, focus return) rather than a
  gesture, and is the platform convention for secondary row actions. Above
  `sm` the visible pair remains, because on a pointer device a visible control
  beats a menu. The currently playing row carries no menu at all.
- **Empty states lead with the next action.** Every empty state offers a
  control that does something — a search, a radio station, a discovery link —
  using copy that already exists in both shipped locales. A dead end rendered
  as prose is a defect, not a state.
- **Horizontal overflow is zero at every supported width, without
  `overflow-x: hidden` on a container.** Hiding overflow hides the symptom and
  keeps the content unreachable, so the layout is fixed rather than clipped,
  and the zero-overflow guarantee is asserted at 1px steps through the band
  where the authenticated header row actually breaks (375–420px), not only at
  round widths.

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
- **Localization:** every curated message above is localized (Vietnamese
  default, English option — see §16). Error codes, categories, and the
  `preservePlayback` flag are never localized.

## 13. Radio (seed-based discovery stations)

- **Aurora Radio is algorithmic discovery, not live radio.** A station
  starts from a track, artist, or open discovery seed; a deterministic,
  rule-based service generates bounded batches (seed + 5, then 5 more as
  the queue runs low) from existing catalog data (same-artist/album
  relations, cross-provider matching, popular catalog, library signals
  for signed-in listeners). No ML, no embeddings, no external
  recommendation APIs.
- **One unified queue.** Radio hands normalized tracks to QueueManager
  (the single queue authority) and extends it near exhaustion; manual
  play/replace/clear always wins, and clearing never refills. Radio
  tracks are ordinary queue entries (reorderable, removable, likeable,
  playlistable) and persist/restore as such; the session itself is
  memory-only and never resumes generation after reload.
- **Playback stays YouTube-backed.** Radio never resolves or persists
  playback URLs; Spotify/Deezer contribute catalog discovery only.
- **Partial features remaining here:** none — the former static
  catalog preview and hard-coded mood labels were removed.
- **Install/update UX:** a dismissible install card in the sidebar (desktop)
  and at the top of the content area (small viewports), shown only when the
  browser can install and replaced by Share → Add to Home Screen instructions
  on iOS. Service-worker updates are applied between documents at `pagehide`,
  so there is deliberately no "reload to update" prompt: a deploy must not
  interrupt playback.

## 13.1 Recommendations (deterministic, in-process)

- **Aurora's recommendations are computed here, not learned elsewhere.** No
  ML, no vector database, no embeddings, no LLM, and no external
  recommendation API. Ranking is a documented rule set over signals Aurora
  already holds, so the same inputs always produce the same ordered list.
- **The pipeline is a real pipeline, not a component:** Signals → candidate
  generation → normalization → canonical track matching → dedupe → filtering
  → ranking → result. It lives in `src/lib/recommendations/` and returns
  plain Aurora `Track`s, so no surface can render a provider-branded product
  or a provider-specific playback affordance.
- **Signals:** the current track and its artists, recently played, liked
  songs, followed artists, the current queue and its recent predecessors,
  playlist context, and the active radio/discovery context. Current-queue
  context is mandatory — a recommendation set is never computed without it.
  Personalization signals are read from Aurora's own database on the server;
  the client sends only the shape of the request. No listening history is
  ever forwarded anywhere.
- **Guarantees:** the same canonical track appears once; artist diversity is
  enforced; the current track, the current queue, and recently played or
  recently recommended tracks are excluded; and when filters would leave
  nothing, they are relaxed in a defined order rather than returning an
  empty shelf. A provider failure degrades to the remaining avenues and,
  failing that, to non-personalized discovery for an anonymous listener.
- **Surfaces (four, each with a distinct purpose — not everywhere):** Home,
  a track's detail page, an artist page, and an album page. Radio (§13) stays
  separate and authoritative. A surface with nothing to show renders nothing
  rather than filler.
- **No invented scores.** The UI never displays a percentage, a match
  quality, or any other number that would imply a model.

## 13.2 Infinite listening ("Autoplay")

- **Opt-in and off by default.** One control, one implementation, offered on
  every surface that owns a queue: the player bar and the full player beside
  the queue button, and the queue panel, which additionally explains the
  feature in words. It is a plain button with `aria-pressed` — deliberately
  matching the shuffle and repeat buttons it sits beside, so one transport row
  speaks one language — and it is not offered to an anonymous listener, who has
  no account to store the preference on. The preference is per-account server
  state — never browser storage.
- **Its icon means "the current queue, continued automatically."** Two queue
  lines, the lower running off the end into a one-way chevron: open rather than
  closed (so it never reads as repeat), uncrossed (never shuffle), without a
  returning hook (never the queue itself) and without notes (never a list). It
  never shares an icon with Shuffle, Repeat, Repeat-one, Queue or Radio, and it
  is not a radio-style glyph. The active state is an accent ring as well as an
  accent colour, so the state survives greyscale, high contrast and a future
  light theme.
- **Naming.** The user-facing term is "Autoplay" / "Tự động phát". The internal
  name stays `keepListening` (column, action, coordinator), which describes the
  mechanism rather than the setting. The accessible name states the action
  ("Turn autoplay on" / "Turn autoplay off"); the tooltip states the state
  ("Autoplay: On" / "Autoplay: Off"). A bare "Autoplay" label is not used: it
  would tell a screen-reader user the control exists and nothing about what it
  does now.
- **The control renders the coordinator's own state.** There is no local mirror
  of the setting anywhere in the UI. Turning it on is optimistic, but the
  optimism lives in the coordinator — the same object the control renders from —
  and a failed write is rolled back there, so the control cannot drift from the
  behaviour.
- **It is not live radio.** It continues a queue the listener already
  started, using the deterministic recommendation layer in §13.1.
- **It triggers near the end, not only at it:** when the remaining queue
  drops to a small threshold (currently 2), a bounded batch (6 tracks) is
  generated and appended, so a transition is never delayed waiting on the
  network. Candidates are generated and normalized ahead of time; a playback
  source is resolved only when a track is actually about to play.
- **Manual control always wins.** Play, Play Playlist, Play Album, Play
  Track, Next, Previous, Stop, Clear Queue and Replace Queue all override.
  Clearing the queue does not silently repopulate it; replacing it resets the
  context. With the toggle off, the queue ends normally at its end.
- **Bounded by construction:** one request in flight at a time, a cooldown
  between attempts, a per-session cap on generated tracks, a cap on
  remembered recommendation keys, and a barren-attempt limit after which the
  coordinator stops asking. A provider that keeps failing ends the queue
  safely instead of retrying forever.
- **The coordinator decides when and how much; `QueueManager` remains the
  only writer.** Playback stays with `PlaybackController`, and a
  recommendation failure never duplicates playback recovery.
- **Nothing about the algorithm is persisted.** The persistent session still
  saves the real queue, current track, position, shuffle and repeat.

## 13.3 Multi-tab behaviour (Phase 52)

**One tab plays. Every other tab knows.**

Playback ownership is coordinated across tabs of the same browser. Queue and
session content are not synchronized, and are not intended to be.

What a user sees:

- Starting playback in a tab claims ownership for that tab.
- A tab that is currently playing, and hears a newer claim from another tab,
  pauses itself. It is not stopped by the other tab - it stops itself, and it
  says why rather than going quietly mute.
- A pill appears in the non-playing tabs reading "Đang phát ở tab khác" /
  "Playing in another tab", with a "Phát ở đây" / "Play here" action that takes
  playback back immediately.
- Closing or pausing a tab hands playback back at once; it does not wait for a
  timeout.
- If a tab crashes, another tab takes over within a few seconds.

What is deliberately **not** there: a shared queue, a merged history, or a
"transfer your queue to this tab" control. Two tabs are two listening sessions.

`BroadcastChannel` is the transport. Where it is unavailable the feature is off
rather than degraded - the app is fully usable in a single tab, which is the
common case, and there is no cross-tab storage fallback.

## 13.4 Rate limits and kill switches (Phase 52)

The expensive operations - starting a radio station, resolving a stream URL,
searching, fetching recommendations, mutating a playlist, sharing a playlist,
recording a play - are rate limited per account, and per hashed
address+user-agent for signed-out visitors.

The limits are generous enough that ordinary use never reaches them. They exist
to stop runaway loops and provider-quota exhaustion, not to meter the product.
When one is reached the user is told plainly, in their language, and is not
charged for the failed attempt.

Provider quota is reduced structurally rather than by limiting the user
(Phase 55): repeated identical searches are coalesced in flight and cached
briefly, an expired official quota pauses official calls instead of failing
each request, and the result is the same list of tracks either way. The
per-account limits above are unchanged by this and still apply.

Every one of these features can also be switched off server-side, individually,
without a deploy. Turning a feature off never throttles the user and never
looks like a rate limit.

## 13.5 Correlation and error behaviour (Phase 52)

A failed action always returns a stable, documented error code and a
correlation id. The message is written for a person; the id is for support. An
unexpected internal failure never shows its own text to the user - it shows a
fixed message plus the id, because the internal text is where a query, a path
or an identifier would leak.

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
- Collaborative playlists / multi-owner playlists / shared editing
- Upload-based cover management (artwork is a URL; see §8.1)
- Link expiry, view counts, or password-protected share links (see §8.2)
- Payments / subscriptions
- Analytics / external telemetry
- Live radio / live streams (rejected by the resolver)
- Sleep timer / crossfade / gapless playback (the equalizer is *in* scope —
  it shipped, see §18 — but the other three are not)
- New providers beyond YouTube / Deezer / Spotify
- Machine-learned, embedding-based, or externally-served recommendations
  (see §15.1)

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

## 16. Multilingual UI

- **Supported locales:** Vietnamese (`vi`, default) and English (`en`)
  only. The selector shows full language names ("Tiếng Việt", "English"),
  never bare codes.
- **First-run experience is always Vietnamese.** No Accept-Language
  sniffing, no `/en`|`/vi` route prefixes; `<html lang>` follows the
  active locale.
- **Resolution precedence:** explicit authenticated preference →
  anonymous cookie preference → Vietnamese default. A saved account
  preference is never overwritten by the cookie on read.
- **Persistence:** anonymous `aurora-locale` cookie (1 year, `Path=/`,
  `SameSite=Lax`) plus a nullable `User.locale` column (no dedicated
  table); the set-locale action writes both. No `localStorage` /
  `sessionStorage` / `indexedDB` (banned by gates).
- **Switching:** the selector lives in existing shell surfaces (never a
  top-level destination); switching updates instantly, syncs the cookie,
  persists via the server action, and refreshes server-rendered parts —
  no reload, no remount. Playback engines never consume locale context,
  so switching cannot interrupt music, reset the queue, or recreate
  players.
- **Dictionaries:** `src/lib/i18n/vi.ts` is the source of truth for the
  `Messages` contract; `en.ts` must satisfy it exactly (enforced by type
  plus parity test). Translation via dotted keys with `{name}`
  interpolation, Vietnamese fallback, then the key itself; plurals,
  dates, and numbers via `Intl` (never manual suffixing or
  concatenation).

## 17. Appearance (Aurora Glass)

**Reachability.** Appearance lives on `/settings`, reached from the sidebar
footer on desktop and a header control on mobile. It is not a top-level
destination and adds no navigation item: a presentation preference is not a
place, and the Settings route was already reachable from the shell.

### 17.1 What a visitor gets

- **One switch, four looks, one background, and a disclosure.** The default
  view is a glass switch, a four-option preset group, a background section and
  a reset control. The eight individual sliders live behind "Advanced", because
  a form of ten controls whose defaults are already good reads as unfinished.
- **Presets are starting points, not modes.** Each sets glass alpha, blur,
  saturation, border intensity, ambient intensity and background dim
  together. A preset owns exactly those six values and nothing else —
  choosing a look never discards a background image or the ambience
  setting, and nudging one slider after choosing a preset is expected and
  supported.
- **Minimal is the performance choice.** It sets blur to zero, which removes
  every backdrop filter in the application in one selection. This is offered
  rather than inferred: the product does not inspect the device's hardware to
  decide (see `docs/scope-boundaries.md`).

### 17.2 Backgrounds

- Five shipped presets, one of which is the current default look, and a custom
  **https image address**. The address is the persisted choice and is labelled
  as such in the settings UI.
- A custom address is checked before it is applied: https only, no embedded
  credentials, at most 4 MiB, at least 480×320, at most 16 MP, and the type is
  determined from the bytes rather than the extension. An address that fails is
  never stored and never shown.
- **A local file can also be previewed, for the session only.** Nothing is
  uploaded: the file is validated in the browser (declared type, the same 4 MiB
  cap, decode success, and the same 480×320 / 16 MP dimension rules) and held as
  an in-memory object URL that is released when it is replaced, removed, or the
  tab closes. It is never written to the cookie or the account, it is labelled
  "Local upload — session only", and a reload returns to the persisted
  background (or to Aurora Default). A refused file reports why and leaves the
  persisted background untouched.
- Typing previews; **applying is a separate act.** A half-typed address never
  drives the application.
- Remove and Reset both clear the background, including a session-only preview.
  The background sits behind the whole application, is fixed, and does not move
  while the page scrolls.

### 17.3 What is guaranteed

- **Nothing interrupts.** Changing the glass, the background or the presets
  never pauses or restarts playback, never rebuilds the queue, and never
  recreates the engine. Glass settings are not part of the playback session
  snapshot and do not follow a restored session to another device.
- **There is no flash.** The first paint is already the chosen look, because the
  appearance is written onto the document during rendering rather than in an
  effect that runs after it.
- **A failure changes nothing.** A browser without backdrop filters, an image
  that will not load, a storage write that fails, or a refused address all fall
  back to the plain Aurora theme, which is fully usable.
- **Reduced motion is honoured,** and no ambient motion runs when it is asked
  for.
- **Persisted per account when signed in, per browser otherwise,** following the
  same precedence and the same two sinks as the locale preference (§16). The
  account and the browser copy cannot disagree.
- **Every control is a native element where one exists**, every state is
  exposed as text or a glyph as well as a colour, and every error is a
  translated sentence in both supported languages.

### 17.4 What is deliberately absent

- Upload-based backgrounds (a file that is transmitted or stored), object
  storage, and multi-megabyte binaries in the database. A local file may be
  previewed in-session, but it is never sent anywhere or persisted.
- Automatic quality downgrade based on the device.
- Per-track colour schemes driven by a faithful reproduction of the cover: the
  ambience is a restrained wash, opt-in, and off by default.
- A light theme, and any second presentation mode alongside this one.
## 18. Equalizer (Aurora V-Shape)

**What it is for.** Musical colouration, not correction. It is a taste control
that changes how the music is presented on the device you are listening on; it
is not a headphone or room-correction profile, and it is not derived from
anyone's measurements. See "Phase 53 addendum — Aurora V-Shape equalizer" in
`docs/scope-boundaries.md`, and `ARCHITECTURE.md` §33.6.

**Reachability.** Settings → Audio, on the same page as Appearance. The
equalizer adds no navigation item of its own. It is disabled by default: a
listener who has not chosen a curve hears music exactly as before this phase.

### 18.1 What a visitor gets

- **A switch, three presets, a comparison, and a disclosure.** The default view
  is the switch, a preset group (Aurora V-Shape / Flat / Custom), a hold-to-
  compare control and a reset. The ten band sliders and the preamp sit behind
  "Advanced".
- **Aurora V-Shape is the signature curve** and the default choice: a lifted low
  end, a relaxed midrange so vocals sit forward, and a raised top. It is a
  starting point — moving any band makes the preset Custom, which keeps the
  listener's shape rather than the name.
- **Flat is genuinely flat.** Every band at 0 dB and no preamp at all, so
  choosing it never leaves the V-Shape's headroom behind as a quiet preset.
- **A/B comparison is a hold, not a setting.** Press and hold to hear the
  uncorrected signal, release to come back. The stored curve is never modified,
  and no preference is written.
- **The preamp is headroom management, not a volume control.** It is labelled and
  explained as such, and while automatic is selected there is no slider at all
  — a control showing a value the system is about to overrule is worse than no
  control. The preset shows its declared figure (`Preamp: -3.5 dB`); automatic
  shows `Auto Headroom` and the figure it computed.

### 18.2 Aurora V-Shape

| Band | 31 Hz | 62 Hz | 125 Hz | 250 Hz | 500 Hz | 1 kHz | 2 kHz | 4 kHz | 8 kHz | 16 kHz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Gain (dB) | +2.5 | +3.0 | +2.0 | +0.5 | −0.5 | −1.0 | −0.5 | +0.5 | +2.0 | +1.5 |

The engineering rationale for every band is recorded in `ARCHITECTURE.md` §33.6.
Two constraints are worth stating in product terms: the bands run 31 Hz – 16 kHz
rather than 20 Hz – 20 kHz, because a control centred below a device's
reproduction limit is a control that appears to do nothing; and the filter width
is a constant Q of 1.41 throughout, so a band behaves the same way wherever it
sits.

**Measured, and stated because it is a fact about the shipped curve:** the ten
filters overlap, and the curve's true peak is **+3.83 dB at about 62 Hz**, not
the +3.0 dB the largest single boost suggests. With the −3.5 dB preamp this
leaves roughly +0.3 dB of headroom consumed. This is documented rather than
tuned away, and automatic headroom (which measures the whole chain) offers
−4.33 dB for a listener who would rather have a genuine safety margin.

### 18.3 What is guaranteed

- **Playback never depends on the equalizer.** If the browser has no Web Audio,
  or the graph cannot be built, or the audio element cannot be connected, the
  music plays exactly as it would with the equalizer off, and the interface says
  so in the same sentence as the failure.
- **The equalizer is never engaged onto a source the browser will not let Web
  Audio read.** A provider stream is cross-origin and carries no CORS headers,
  and a `MediaElementAudioSourceNode` over such a source is specified to output
  zeroes while the element itself plays normally — the element stays
  `paused: false` with `currentTime` advancing, the context is `running`, and the
  listener hears nothing. That was measured in Chromium on 2026-09-26, with the
  browser's own console message and a `MEDIA_ERR_SRC_NOT_SUPPORTED` result for
  the `crossOrigin` workaround. So before the equalizer takes the element, it
  asks whether Web Audio can read that source at all: same-origin and
  `blob:`/`data:` sources, and cross-origin sources the element loaded with
  `crossOrigin` set, are processed; a cross-origin source with no CORS opt-in is
  **refused**, the element is never touched, the music plays, and the interface
  says the *stream* is the problem rather than the listener's browser. The check
  is local — origin and the element's own CORS state, no network request of its
  own — and an element whose CORS check has not yet reported is **waited for**,
  not refused, because that refusal would be permanent and the question is not.
  **The consequence, stated plainly: on today's provider streams the equalizer
  is unavailable, by design rather than by defect,** and the same code is
  measurably audible the moment media delivery is something Web Audio may read.
  Making provider streams readable is a media-delivery change, not a mode
  switching one. Full evidence in `ARCHITECTURE.md` §33.8, deliberate deferral
  in `docs/scope-boundaries.md`.
- **Nothing about playback changes.** The equalizer has no playback controls: it
  cannot start, pause, skip, seek, replace a track or touch the queue. The curve
  is not part of the playback session, so clearing a restored session does not
  clear the equalizer and restoring one does not import a device's tuning.
- **The curve survives everything playback does** — play, pause, seek, next,
  previous, queues, playlists, radio, infinite listening and resolver retries —
  without rebuilding the audio graph or duplicating it. Changing the curve
  changes parameters, not structure.
- **Switching modes is a parameter change, never an audio event.** The four
  modes are Flat, Aurora V-Shape, Custom and Bypass (equalizer off, or the
  hold-to-compare control held). Choosing one never pauses playback, never
  resets position, never recreates the media element, the `AudioSource`, the
  controller or the `AudioContext`, and never asks for a track or touches the
  queue. It writes the ten band gains and the preamp onto the nodes already
  running, and the newest request wins when two arrive close together. Bypass is
  unity gain through that same live graph — not a disconnect — so coming back
  out of it restores the curve immediately, with no re-engagement and no
  second context.
- **The equalizer never silences the listener *because the context could not
  start*.** The audio element is only ever handed to Web Audio once the context
  has confirmed it is running; if the browser wants a user gesture first, the
  element keeps playing directly and the equalizer retries by itself at the next
  gesture. This is reported as a wait, not as an error, because it is not one.
  Waiting for a source, or for the element's CORS check to report, is the same
  kind of answer for the same reason.
- **No clicks.** Every band and preamp change is smoothed over 30 ms rather than
  stepped.
- **Persisted per account when signed in, per browser otherwise,** on the same
  two sinks and the same precedence as the appearance preference (§17.3). It is
  a column on the existing account, not a new preference system, and an untouched
  account stores nothing at all.
- **Every control is a native element where one exists**, every slider states its
  region, its frequency, its value with a sign, and its unit, and every string
  is translated in both supported languages.

### 18.4 What is deliberately absent

- Loudness normalisation, dynamic range compression, limiting and upsampling.
  The preamp exists to prevent clipping, not to shape a sound.
- A visible output level meter, and any claim that the preamp is doing more than
  it is.
- Per-device or per-headphone correction profiles.
- Anything audible that is not a direct consequence of the ten bands and the
  preamp.