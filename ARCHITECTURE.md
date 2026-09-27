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
| Recommendations | `src/lib/recommendations/service.ts` | Sole deterministic ranking; no playback, no queue, no persistence |
| Queue continuation ("Autoplay") | `src/lib/listening/coordinator.ts` | Sole *decider* of when/how much to generate; writes only through `QueueManager` |
| Autoplay UI | `src/components/player/autoplay-button.tsx` | Sole control; every surface renders it. One implementation, one state binder (`use-keep-listening.ts`), one holder/notification contract (`instance.ts`) |
| Public playlist read | `src/lib/dal/playlist.ts` (`getSharedPlaylistByToken`) | Sole unauthenticated playlist read; returns `SharedPlaylist`, which has no `ownerId` and no `shareToken` |
| Canonical track identity | `src/lib/domain/track-dedupe.ts` | Sole duplicate policy for playlists, the active queue and Recently Played; owns the key format and the auto-merge classifications (§11a) |

## 3. MusicEngine

Canonical high-level facade over existing subsystems (`No duplicated player,
queue, persistence, registry, or resolver state`).

- Transport delegates to the player store (which routes through
  `PlaybackController` when bound); search delegates to `UnifiedSearch`;
  events derive from `PlayerEngine` signals plus command transitions.
- Exposes state (`currentTrack`, `queue`, `playOrder`, `currentIndex`,
  `isPlaying`, `position`, `duration`, `volume`, `shuffle`, `repeat`,
  `isResolving`, `error`) and subscriptions; `EMPTY_ENGINE_STATE` for
  SSR/unmounted. `playOrder` is the published, reference-stable play
  sequence, because public indices are positions within it (§5) and a UI
  list rendered in that order must re-render when a reorder rewrites it.
  Every snapshot field is reference-stabilized against the previous
  snapshot: a selector may only rely on `Object.is` seeing a change when
  the value genuinely changed, otherwise `useSyncExternalStore` re-renders
  forever on a defensive copy.
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
`volume`, `muted`, `qualifiedTrackKey`, `userActionGeneration`, and the
restore guards `pendingRestorePosition` + `restoredTrackKey`).

- Physical `queue: Track[]` + logical `playOrder: number[]`; `position` is
  the cursor within `playOrder`. Shuffle reorders `playOrder` only.
- Public indices are positions within `playOrder`, not raw queue indices.
- `QueueManager` owns **no** queue array, listeners, timers, or caches —
  reads fresh store state per call, delegates every mutation via the single
  `QueueManager → PlayerStore` path. Shuffle/repeat/navigation edge cases
  deliberately stay in the store (covered by its suites).
- `QueueManager` does not own a second queue array. A shadow queue cannot
  diverge by construction.
- **Radio sessions append, never own:** the memory-only radio session
  (`src/lib/radio/session.ts`, lifecycle-owned by `PlayerHost`) generates
  bounded discovery batches and appends them through
  `MusicEngine.queue.add`; manual play/replace/clear ends the session via
  queue-signature comparison. No second queue, no radio playback path.
  Override detection and continuous generation both hang off the single
  `PlayerHost` store subscription, and that subscription must reach them
  for **every** queue-identity change: `replaceQueue`, `playTrack`,
  `playCollection`, and `clearQueue` each write `queue`, `playOrder`, and
  `currentTrack` in one `set()`, so a subscriber that returns early for
  "this is just a track change" would never see the override and would let
  a station refill a queue the user had just cleared. Cursor and order
  advances feed generation; identity changes feed override detection.
- **Restored sessions are identity-only.** `restoreQueueSnapshot` installs
  the persisted queue/cursor/shuffle/repeat/position/volume/mute as live
  state and sets `restoredTrackKey`, without loading a source and without
  autoplay. The first user-initiated Play then routes through
  `PlaybackController.loadTrack` instead of `ensurePlaying`, so the
  resolver produces a **fresh** source (a persisted URL would have expired);
  `ensurePlaying` on a source-less controller would otherwise resume an
  empty element. Any user-initiated load (next/prev/playAt/replace/clear/
  seek) clears `restoredTrackKey` and the pending restore position.
- **The store is the one point where the queue array is materialized, so it is
  the one point that enforces "one entry per canonical track."** `replaceQueue`,
  `addToQueue`, `playNext` and `restoreQueueSnapshot` all route through
  `dedupeCanonicalTracks` (§11a) — one implementation, four call sites, rather
  than a check in each. Consequences that are behaviour, not implementation
  detail: `A B C` + add `B` is `A B C`; `addToQueue` of a duplicate is a full
  no-op that runs **before** `countUserAction()`, so a rejected add writes no
  snapshot and invalidates no restore; and `playNext` of an already-queued track
  **repositions** the existing entry to the slot after the cursor (adjusting the
  target by −1 when the entry sits before the cursor) rather than inserting a
  second copy, and is a no-op when the track is already next or is the current
  track. Repositioning leaves the queue array itself untouched, so the stable
  entry identities a rendered row is keyed on do not churn.
- A persisted snapshot from before this invariant can still contain repeats.
  It is valid input, and `restoreQueueSnapshot` repairs it *coherently* — the
  entries collapse, the play order is re-pointed onto survivors and
  de-duplicated back into a permutation, and the cursor is re-resolved to the
  surviving slot — rather than splicing the stored arrays. Shuffle, repeat,
  media position and the resolved current track are all carried across the
  repair.

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
`types.ts`). Server-only.

- **Innertube:** format discovery; deciphering; in-flight request dedup
  (simultaneous resolutions share one request); results never cached (an expired
  URL can never be re-served); library objects treated as untrusted input, fail
  closed.

`youtubei.js` is imported by exactly two boundaries, each with its own test:
`playback/innertube-client.ts` (stream resolution) and `innertube/session.ts`
(discovery and the shared session). Both consume the same `Innertube`
instance — asserted as a count of `Innertube.create(`, with comments stripped,
not merely as a convention. See §8a.
- **Format discovery:** adaptive audio formats preferred; muxed audio+video
  acceptable last resort; video-carrying formats never outrank audio-only;
  MIME `audio/mp4` > `audio/webm` > other; higher bitrate wins;
  URL-lexicographic tie-break.
- **Browser-shaped range validation (critical rule):**

  ```text
  YouTube adaptive (DASH) audio URLs refuse any request that would return the
  whole body — `Range: bytes=0-`, no `Range` at all, or HEAD — with HTTP 403,
  while a bounded range returns 206 from the same URL. A browser media element
  always issues the whole-body form first, so Chromium reports
  ERR_BLOCKED_BY_ORB and then MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) even
  though the resolver handed out a well-formed AudioSource. These candidates
  are therefore validated before becoming AudioSources.
  ```

  The probe mirrors the browser's first request (`Range: bytes=0-`,
  status only, body cancelled, 5s timeout, URL never logged/returned);
  200 **or** 206 is consumable, because a CDN may legitimately answer a
  whole-body media read with either. A resolved YouTube URL is **not**
  automatically considered browser-playable. Rejected adaptive candidates
  fall through to the documented muxed fallback while preserving
  audio-only preference.

  **Measured consequence (2026-09-26).** The refusal is the norm, not an edge
  case: across 14 sampled videos, the adaptive audio ladder of **13** refused
  whole-body reads and only the muxed (progressive, itag 18) format of the same
  video answered them. The single exception is also the only video the E2E
  fixture uses, which is why the suite never saw it. So for real content the
  muxed fallback is the *steady-state* selection and audio-only selection is
  currently unreachable; playback is correct but carries a video payload
  (~2x the Opus bitrate; 27 MB for an 850 s video, 231 MB for a 150 min one).
  This is a provider-side policy, not a resolver defect: it reproduces on every
  InnerTube player context tried, including `IOS`, which hands out direct
  (undeciphered) adaptive URLs that still 403. Removing it would need a
  server-side re-chunking proxy, which is out of scope — see
  `docs/scope-boundaries.md`.

  **Server vs browser.** The probe answers "is this source reachable and
  playable", never "can this browser decode it" — the server has no media
  decoder, and `canPlayType` is never called from server code. Nothing gates on
  `Content-Type`: it is recorded with parameters stripped
  (`audio/mp4; codecs="mp4a.40.2"` → `audio/mp4`) purely for diagnosis, because
  a strict content-type match is precisely the false negative that would reject
  a valid format.

  **Skip reasons.** A rejected candidate logs `playback_format_skipped` with
  `itag`, `reason` (a stable `FormatProbeReason`: `probe_status_403`,
  `probe_status_404`, `probe_status_416`, `probe_status_other`,
  `probe_timeout`, `probe_network_error`, `missing_url`), `status`,
  `contentType`, and `boundedRangeOk`. A 403 alone cannot distinguish a dead
  URL from the whole-body refusal above, so a rejected 403/416 is confirmed
  with **one** extra bounded read that sets `boundedRangeOk`. That flag never
  promotes a candidate: the browser would still fail on it, and promoting it
  would reinstate the code-4 regression. When no candidate survives, one
  `playback_resolution_failed` record summarises `candidateCount` /
  `validCount` / `rejectedCount` / `topRejectionReasons`, plus the boolean
  `aliveButRefused` described next. No signed URL appears in any of it.

  **Refused-but-alive is a transient failure (2026-09-27).** "No consumable
  format" is two different failures wearing one message, and the distinction
  the probe already collects decides between them. Measured on 2026-09-27: an
  8-minute burst of live-playback tests drove **all seven** candidates of one
  video to `probe_status_403` — including the progressive format, which had
  answered 206 on every candidate minutes earlier — while a bounded read on
  each still succeeded; an isolated probe of the same video immediately after
  returned 206 on all seven. The media existed; the CDN was declining the
  browser's whole-body read *at that moment*. So when every candidate was
  refused **and** each proved alive on the bounded read, the `stream`-stage
  error is raised with `retryable: true` and recovery performs its bounded
  retry; every other combination (404, a 403 with no bounded confirmation, a
  timeout, a network error, zero candidates) keeps the permanent default,
  because re-resolving the same identity cannot change the answer. A single
  dead candidate among alive ones is enough to stay permanent — a 404 means
  the media is gone, so the surviving signed URLs point at nothing. The
  distinction is computed from the probe's own evidence, so an injected test
  validator (a bare boolean, reason `validator_injected`) can never make a
  source look recoverable.
- **Expiry:** `expiresAt` carried on the `AudioSource`; expired candidates
  skipped at selection and rejected at load.

## 8a. YouTube discovery: InnerTube-first, Data API as fallback (Phase 55)

The official Data API bills `search.list` at **100 units against a separate
100/day default**; `videos.list`, `channels.list`, `playlists.list` and
`playlistItems.list` cost 1 unit each. The quota problem is therefore
`search.list`, and reducing it is a data-source decision rather than a
caching one.

- **The tier lives at the transport seam.** `YouTubeApiTransport`
  (`types.ts`) is the existing interface. `innertube/transport.ts` and
  `tiered-transport.ts` both satisfy it, so **`youtube-provider.ts` has no
  Phase 55 changes**. Adding a second data source cost one module, not a
  refactor, and the provider stayed source-agnostic by construction.
- **Primary = InnerTube** for `searchVideos`, `searchChannels`,
  `searchChannelVideos` and `getVideos`. Fallback = the official API, and the
  only source for `channels.list` and the two playlist endpoints. Every
  remaining endpoint is classified in `docs/youtube-request-map.md`; no
  official call is unexplained.
- **The library's shapes are measured, not remembered.** InnerTube returns a
  different node family per surface: a typed video search returns `Video` nodes
  (`video_id`, `title.text`, `author.{name,id}`), a typed channel search returns
  `Channel` nodes (name in `author.name`), a channel's videos tab returns
  `RichItem`-wrapped `LockupView` at `current_tab.content.contents`, and
  `getInfo` returns `basic_info` whose `author` is a **plain string** with
  thumbnails at `basic_info.thumbnail`. Two further facts are load-bearing:
  `yt.search` is asked for a **typed** result set, because an unfiltered search
  includes an `OfficialCardView` that `youtubei.js@18.0.0` cannot parse; and
  the `page_contents` lazy getter **throws** on any feed without a `Tab` node
  (which is every search), so each candidate location is read inside its own
  `try`. The first implementation got all of this wrong in a way that every test
  agreed with, and the phase saved no quota while the suite was green — see
  `docs/youtube-request-map.md` for the captured payloads and the reasoning.
- **The quality gate is a pure function** (`decideSearchSource`):
  `innertube` or `data-api` with a reason. It is deliberately asymmetric —
  an *empty* InnerTube result is treated as a parse failure and routed to the
  official API, never cached as "no results". A YouTube markup change and a
  genuinely empty result are indistinguishable from inside the transport, and
  one of them is a bug. The asymmetry is cheap: being wrong costs one
  `search.list`; the opposite error is permanently broken search. Its corollary
  is that the gate also **hides a primary that never worked** — a fallback that
  absorbs every primary failure is a mechanism for concealing exactly that — so
  the primary is verified against live YouTube, not only against fixtures.
- **One deadline per operation, including the session handshake.** Two timeouts
  in series are two budgets, not one: a wrapped handshake plus a wrapped request
  let an unreachable primary spend 24 s before the official API was tried, and a
  radio station asks for two avenues. A failed handshake is additionally
  remembered as failed for a short window, so a dead primary is paid for once
  rather than once per caller.
- **No fan-out.** The official API is called *instead of* the primary, never
  alongside it, and the official result replaces the primary's rather than
  merging with it. Merging two ranked lists would both spend the quota and
  produce a worse list.
- **Unimplemented operations throw** `InnerTubeUnavailableError` rather than
  returning empty, so the router gets an unambiguous routing signal instead of
  a cacheable false "nothing found".
- **Cache hierarchy** (`innertube/cache.ts`): L1 in-flight coalescing → L2
  bounded memory with per-operation TTLs (search minutes, video identity
  hours) → upstream. Short negative TTL, explicit key/prefix invalidation, and
  a `forbids` predicate that refuses any value carrying a signed media URL, so
  §56 is structural rather than a convention. Normalised keys fold case and
  whitespace but **preserve Vietnamese diacritics** — folding them would serve
  one answer for two different questions.
- **Quota telemetry and breaker** (`innertube/metrics.ts`,
  `innertube/data-api-circuit.ts`) cover the **official API only**. Daily,
  rate and throttle classes get separate open windows (23h / 60s / 5s).
  Recovery is the window expiring and the next call going out as a half-open
  probe, not a success: a circuit that refuses all traffic cannot observe a
  success, and probing a known-exhausted daily budget is the retry storm the
  breaker exists to prevent. **One owner per counter** — a counter two layers
  can increment counts code paths, not events, and makes every derived ratio
  uninterpretable.
- **The gate between them is observation, not a new surface.** The
  `/api/health` probe stays minimal and provider-free by design, so the
  counters are exposed as a library snapshot plus structured log events rather
  than a new unauthenticated endpoint. See `docs/scope-boundaries.md`.

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
- **Radio discovery (server-only):** `src/lib/radio/service.ts` generates
  bounded batches from seed + provider avenues (same-artist/album search,
  artist/album tracks, popular catalog) with calibrated-matcher grouping
  and deterministic ranking; `src/lib/radio/backend.ts` fans out across
  capable providers with per-avenue failure isolation. Surfaced via server
  actions (`src/app/actions/radio.ts`); the browser only ever receives
  normalized tracks. Deterministic E2E fixture catalog under
  `AURORA_E2E_AUTH=1` (same test-only pattern as the fixture library).

## 9a. Search input classification and link resolution

One search field, three outcomes. The field classifies its own value
**before any network call**, and the result of that classification decides
which of two already-existing paths runs.

```text
classifySearchInput(value)
 ├─ "query"            → unified text search (unchanged)
 ├─ "source"           → resolveSearchLink (URL → canonical resource)
 └─ "unsupported-url"  → inline refusal, never passed on as text
```

- **One parser.** `detectSource` / `isSupportedInput` in
  `src/lib/providers/source-detection.ts` is the canonical URL parser;
  `providerHostOf()` exposes its host allowlist beside it. `src/lib/search/input.ts`
  is a classifier over that parser, not a second one: it adds
  `looksLikeUrl` (trimmed, whitespace-free, `http(s)://`), the
  `SearchInputKind` union, canonical-URL and canonical-query helpers, and
  `providerDisplayName()` shared by the detection hint and the result
  eyebrow. There is no provider selector and no second "search URL" button.
- **Classification is string work.** It runs on every keystroke, costs no
  request, and is the reason no provider is asked anything while a URL is
  being pasted. Unparseable `http(s)` input, an allowlisted host with no
  readable resource, and a foreign host all classify as `unsupported-url`;
  non-`http(s)` schemes (`javascript:`, `data:`) are prose, not links, and
  classify as `query`.
- **`?q=` is validated as a URL first.** The search page classifies before
  `searchQuerySchema`, whose 200-character prose cap would otherwise reject
  a long playlist URL with a schema error. Unsupported links render
  `CategoryError` — an inline, labelled error state on the same page, never
  a full-page spinner.
- **Track resolution** (`src/lib/search/resolve-link.ts`): the id from the
  URL is used directly — a known YouTube video id is never re-discovered
  through `search.list` — and `extractorManager.getTrack` fetches
  metadata, which becomes a canonical identity through `toTrackIdentity`.
  Only a *foreign* source (Spotify, Deezer) then buys **one**
  `searchAll(query, { providers: ["youtube"], limit: LINK_MATCH_CANDIDATES })`
  and an `enrichIdentity()` merge; YouTube sources skip matching entirely.
  The result is a plain identity that the existing UI hands to
  `engine.play()`. Playback source resolution happens at play time and is
  never persisted.
- **Collection resolution** loads a bounded page (`LINK_COLLECTION_LIMIT`),
  normalizes every entry, cross-source matches non-YouTube sources with the
  same bounded fan-out (`LINK_MATCH_CONCURRENCY`), and deduplicates on
  canonical identity **after** enrichment. `provider.getPlaylist` /
  `getAlbum` are reached through structural `PlaylistCapable` /
  `AlbumCapable` narrowing, so a provider without the capability is a
  runtime refusal rather than a cast.
- **An action boundary, not a feature branch:** `resolveSearchLink` is
  behind `src/app/actions/resolve-search-link.ts`, guarded by
  `guardServerAction({ bucket: "search" })`, which re-classifies its own
  input and returns a typed payload or one of four codes
  (`not-found` / `unsupported` / `unavailable` / `unsupported-input`). The
  browser never sees a provider message, a stack, a key or a signed URL.
- **Security:** only `http(s)`, only an allowlisted host
  (`youtube.com`, `music.youtube.com`, `youtu.be`, `open.spotify.com`,
  `deezer.com`), only recognized resource types, only id shapes the parser
  accepts. The server never fetches an arbitrary URL the user supplies and
  there is no URL proxy: every outbound call is a structured provider API
  request built from a validated id.
- **Nothing new owns state.** Pasted links enter the existing queue,
  playlist and Recently Played paths only after canonical dedupe; search
  history stores `canonicalSearchInput()` — the trimmed text for a query,
  the rebuilt canonical URL for a link, and `""` (nothing recorded) for a
  refused link, so tracking parameters are never persisted.

## 10. Track model

```text
Track ── provider-scoped catalog row (frozen streamUrl/previewUrl, never playback input)
TrackIdentity ── logical track (Aurora cuid id, sources[], primarySource)
SourceReference ── stable per-provider external id (source:id, display url, isrc/channel/album/artist metadata)
SearchResult ── engine search envelope (items, query, sources, total, nextOffset)
AudioSource ── ephemeral play-time source (url, mimeType, durationMs, expiresAt, bitrate)
```

- Internal Aurora ID (`cuid`) is never derived from a provider hash.
- **Identity ids never depend on a secure context.**
  `generateIdentityId()` (`src/lib/domain/track-normalizer.ts`) runs in the
  browser as well as on the server, and `crypto.randomUUID()` exists only in
  a secure context: on `http://192.168.1.32:3000` it is `undefined` and a bare
  call threw, which broke play/queue/like for every LAN visitor. It now falls
  back `randomUUID()` → RFC 4122 UUIDv4 from `getRandomValues()` → a
  never-throwing `Math.random` hex of the same shape, mirroring the ordering
  already used by `multi-tab/playback-ownership.ts`. The first two links are
  CSPRNG-backed and are what every supported browser takes; the last link
  exists only so a hostile environment degrades to a non-cryptographic id
  instead of no playback at all.
- `sources` grows **only** through explicit `mergeSourceReference`; automatic
  cross-provider matching that invents references is forbidden.
- Playback persists only `TrackRef` (`provider` + `providerTrackId`); a
  fresh `AudioSource` is resolved on restore. No persisted temporary stream
  URL anywhere — no storage APIs, no SW caching, no test fixtures. The
  `Track` table retains legacy nullable `streamUrl`/`previewUrl` columns
  (left in place rather than rewriting migration history), but nothing writes
  them: the playback session's snapshot excludes them, and the catalog write
  path refuses them (invariant 34).

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
- `AUTO_MERGE_CLASSIFICATIONS` (`["exact", "strong"]`) and `isAutoMergeable`
  are the one statement of which verdicts a caller may act on unattended. §11a
  consumes them; nothing re-states the threshold locally.

## 11a. Canonical collection identity

One module, `src/lib/domain/track-dedupe.ts`, answers "is this the same
logical track as something I already have?" for every collection that has to
ask. It holds no state, does no I/O, and is shared verbatim by the client
store and the server DAL — so "duplicate" cannot mean one thing in the queue
and another in a playlist.

```text
canonicalTrackKeys(track)  → "source:id" for the row and every source a merged
                              group carries in metadata.sources
canonicalIdentityOf(track)  → TrackIdentity, or null when it cannot canonicalize
CanonicalDuplicateIndex     → key Map (O(1) tier 1) + memoized identities,
                              matcher only on a key miss
dedupeCanonicalTracks<T>    → { kept, keptIndices, duplicates, resolve }
findCanonicalDuplicate      → one-shot form for insert-time checks
```

`resolve` is a **total** `number[]` mapping every input index to the survivor
that absorbed it, which is what lets a queue cursor, a `startIndex` or a
persisted position be re-pointed onto a survivor instead of silently shifting
when an earlier entry is removed.

Forbidden as identity: array index, title alone, artist alone, provider URL
alone, object reference, a random id, and any ephemeral playback URL.
`streamUrl`/`previewUrl` are catalog-row display fields and are never identity
(§10, invariant 8), so duplicate detection never resolves a playback URL and
costs no provider request.

Three behaviours are load-bearing and easy to get backwards, so they are
enforced by test rather than by convention:

- **Fail open.** An uncanonicalizable track is never a duplicate. Two rows that
  both lack a stable provider id are two entries, even if their titles and
  artists are identical — the same title on a *missing* id is not evidence.
- **Never merge `possible`.** Only `exact` and `strong` collapse a list;
  `possible` and `rejected` never do.
- **First occurrence wins, always.** Survivors are the earliest entry, so
  relative order is preserved and a result is reproducible from the same input
  regardless of which call site runs the collapse.

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
  stale writes return `false`, never overwrite (a stale tab cannot clobber
  a newer session). Same-track seek discontinuities feed the debounced
  session snapshot.
- **Save strategy** (`src/lib/player/persistence.ts`): persist on
  meaningful change (queue mutations, track changes, shuffle/repeat,
  volume/mute) through a trailing debounce, plus a periodic checkpoint
  while playing, plus track-change/pause checkpoints. `visibilitychange`
  (hidden) and `pagehide` are a final best-effort flush only — an
  in-flight request is not guaranteed to survive page teardown — so a
  flush that arrives while a write is in flight re-arms after that write
  settles instead of being dropped. Write-dedupe compares a content key
  (queue, order, cursor, position, shuffle, repeat, volume, mute) that
  deliberately excludes `savedAt`, so a heartbeat cannot re-serialize an
  unchanged session into a pointless request. Clearing the queue deletes
  the row; replacing it overwrites it, so a cleared or replaced session
  never returns. UI components never persist anything themselves: they
  mutate the store, and the single `PlayerHost` subscription is what
  notifies the controller.
- **Snapshot versioning** (`src/lib/player/queue-snapshot.ts`): the JSON
  column is a versioned, migratable structure, never an opaque blob.
  `v1` = queue + `playOrder` + cursor + `mediaPosition` + shuffle +
  repeat; `v2` adds `volume`, `muted`, and `savedAt`. Older versions are
  upgraded on read by `migrateQueueSnapshot` at documented defaults, so
  an existing account keeps its queue; unknown/future versions are
  discarded rather than guessed at, and a malformed snapshot is never
  half-restored.
- **Restore invariants:** occurrences are preserved positionally
  (repeated tracks keep every slot, no dedup), and the cursor is restored
  as a queue occurrence rather than a track name. Only the cursor entry
  is re-resolved through `PlaybackResolver`; queued entries stay
  identity-only until played. The restored position is asserted as a
  bounded neighbourhood (±3s), because restore normalizes the value and a
  real media element may advance before playback is audible — actual
  progression of a live stream is covered by the live playback suite, not
  by the deterministic restore test.
- Every mutation takes a server-resolved `userId`; ownership rechecked
  (`requirePlaylistOwner` → `ResourceNotFoundError` / `AuthorizationError`).
  Client `isOwner` flags are display-only.
- **The catalog is a shared, unowned cache, so its write path is the trust
  boundary (Phase 49).** `Track`/`Artist`/`Album` carry no owner column, so
  there is nothing to authorize a catalog write against — unlike
  `Playlist`/`Like`/`Follow`, which are always scoped by a server-resolved
  `userId`. Two consequences, both enforced in the DAL and not in the UI:
  - `upsertTrack` does **not** accept `streamUrl`, `previewUrl` or
    `metadata`. Those are excluded from its parameter type and absent from
    both its `create` and `update` branches, so no client payload can place
    a media URL on a row that every other user — and every anonymous visitor
    of a shared playlist — reads back. The `Track` table still carries the
    legacy nullable columns; nothing writes them.
  - `addTrackSchema` omits the same three fields, so zod strips them at the
    untrusted edge before the value can reach the DAL. Schema validation is
    shape, not authorization: it never substitutes for the DAL's `Pick`.
  - **One track contract, both writers (2026-09-27).** `trackInputSchema` is
    the single definition of a client-writable `Track`, and both catalog-writing
    actions parse through it: `addTrackToPlaylistAction` and `likeTrackAction`.
    The like path previously applied no validation at all, so any signed-in
    caller could write an arbitrarily long `title`/`artistName`/`artworkUrl`/
    `providerUrl`/`genres[]` into a row every other user renders. Fields are
    bounded far above real provider metadata (text 500, URLs 2048, 20 genres,
    finite non-negative duration), and `title`/`artistName` are required
    non-empty because `normalizeTrack` already throws on an empty one — so no
    legitimately produced track can be rejected by that rule. `provider` stays a
    bounded open string, not an enum: `ProviderId` is `string` by design so a
    provider can be added without a schema change. The **parsed** value is what
    is passed to the DAL, never the caller's object, so a stripped or trimmed
    field cannot reach the DAL by way of the original argument.
  Playback does not depend on those columns. `PlaybackController` resolves a
  fresh `AudioSource` per load and never reads `streamUrl`/`previewUrl` as
  playback input, not even as a fallback, so removing the write path cannot
  break playback.

## 13. Database

PostgreSQL via Prisma 7 (`prisma/schema.prisma`; migrations in
`prisma/migrations/` — eight to date, the set kept explicit by the
allowlist test in `src/lib/dal/__tests__/playback-schema.test.ts`).
Client emitted to `src/generated/prisma`.

| Model | Purpose |
|---|---|
| `User` | Identity; owns library rows; nullable `locale` holds the explicit authenticated language preference (null = no preference) |
| `Account` | OAuth linkage (`@@unique(provider, providerAccountId)`) |
| `Session` | DB session rows (JWT strategy primary) |
| `VerificationToken` | Auth.js verification (`@@unique(identifier, token)`) |
| `Artist` | Catalog artist (`@@unique(provider, providerArtistId)`) |
| `Album` | Catalog album (`@@unique(provider, providerAlbumId)`) |
| `Track` | Catalog track (`@@unique(provider, providerTrackId)`; frozen `streamUrl/previewUrl` never playback input) |
| `Like` | User–track favorite (`@@unique(userId, trackId)`) |
| `Follow` | User–artist follow (`@@unique(userId, artistId)`) |
| `RecentlyPlayed` | Recently-played row — **one per (user, track)** (`@@unique([userId, trackId])`, `@@index(userId, playedAt)`); deliberately not a play-event log |
| `SearchHistory` | Query log (`@@index(userId, searchedAt)`) |
| `Playlist` | User playlist (title, description, artwork URL) |
| `PlaylistTrack` | Membership (`position`, `addedAt`; dual uniques) |
| `PlaybackState` | One row per user (`userId @unique`: provider, providerTrackId, position, revision, versioned session `queueSnapshot` JSON) |

Every migration to date is additive to the *schema*, with one reviewed
exception: `20260926130000_recently_played_one_row_per_track` also deletes
the duplicate `RecentlyPlayed` rows its new uniqueness requires (that
delete, and the rollback note for each of the eight migrations, is recorded
in the allowlist test). Deploy explicitly via `prisma migrate deploy` —
never auto-migrated at boot. New migrations fail the allowlist test closed
until the rollback analysis is redone.

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
- **The auth route re-anchors its request origin to the browser's host.**
  `src/app/api/auth/[...nextauth]/route.ts` wraps `handlers.GET`/`POST` in
  `toBrowserOrigin()`: when Next's `request.url` origin differs from
  `x-forwarded-host ?? host` (Next 16 dev pins it to `http://localhost:3000`
  from `resolve-routes.js`, regardless of the `Host` header), the handler is
  handed a rebuilt `NextRequest` on the browser's host, otherwise it is
  passed through untouched. Auth.js derives every URL it emits —
  `signinUrl`, `callbackUrl`, the OIDC `redirect_uri`, and the post-callback /
  sign-out redirect (`baseUrl: url.origin`) — from `request.url`, so without
  this a phone opening `http://192.168.1.32:3000` is handed
  `localhost:3000` links that resolve to the phone itself. The rewrite
  changes the origin only: the scheme is read from `x-forwarded-proto` or
  the request's own scheme and never guessed, so plain HTTP keeps
  non-`Secure` cookies and `trustHost: true` remains Auth.js's documented
  trust in host headers. No cookie flag, `SameSite` policy, safe origin or
  redirect target is relaxed anywhere. The app's own `signInWith` /
  `signOutUser` server actions were already correct (they build their URL
  from `headers()`); this closes the `/api/auth/*` surface they share with
  the default sign-in page.
- Language preference (`src/lib/dal/locale.ts`): `getUserLocale` /
  `setUserLocale` on the nullable `User.locale` column — not a dedicated
  table. Null means "no explicit preference" (falls back to cookie, then
  Vietnamese).

## 15. PWA architecture

- **Identity has exactly one source.** `src/lib/app-metadata.ts` states
  Aurora's name, short name, descriptions, canvas colours, manifest id,
  start URL, scope, display strategy, orientation, categories, icons and
  shortcuts. The web app manifest, the root layout's metadata, and the
  `/api/app-config` endpoint all read from it; none repeats a literal. The
  theme colour is pinned to the `--p-neutral-0` canvas token by test, so it
  cannot drift again (it had).
- **Manifest** (`src/app/manifest.ts`, Phase 51): framework-native, served at
  `/manifest.webmanifest`, typed against `MetadataRoute.Manifest`, and cached
  by default. It **replaced** `public/manifest.webmanifest` — two manifest
  sources would let the launcher's identity and the application's identity
  drift apart. Fields: stable `id: "/"`, `start_url`/`scope` `/`,
  `display: standalone` with a degrading `display_override` chain
  (`standalone → minimal-ui → browser`), `orientation: any` (no artificial
  lock), theme/background `#08070d`, 192/512 plus a genuinely distinct
  maskable 512, `categories`, and `lang`/`dir` for the shipped default.
- **`window-controls-overlay` is deliberately not enabled.** It is honoured
  only by Chromium desktop and would move the application header under the OS
  title bar with no layout work behind it. Left off rather than shipped broken.
- **Shortcuts** (`Search`, `Library`, `Radio`) are asserted against the real
  route table by test. There is no `/settings` route, so there is no settings
  shortcut; liked tracks live in `/library`, so a second entry is noise.
- **Service worker** (`public/sw.js`, Phase 20): application-shell scope
  only — never resolves, proxies, or caches audio; never touches provider,
  auth, or user data. Classifier: same-origin `/_next/static/*` →
  cache-first; top-level navigations → network-first with built-in offline
  fallback; everything else (POST, `/api/*`, cross-origin incl.
  `googlevideo.com`, images) → network passthrough with zero worker
  overhead.
- **Registration is feature-detected with an `in` test, and a truthiness
  guard does not count.** `navigator.serviceWorker` is a `[SecureContext]`
  interface: on a plain-HTTP origin — a LAN/IP host *and the deployed
  production origin, which is served over plain HTTP* — the property is not
  exposed at all, so the container is `undefined`. The first effect therefore
  opens with `!("serviceWorker" in navigator)` before it may read
  `navigator.serviceWorker`. `if (!container) return undefined` is correct
  TypeScript and the unit tests passed straight over it, and the production
  compiler still eliminated that branch as dead code, because it treats
  `navigator.serviceWorker` as always defined. The shipped bundle consequently
  evaluated `typeof container.register` on `undefined`, threw
  `TypeError: Cannot read properties of undefined (reading 'register')` out of
  a root-layout effect, and unmounted the tree in a PlayerHost
  `app_initialized` / `app_shutdown` loop until the page was unusable. An `in`
  test is a runtime presence check the compiler must keep — it is the form the
  other two effects in this component already used. Because a source-level
  test cannot see an eliminated branch, the invariant is held by two gates on
  the built artifact: `bun run verify:client-bundle` fails if the compiled
  `.register(` is not preceded by a `serviceWorker"in navigator` test, and
  `e2e/pwa.spec.ts` runs the production bundle against a `navigator` with the
  API removed (exactly the insecure-origin surface) and requires the shell to
  render with no uncaught error and no `app_shutdown`.
- **Cache version:** single `aurora-sw-v2:static`; activation deletes older
  `aurora-` caches, never foreign caches; no HTML ever cached.
- **Update flow is deferred, never forced** (Phase 51). A new worker does not
  `skipWaiting()` on install: it parks, and the page hands over control at
  `pagehide`, when the current document is leaving anyway. Taking control
  mid-session would re-parent a running page onto a new build, and Aurora's
  listening session must survive a deploy. A new build is therefore picked up
  on the next launch. Deliberately decoupled from the player: the worker only
  serves hashed static assets and the release point needs no transport state.
- **Offline fallback** is built per request from the `aurora-locale` cookie
  carried on the navigation, defaulting to Vietnamese, the shipped default.
  Nothing is read from or written to any cache, so no personalised or
  authenticated HTML can leak between users or sessions.
- **googlevideo passthrough + API passthrough:** identified first, never
  intercepted beyond identification, never cached (unit-tested classifier).
- **Registration boundary:** `ServiceWorkerRegister` registers `/sw.js`
  production-only (`shouldRegisterServiceWorker`, `src/lib/pwa/
  service-worker.ts`). Development sessions never register — Turbopack
  serves the live module graph from `/_next/static/*`, so a cache-first
  worker would serve stale chunks. Development instead releases stale
  own-scope (`/sw.js`) registrations; foreign workers/caches untouched.
- **Install flow** is one authority, not per-component listeners.
  `InstallProvider` (`src/components/pwa/install-prompt.tsx`) owns the single
  `beforeinstallprompt` listener and the single deferred prompt; the pure
  decision table in `src/lib/pwa/install.ts` classifies the runtime as
  `installed` / `installable` / `dismissed` / `manual-instructions` /
  `unknown`. The prompt is never shown automatically — it is armed by the
  event and fired only from a click, and it is called at most once because the
  event is single-use. Decline is persisted as an anonymous cookie (the
  browser storage APIs are gated out of production source) so the offer does
  not return on every route.
- **Platform detection is centralised** in `src/lib/pwa/platform.ts`: one
  ordered `display-mode` resolution, a typed `Platform` union that reports
  `web` today, and capability fields that are *measured*, never assumed.
  `offlineAudio` is hard-coded `false` — there is no offline download
  feature, and advertising one would be a promise the worker cannot keep.
  Components never call `window.matchMedia` themselves.
- **Hydration contract:** nothing window-derived reaches the markup on the
  first client render. The provider uses `useSyncExternalStore` with a `true`
  server snapshot (the primitive the MusicEngine bindings already use) rather
  than a `useState` + `useEffect` mounted flag, so iOS and Chromium produce
  identical HTML for the same page.
- **Safe areas:** the root layout sets `viewportFit: "cover"`, which is what
  makes `env(safe-area-inset-*)` resolve to real values at all; without it
  iOS reserved that space itself and every inset in the shell, player and
  queue silently evaluated to 0. Top, left and right insets are consumed by
  the header, content column, bottom navigation, mini player, full player and
  queue panel; the bottom-most element alone owns the bottom inset.
- **Client configuration** (`/api/app-config`): safe, unauthenticated, static.
  Carries name, short name, description, `appVersion` (read from
  `package.json` server-side only), `apiVersion`, locales, `platform:
  "web"`, start URL, scope, deep-link patterns, and the server-guaranteed
  capability set. It asserts nothing about the caller's runtime — Media
  Session, Web Share, notifications and installed state are measured in the
  browser — and exposes no secret, key, user data, or filesystem path.

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
  never leaks - curated messages, URL scrubbing, offline detection,
  `preservePlayback: true` always. Locale-aware (`locale` param, English
  literals byte-identical by default, Vietnamese via dictionary);
  codes, categories, and flags are never localized. Categories: network, offline,
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
- **Dev origin allowlist (`allowedDevOrigins`), development only.** Next
  blocks cross-origin requests to dev-only endpoints (`/_next/hmr`,
  `/__nextjs_font`) for any host other than `localhost`, so opening the dev
  server from another device returned 403 and the app never hydrated.
  `src/lib/config/dev-origins.ts` builds the list at config-eval time:
  loopback always (`localhost`, `127.0.0.1`, `[::1]`) plus every non-internal
  IPv4/IPv6 interface address the host actually holds, or exactly the entries
  in `AURORA_DEV_ORIGINS` (comma/space separated) when that variable is set —
  an empty value means loopback only. Entries are reduced to a hostname and a
  bare `*` / `**` is refused, so the list can never widen to "every host that
  can reach the port". `next.config.ts` spreads the key only when the list is
  non-empty and only when `NODE_ENV === "development"`, so production headers
  and CSP are byte-identical to before. Browser code keeps calling
  same-origin relative URLs; nothing in `src/` may read this list.
- **Playback URL handling:** memory-only ephemeral URLs; resolver accepts
  exact provider ids only; no generic fetch/proxy endpoint.
- **SW cache boundaries:** statics only; never HTML/API/auth/provider/
  playback.
- **Client bundle scanner:** `verify:client-bundle` fails the pipeline on
  server markers in production chunks.
- **Public playlist sharing (Phase 47):** the share token is 24 CSPRNG bytes
  rendered base64url (192 bits), stored in a unique column and returned to
  the owner only. The public route performs no session check, needs no
  middleware, and refuses a miss, a malformed token, a revoked link, and a
  private playlist identically — no redirect to sign-in, and no description
  in the page metadata, so a prober cannot tell them apart. Owner
  attribution is a display name: `SharedPlaylist` carries no `ownerId` and
  no `shareToken` field, so the owner cannot be identified and the link
  cannot be re-shared by scraping. Artwork on a shared page renders through
  the existing `Artwork` primitive, which passes `unoptimized` to
  `next/image` — the image-optimization loader is never invoked and no
  remote host is added to the Next image config for a value the owner chose.
- **Every `notFound()` on a dynamic segment answers 200 with the not-found
  body.** This is an app-wide property of the current Next version plus a
  `not-found.tsx` inside a route group: `/track`, `/album`, `/artist` and
  `/library/playlists` all behave the same way. It is not a disclosure — the
  body is the not-found page and carries no entity data — but it does mean
  the HTTP status cannot be used as a signal, and crawlers see a 200 unless
  `robots` says otherwise (the share route sets `robots: { index: false }`
  on refusal). Verified by `bun run verify:share-route`.
- **Playlist artwork is never trusted as content.** Only http/https with a
  host and ≤2048 characters is accepted; `javascript:`, `data:`, `blob:`,
  `file:` and protocol-relative values are rejected server-side. No bytes
  are ever accepted, so there is no upload surface, no type/size/dimension
  parsing, and no client-supplied MIME to trust.

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
- **Toolchain (Phase 50):** Bun 1.4.0 is the package manager and script
  runtime; `bun.lock` is the only lockfile and `packageManager` pins
  `bun@1.4.0`. Scripts run via `bun run`, one-off CLIs via `bunx`, and CI
  installs only with `bun install --frozen-lockfile`. Node 22 remains a
  *runtime* (Prisma engine spawn, Next helpers) but never installs or runs
  project scripts. `next build` / `next start` are proven to run under Bun,
  including server components, server actions, middleware and the PWA
  service worker (production smoke: 16/16; E2E: 77 passed under Bun).
  `typecheck` depends on `.next/types`, so a build precedes it on a clean
  tree.

## 20. Design system

`src/app/globals.css` is the single stylesheet and the only place a design
value is written down. It is organised as three layers, and the order is
load-bearing:

1. **Primitives** (`--p-*`) — raw ramps and scales with no meaning
   attached: neutral/accent/aurora/status color ramps, spacing, radius,
   type size/line-height/tracking triples, elevation, duration, easing,
   opacity, blur, layer numbers, control/icon/layout/artwork metrics.
2. **Semantic tokens** — role-based intent (`--canvas-*`, `--surface-*`,
   `--fg-*`, `--border-*`, `--accent*`, `--status-*`, `--aurora-*`,
   `--overlay-*`). These are the only tokens a component consumes.
3. **Component tokens** — bindings for surfaces that must diverge
   (`--player-*`, `--dialog-*`, `--track-row-*`, and the control/icon/
   layout/artwork metrics).

Rules the file depends on, each of them load-bearing rather than stylistic:

- A literal color, size, duration, radius, blur, or layer number appears
  **only** in a `--p-*` declaration. Primitives are prefixed precisely so a
  `@theme` entry can never accidentally reference itself: a self-referential
  custom property is invalid CSS and is dropped silently, which would make
  every consumer inherit instead.
- A component never references a `--p-*` ramp step directly. If a new role
  needs a new ramp stop, that stop is added deliberately and the role is
  added with it.
- Only the ramp stops the semantic layer actually consumes are
  instantiated. Ramp indices are canonical positions in an 11-stop
  (neutral) / 7-stop (accent) scale, not a dense sequence, so a stop means
  the same lightness regardless of which stops are currently in use.
- Scales that must become Tailwind utilities are published through the
  `@theme` namespaces Tailwind reads: `--color-*`, `--font-*`,
  `--radius-*`, `--shadow-*`, `--blur-*`, `--ease-*`, `--z-index-*`,
  `--spacing-*`, `--opacity-*`. `rounded-md`, `ease-enter`, `z-dialog`,
  and `gap-xl` are therefore real utilities, not hand-written CSS.
- **Named gradients are classes, not theme keys.** Tailwind 4.3.3 has no
  code path that turns a named gradient theme key into a `bg-gradient-*`
  utility — it only rewrites the `bg-gradient-to-*` direction prefix. The
  aurora blend is therefore the `.aurora-fill` class, which resolves to
  `var(--aurora-gradient)`. Verified against the real build pipeline: the
  previous `--gradient-aurora` theme entry generated nothing at all, and
  its two call sites rendered with no gradient, with no build error.
- **Motion is tokens plus two reduced-motion layers.** Durations and
  easings are primitives; decorative motion (press compression, hover lift,
  equalizer) is declared *inside* a `prefers-reduced-motion: no-preference`
  block so it is never parsed into the cascade when unwanted. A blanket
  `prefers-reduced-motion: reduce` net is retained for transitions declared
  anywhere else, including by dependencies. The net may only shorten motion:
  it must never touch `opacity`, `visibility`, `display`, or `transform`, or
  a user who asks for reduced motion would lose a control's visual state.
  Transitions are restricted to compositor-friendly properties
  (`transform`, `opacity`, color) so nothing can cost frames during playback.
- **The legacy alias block is a one-phase migration shim, not a second
  system.** Every entry in it is a bare `var()` alias of a semantic token —
  no entry redefines a literal — so the two systems cannot disagree even
  mid-migration. It exists so the pre-existing call sites keep resolving
  and is deleted in Phase 44d; a test fails if a shim name is still
  referenced once that deletion is due.

`src/app/__tests__/design-tokens.test.ts` enforces the above statically. It
parses the **comment-stripped** stylesheet, because the file documents its
own conventions and that prose contains backticked names — including a
literal `@theme` — which would otherwise be read as declarations. It asserts:
no self-referential property, no dangling `var()`, an alias-only shim, no
dead primitive, utility classes and components agreeing in both directions
(with any class lacking a call site named explicitly, so the debt cannot
outlive its justification), the reduced-motion paths, and the aurora-fill
constraint.

### 20.1 Shared control vocabulary (`src/components/ui/player-controls.tsx`)

Transport controls rendered in more than one surface get their cross-surface
facts from this one module, never from each surface's own markup. The rule is
the §2 single-authority rule applied to presentation: if two files can each
decide something, two files will eventually decide it differently.

| Export | Owns |
| --- | --- |
| `repeatDisplay(mode)` | repeat mode → localized label + icon selection |
| `nextRepeatMode(mode)` | the repeat cycle |
| `shuffleToggleClass(enabled)` | the shuffle button's press, transition and active ring |
| `shuffleIconClass(enabled)` | the shuffle glyph's active accent colour |
| `SHUFFLE_DISABLED_CLASS` | the unavailable treatment |
| `useShuffleControl()` | canonical state, availability, and the three labels |

- **The active treatment is split across two elements, and the split is
  load-bearing.** The ring (`ring-2 ring-accent/50`) goes on the **button**; the
  accent colour (`text-accent`) goes on the **icon**. A caller-added
  `text-accent` on a `Button variant="ghost"` does **not** win: the primitive
  already sets `text-text-secondary`, the two have equal specificity, and the
  winner is decided by stylesheet order rather than by the order of the class
  attribute. Measured in the running app, same origin and real stylesheet —
  colour on the button resolved the glyph to `lab(73.81 0.94 -3.65)`, i.e. still
  muted; colour on the icon resolved `lab(50.20 44.95 -67.73)`, the real accent.
  The wrong placement fails silently: no error, no warning, and the class is
  plainly present in the DOM. The icon has no competing colour rule and paints
  via `stroke="currentColor"`, so the icon is where the colour belongs.
- **The active state is a shape change as well as a colour change** — a ring,
  matching `AutoplayButton`. A hue alone is invisible in greyscale and unusable
  for a colour-blind listener, and the ring animates through
  `transition-[color,box-shadow]` (both compositor-safe, neither layout) so the
  button's box is identical in both states.
- **Availability is a real condition, not a precaution.** `QueueManager`
  randomises `playOrder`, so with an empty queue there is no order to
  randomise: `PlayerStore.toggleShuffle` returns early. The control therefore
  reports that state as `disabled` with a localized explanation rather than
  accepting a click that changes nothing. `useShuffleControl` subscribes to
  `playOrder` rather than `queue` for exactly the §3 reason — `queue` is
  reference-stable across a reorder, so a `queue`-only selector goes stale.
- **`aria-pressed` is kept while disabled.** A toggle that cannot currently be
  toggled is still a toggle; dropping the attribute would change the role a
  screen reader announces. The accessible name states the action and the
  tooltip states the state, the same split `AutoplayButton` uses.
- Surfaces own only what genuinely differs: the button box, the glyph size, and
  the inactive colour class. The mini player uses a raw `<button>` and the bar
  and full player use the `Button` primitive, because that is how each row's
  other controls are built; requiring those to match would mean restyling three
  unrelated rows.
- `TransportButtons` (this module) has no consumer and is kept because it is a
  reusable primitive, but it is held to the same contract via the same helpers
  plus an optional `canShuffle` prop, so re-adopting it cannot reintroduce
  drift.

## 21. Layer stack and presence

### 21.1 Layers are tokens, never numbers

`globals.css` publishes a complete, ordered stack as `--p-z-*` primitives
(`base 0`, `raised 10`, `sticky 20`, `rail 30`, `player 40`, `floating 50`,
`dropdown 60`, `popover 70`, `sheet 80`, `dialog 90`, `toast 100`) and maps
them into Tailwind's `--z-index-*` namespace, so `z-rail`, `z-dialog` and
`z-toast` are real utilities. Components consume only those names. A
hardcoded `z-[…]`/`z-50` is a static test failure
(`src/components/ui/__tests__/layering.test.ts`), because an ad-hoc number
is a claim about paint order that nothing reviews and nothing re-orders when
the stack grows.

The order is the contract, and it is asserted rather than described. Two
orderings are load-bearing enough to be pinned by name:

- **`z-dialog` > `z-sheet`.** The full player is a full-viewport takeover
  (`sheet`); the queue is a panel reachable *from inside* it. When both were
  `z-50`, `PlayerHost`'s render order put the queue before the full player,
  so on mobile the "Up next" button in the full player opened a panel that
  the full player immediately covered — the queue was unreachable at every
  width below `lg`.
- **`z-player` > `z-rail`.** The bottom navigation and the mini player are
  `fixed` siblings with no shared parent, so nothing but geometry and layer
  keeps them from overlapping.

Unexpected stacking contexts are treated as causes, not escalation points.
`transform`, `filter`, `backdrop-filter`, `opacity < 1`, `isolation`,
`contain` and `will-change` all create one, and a component that needs to
escape an `overflow-hidden` or a transformed ancestor portals instead of
climbing the z-index. Ordinary local overlays are never portalled.

### 21.2 Presence is one primitive

`src/components/ui/presence.tsx` is the single owner of "how an overlay
appears and disappears". Every animated surface uses it; a component must
not hand-roll a `setTimeout(() => setOpen(false))` or an `if (!open)
return null` guard, because both destroy the exit.

Its contract:

- **`usePresence(open)`** returns a `phase` of `entering | entered | exiting
  | unmounted`, plus derived `mounted`/`state` and a `presenceProps` object
  carrying the class, the `data-presence` attribute, and **`inert` while
  exiting**. `inert` lives in `presenceProps` deliberately: a new consumer
  cannot forget it, and an element that is on screen while it closes is
  correctly unreachable by pointer, Tab and the accessibility tree.
- **Unmount is timer-driven, not `animationend`-driven.** jsdom runs no
  animations, the blanket reduced-motion rule sets `animation-duration:
  0.01ms !important` (which would couple this component's lifecycle to
  another file), and a backgrounded tab can drop `animationend` entirely —
  any of which leaves a permanently invisible, still-mounted menu. The
  durations are therefore constants (`PRESENCE_ENTER_MS = 220`,
  `PRESENCE_EXIT_MS = 140`) that mirror `--p-duration-normal`/`-fast`, which
  avoids a `getComputedStyle` layout read and a stylesheet race.
- **Phase is one state, derived during render.** The effect body only arms
  and clears timers, so it never calls `setState` synchronously. The
  render-phase transition back to `entering` on a re-open is load-bearing
  twice over: a consumer effect keyed on `open` sees the real DOM (without it
  "move focus into the panel" silently no-ops), and an open → immediate
  close still arms an exit timer instead of snapping the element away.
- **Rapid toggling is a defined state, not a race.** open → close → open
  never duplicates an animation, never leaves a node stuck at `exiting`, and
  never leaves a mounted element that the caller believes is closed.
- **Reduced motion still cleans up.** Durations collapse to ~0 in CSS while
  the timers still fire, so the mount/unmount lifecycle is identical for
  every user; only the pixels differ.
- Motion is expressed as **keyframes**, not transitions, so a freshly
  mounted node animates from its initial state instead of relying on a class
  change to trigger anything. Four vocabularies exist and are named for
  their role: `backdrop` (opacity only), `pop` (scale 0.96 → 1), `sheet`
  (translateY 12px, never scale — a sheet that shrinks reads as a dialog),
  and `menu` (a small directional drift). Only `opacity` and `transform`
  animate, so no presence costs layout or paint.

### 21.3 Dialog owns the shared overlay duties

`ui/dialog.tsx` is the only shared overlay primitive. It layers presence, a
**refcounted** body-scroll lock that restores the pre-existing inline value
rather than clearing it, an `isConnected` guard before returning focus, and a
`relative` panel so that `DialogClose` — which is positioned `absolute` — is
correctly anchored by every consumer instead of by each consumer's own
wrapper.

### 21.4 A menu has to be able to leave its row

Four separate decisions decide whether an open menu is visible at all, and
`position: absolute` answers exactly one of them — it says where the box is
anchored, not whether the box survives the trip:

1. **Positioning context.** The trigger's own `relative` wrapper is the
   anchor: `TrackRow` / `ActionArea` → `relative` → trigger → menu
   `absolute right-0 top-full mt-1.5`. No distant ancestor and no app-root
   box is a positioning context, because a menu anchored to a box three
   levels up slides with *that* box rather than with the row the user
   clicked. Nothing is `fixed` for this purpose either: `fixed` on the queue's
   sheet would re-anchor to the viewport while `presence-sheet-in`'s
   `translateY(0)` still stands, which is both a containing block and a
   clipping box.
2. **Overflow.** Every ancestor between the surface and the page must be
   `overflow: visible`. A surface that needs a clip for its own artwork or
   rounded corners **splits its layers** instead of clipping its children: the
   outer box rounds itself with `rounded-2xl` and stays `visible`, the
   decorative child carries the gradient and the clip. `EntityHeader` and the
   search `TopResultCard` are both shaped this way now — each used to carry
   `overflow-hidden` on the menu's own host box, which cost 120px of a 162px
   menu on the search card. `overflow-hidden` is never removed globally; only
   the box that would cut a menu moves it.
3. **Stacking and layer.** `z-dropdown` only, never `z-[…]`. The audit for
   this is static (`ui/__tests__/layering.test.ts`) and behavioural
   (`e2e/layering-presence.spec.ts`); Aurora Glass creates no stacking
   context of its own that could trap a menu, and the app-shell root remains
   the only common ancestor that isolates.
4. **Direction.** `useMenuOpenUp` (`src/components/ui/menu-placement.ts`) is
   the single place a menu decides which way to open. It measures the trigger
   against the viewport and the **surface that is actually in the slot** —
   not a guessed menu height — and keeps `BOTTOM_CLEARANCE_PX = 120` of room
   for the player chrome (88px desktop bar, 112px phone mini player). It is
   decided in a `useLayoutEffect`, before paint, so the surface never appears
   on one side and then jumps; and it depends on its own inputs rather than
   its own output, so it cannot flip in a loop.
5. **The decision is watched, not taken once** (2026-09-27). Point 4 above was
   read as "measure once, on open", and a menu whose *content arrives after it
   opens* breaks that reading: the playlist picker mounts with a header and an
   empty list and then fills in, because the list is a server action. Measured
   in a real browser with the failing state built on purpose — ten playlists,
   the player bar mounted — the picker is **131px with one playlist and 316px
   with ten**, the row menu it replaced in the same slot is 202px, and the bar's
   top edge is 655px up a 720px viewport. A verdict computed against 131px says
   "there is room below"; by the time the tenth playlist lands the surface is
   185px taller and its lower items are under the player bar, where they are
   visible, unclickable, and block the add for exactly the users with the most
   playlists. So the surface's **size** is an input that invalidates the
   answer, and the rule watches it (`ResizeObserver`) and re-decides on a
   viewport `resize` (a rotation re-derives both numbers without resizing the
   menu). A flip moves a surface without resizing it, so watching its size
   cannot re-trigger itself. The two signals do not subsume each other:
   `placementKey` covers a host swapping a *different* surface into the same
   slot (the queue panel's `showPlaylistMenu ? "playlist" : "actions"` is the
   worked example), and the size signal covers one surface growing where it
   stands. Both are asserted in `ui/__tests__/menu-placement.test.tsx`.

**Where the queue is different, and why it portals.** The queue's list is a
scroll container, and a scroll container clips: the list is 419px tall and a
row menu is ~200px, so a row anywhere near the middle has less room on one
side than the menu needs. Flipping therefore cannot guarantee the menu
survives, and layer separation inside the row cannot either — the clip comes
from an ancestor the row lives in. The panel consequently publishes a **menu
layer** as its last child (`pointer-events-none absolute inset-0 z-dropdown`,
deliberately *not* `aria-hidden`, because hiding the container would hide
every menu item from assistive technology) and `QueueItemMenu` renders its
surface there, positioned by computed `top`/`bottom`/`right` against the
layer. This keeps the surface inside the dialog — inside its focus trap and
its stacking context — while taking it out of the scroller; a body-level
`z-dropdown` portal would have landed behind the `z-dialog` panel. The
`relative` wrapper around the trigger stays: it is still the trigger's
positioning context and still half of the outside-click test.

**And why it closes on scroll.** A surface positioned from a row inside a
scroller is stale the moment that scroller moves; left alone it floats over
rows it no longer belongs to. So the panel closes the menu on the scroller's
`scroll` — registered in the capture phase, because a scroll event does not
bubble — and on `resize`. This is the **one** scroll listener a component may
register, recorded as a counted exception in
`src/app/__tests__/scrollbar.test.ts`, and the distinction the rule exists to
protect still holds: it registers only while the menu is open, removes itself
when it closes, and measures nothing and re-renders nothing per frame.

**Dismissal is scoped to the dialog that hosts the trigger.** "Outside" means
outside *this* trigger's dialog, not outside any dialog. The queue panel is
itself a dialog, so the older rule — exempt every `[role="dialog"]` — made
every click inside the panel exempt and left the row menu with no way to be
dismissed but Escape. The portaled create-playlist dialog, a *different*
dialog, remains exempt exactly as intended.

Asserted at three levels: the rule by unit test
(`ui/__tests__/menu-placement.test.tsx`), the class-level "this box does not
clip a menu" claim by `ui/__tests__/menu-clipping.test.ts`, and the resolved
geometry — no clipping ancestor, nothing outside the viewport, every
non-disabled item the topmost thing at its own centre — by
`e2e/menu-clipping.spec.ts` in a real browser at desktop and phone widths.

## 22. Testability

- **Deterministic unit tests** (`vitest.config.mts`): `src/**/*.test.ts(x)`,
  DB/live suites excluded, Node env.
- **DB tests** (`vitest.db.config.mts` + `scripts/db-test-env.ts`): only
  `*.db.test.ts`, no file parallelism, Postgres service.
- **Playwright** (`playwright.config.ts`, `e2e/`): Chromium; app-shell,
  acceptance, keyboard, error-recovery, PWA, authenticated library/playlist/
  session (setup/teardown harness), E2E-only routes (`e2e-playback`,
  `e2e-library`) gated out of production.
- **Phone projects** (`mobile-chromium`, `mobile-landscape`): a Pixel 7
  portrait profile and a rotated iPhone 15 Pro Max, both `testMatch`-scoped to
  `e2e/mobile-layout.spec.ts`. The scoping is deliberate: a project-level
  device applies to every spec that runs in it, and the desktop specs measure
  desktop layout bands where a 412px frame is the opposite of the point, so
  re-pointing them would change what they test without changing what they
  claim to test. Two profiles rather than one because the two phone
  constraints are different and neither covers the other — portrait is a width
  constraint, landscape is a height constraint.
- **A project's `use` block does not reach a hand-built context.** The auth
  fixtures call `browser.newContext()` themselves to attach per-role storage
  state, so a device descriptor declared on a project is dropped for those
  pages. `e2e/auth/fixtures.ts` therefore re-applies the profile by project
  name (`deviceForProject`), and `mobileAuthTest` exposes it as a separate
  `phoneA` fixture rather than changing `pageA` for every existing spec.
  Without this, `(hover: none) and (pointer: coarse)` does not match, `.aurora-touch`
  correctly does nothing, and every 44px assertion passes vacuously — which
  is why the phone suite asserts the media query matches before relying on it.
- **Geometry is measured after animations settle.** `presence-pop-in` starts
  at `transform: scale(0.96)`, so a 44px control measured on the first frame
  of an opening dialog is 42px. The phone suite waits for finite animations
  to finish before reading a box, and excludes infinite ones (the equaliser
  bars and the aurora drift loop forever, so "nothing is animating" never
  becomes true on a page that is playing anything).
- **The tampered-session fixture must actually be tampered.** `tamperToken`
  changes the first character of the token's last segment, not the last
  character: base64url cannot represent every byte pattern, so a final
  character whose significant bits match the replacement's decodes to the same
  bytes and leaves the token valid. Measured over 2000 tokens against the real
  `@auth/core/jwt` `decode()`, the last-character mutation produced an
  accepted token 134 times. next-auth encodes a JWE, so the segment carrying
  the integrity guarantee is the last of five; the helper handles three and
  five segments and refuses anything else rather than inventing a fixture.
- **Live playback gating** (`vitest.live.config.mts`): only
  `*.live.spec.ts`, 60s timeouts, self-skip without
  `AURORA_E2E_LIVE_PLAYBACK=1` — out of CI by default.
- **Test auth harness** (`e2e/auth/*`): DB-backed fixtures, prepare/clean/
  read scripts, isolated from production auth.
- **`smoke:prod`**, **client-bundle scanner**, **dependency audit
  baseline/gate**, **migration allowlist test**, **quality/security gates**
  (Phase 24/26) complete the contract. No suite output is copied here.
- **A gate walks this source tree, not the working directory.** The Bun rule
  scans `""`, `docs`, `src`, `scripts`, `e2e` and `.github`, and skips
  dot-directories — `.github` is reached *as a named root*, which is the only way
  the rule admits a dot-directory, so naming one is a deliberate act rather than
  an accident. This is not tidiness: a nested agent worktree inside the
  repository contains this very gate's subject matter in an older revision, and
  walking into one makes the rule assert against a checkout that is not the one
  under test. A gate that fires on a neighbouring copy of the repository is a
  gate that gets disabled.

## 23. What is not guaranteed

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

## 24. Request guards (Phase 52)

### 24.1 One guard, one place

`guardServerAction` in `src/lib/api/action-guard.ts` is the single entry
point every guarded server action goes through. It performs, in this order:

1. **Feature flag.** Checked FIRST, before the rate limit. A feature switched
   off spends no rate-limit budget, so turning a feature off under load cannot
   itself be the thing that gets a user throttled, and a disabled feature
   returns `FEATURE_DISABLED` (503, retryable) rather than a rate-limit error
   that would suggest "try again sooner" and invite a retry loop.
2. **Rate limit.** See 24.2.
3. **Nothing else.** Authentication and ownership are the action's own job. The
   guard deliberately does not know about playlists, tracks or users, because
   the moment it does it becomes a second place to get authorization wrong.

A guard failure is returned, never thrown, as a `GuardFailure`. Throwing from
a guard would make "this action is disabled" and "this action crashed"
indistinguishable at the call site, and only one of them is the caller's fault.

`quality-gates.test.ts` fails the build if a `"use client"` component imports
the guard or either rate-limit module. A rate limit enforced in the browser is
not a rate limit, because the caller controls the browser.

### 24.2 Rate limiting

`src/lib/http/rate-limit.ts` is a dependency-free fixed-window limiter.

- **Policy is data.** Buckets live in `RATE_LIMIT_BUCKETS` with a name, a
  limit and a window. The name is a wire value: it reaches a log record and an
  error `scope`, so it is a dotted lowercase token.
- **Identity is `user:<id>` when authenticated, else `anon:<hash>`.** The
  anonymous key is `sha256(ip + user-agent)` truncated to 16 hex characters -
  a hash, never the raw address, so the limiter's own state is not a log of
  visitors' IPs. There is no browser-storage key: the gate that keeps
  `localStorage`/`sessionStorage`/`indexedDB` out of production source
  applies here too, and a client-supplied key is trivially forged anyway.
- **Memory is bounded.** The map is capped at `DEFAULT_MAX_KEYS` (10,000).
  Eviction prefers expired windows, then oldest insertion. A flood of
  single-request identities therefore costs a bounded amount of memory instead
  of growing without limit.
- **A denied request does not extend its own window.** Otherwise a client
  hammering a locked-out bucket would hold the lockout open indefinitely, and
  "back off" would become "hammer harder".

**Known limitation, deliberately accepted:** this is in-process. Behind more
than one instance, each instance enforces the limit independently, so the
effective limit is `limit x instances`. A shared store (Redis) or an edge
limiter is the fix, and it is recorded in `docs/scope-boundaries.md` as a
deferral rather than silently pretended away. The alternative - shipping no
limiter until a shared store exists - leaves a provider quota one tab away from
being exhausted.

### 24.3 What is NOT rate limited

Reads that are cheap and cacheable are not behind a bucket, because a limit
there buys nothing and costs a page a broken control. The guarded set is the
expensive, state-changing, or provider-touching set: radio start/extend, unified
search, playback resolve, recommendations, playlist mutation, sharing, and
playback recording. The infinite-listening **write** passes the same guard for
its feature gate but carries no bucket (it is a preference toggle), and the
infinite-listening **read** is deliberately unguarded: one indexed row read
that degrades to `enabled: false` rather than failing, so a bucket there would
break a control for nothing — which is the rule stated above.

## 25. Client-facing API contract (Phase 52)

### 25.1 There is no REST API to version

The HTTP surface is three routes: `/api/health`, `/api/app-config`, and
`/api/auth/[...nextauth]`. Everything else is React Server Components and
server actions. There is deliberately **no `/api/v1` prefix**: adding one
would be a migration for no client, and would make the public URLs worse.

`API_CONTRACT_VERSION = "v1"` in `src/lib/api/contract-version.ts` and
`apiVersion: 1` in the app-config body are the two version markers that do
exist. They are deliberately separate values with separate meanings - the
transport envelope version and the app-config shape version - so that bumping
one does not silently invalidate a client pinned to the other.

### 25.2 The error envelope

`src/lib/api/error-codes.ts` holds a CLOSED set of client-facing codes. Each
has an HTTP status and a `retryable` flag. Closed means closed: a new code is a
deliberate act with a documented meaning, not something an action invents at its
call site and the client then has to string-match.

`classifyError` maps the internal error hierarchy onto it. `INTERNAL_ERROR`
always receives a fixed generic message and the caller's own detail is dropped -
an unexpected exception is the one case where the internal text is most likely
to contain a query, a path, or an identifier, and the one case where the client
least needs it. `requestId` on the body is the only way to correlate.

### 25.3 Correlation ids

Every response carries `x-aurora-request-id`. The id is either freshly
generated with `crypto.randomUUID()` or an inbound `x-request-id` that passed
a strict 8-64 character `[A-Za-z0-9._-]` allowlist. A hostile inbound value is
**replaced, not sanitized** - "sanitizing" a value containing a newline is how
log-injection bugs get written. A request id is a label, not an identity: it
authorizes nothing and is never persisted.

`jsonResponse` in `src/lib/api/transport.ts` is the only sanctioned way to
build a response, and a route that constructs its own is a gate failure. The
correlation id rides in a **header**, not in the body, precisely because
`/api/health` and `/api/app-config` have published body shapes that a load
balancer and a wrapper may both be diffing.

## 26. Multi-tab playback ownership (Phase 52)

### 26.1 The policy, in full

**Ownership is shared. Content is not.**

One tab at a time is allowed to be audible. Two tabs have two independent
queues, two independent sessions, and no attempt to merge them. Merging queues
would make "add to queue" mean something different depending on which tab you
were looking at, and would fight the per-tab session persistence that already
exists.

### 26.2 Why queue isolation is the honest answer

The alternative - synchronizing the queue across tabs - is the feature users
sometimes expect and it is the wrong one here. It requires a canonical queue
owner, a durable shared store, and conflict resolution for concurrent edits,
which is a distributed-systems problem bought in exchange for a behaviour the
user can already get by using one tab. Documenting isolation is honest;
implementing a half-correct merge would not be.

### 26.3 The protocol

`src/lib/multi-tab/playback-ownership.ts` is a pure machine with no browser
API in it, which is why 19 tests can drive it directly.
`ownership-transport.ts` moves messages over `BroadcastChannel`; that file
owns nothing else.

- **Claims are totally ordered by `(epoch, tabId)`.** Higher epoch wins;
  equal epochs break on the lexicographically smaller tab id. Both tabs compute
  the same answer from the same inputs, which is what makes a split brain
  impossible rather than merely unlikely.
- **`takeover` is unconditional.** It is the user pressing "play here", and
  user intent outranks a protocol.
- **`release` carries no epoch.** Sending one would let a late release lower a
  shared counter and let a stale heartbeat resurrect an old claim. "The tab
  with this id is no longer playing" is the whole fact.
- **Validation is strict and total.** Every field is checked, not just the
  discriminant. A `BroadcastChannel` is reachable by any script on the origin,
  so it is the project's only real trust boundary in the browser: an unvalidated
  `epoch: "1"` would reach `Math.max`, produce `NaN`, and make every later
  claim compare against `NaN` - a split brain produced by a type coercion.
- **A backgrounded tab is not a dead tab.** Chrome throttles timers in hidden
  tabs, so the lease (5s) is deliberately much longer than the heartbeat (1.5s)
  and the heartbeat stops while hidden rather than firing into a frozen loop.
- **Yielding is advisory, not coercive.** A tab that hears a newer claim pauses
  itself through the store's own `pause()`. It is not commanded from another
  tab, because the store is the only playback authority and a second writer
  would violate RULE 4.
- **A lapsed lease returns the tab to `idle`, not `contender`.** "Contender
  with no owner" is a state that asserts a rival exists.
- **No storage-event fallback.** Where `BroadcastChannel` is missing, the
  transport does nothing at all. A fallback would need a shared key and would
  make the ownership decision depend on storage quota and eviction, which is a
  much larger failure surface than "coordination is off in this browser".

### 26.4 Who owns the persisted session

Queue isolation in memory does not extend to storage on its own, and the gap is
worth stating because it is not obvious. `PlaybackState` is one row per **user**
(`userId @unique`), not per tab, so every tab of a signed-in user writes the same
row. The server-side revision CAS stops two writes landing at the same instant,
but it is not a recency rule: a background tab that changes its queue, re-syncs
its revision after a `stale` rejection, and writes again will win the next CAS
and overwrite the session the user is actually listening to. Phase 52 named this
in the machine's own header and closed only the audio half of it.

**A tab that has yielded to a live foreign owner does not persist.** The same
ownership machine that decides who is audible also decides who owns the persisted
session, so there is still exactly one authority for "which tab is the live
listening session" - no second coordinator, no second queue, no second player.

- The condition is `isForeignLiveOwner`: `role === "contender" && ownerAlive`.
  It is deliberately **not** "am I the owner" - requiring ownership would silence
  persistence in every tab the moment playback paused, because a paused tab has
  released its claim and then nobody would persist anything.
- `ownerAlive` is load-bearing. A crashed or closed tab must stop suppressing
  writes within one heartbeat (1.5s), or a dead tab would freeze the session.
  Liveness is re-derived by `tick()`, not on every `getSnapshot()` read; the
  transport ticks every heartbeat, which bounds the delay.
- Suppression is **not** a queue. A withheld change is not held for replay: it is
  written by this tab's next change, or by the periodic checkpoint, as soon as
  this tab is the live one again. Deferring would mean replaying a snapshot
  nobody asked for, which is the stale-overwrite behaviour being prevented.
- Restore is never gated. Reading the row is side-effect-free, and the opening
  tab must restore regardless of who currently owns playback.
- With no machine mounted - server render, a test that never mounts the host, or
  a browser without `BroadcastChannel` - there is no foreign owner and
  persistence behaves exactly as before. That is the single-tab case.

Wiring: `src/lib/multi-tab/instance.ts` holds the mounted machine (the same
lifecycle-holder pattern as the MusicEngine, radio session and continuation
coordinator); `PlaybackOwnershipHost` registers it for exactly its mounted
lifetime; `PlayerHost` passes `shouldPersistSession` to the persistence
controller, which checks it at every write site *and* inside both write methods,
so a debounce or a `pagehide` flush that fires after this tab yielded cannot slip
through.

## 27. Feature flags and kill switches (Phase 52)

`src/lib/feature-flags.ts` is a registry, not a scattering of
`process.env` reads. Every flag declares a name, a compiled default, an owner, a
description and a risk rating, and `phase52-contract.test.ts` fails if any
declaration is incomplete or if a flag names a feature that does not exist.

One variable, `AURORA_FEATURE_FLAGS`, carries comma-separated `name=value`
overrides. Parsing never throws: a typo in a kill switch must not stop the
process from serving traffic. Unrecognised entries are collected into
`unknownNames` and `malformed` and otherwise ignored, and the distinction is
kept because `radio=maybe` and `radio` are different mistakes and the
offending value is the useful half of the diagnostic.

Every flag is a **server-side** kill switch. A client-side flag can be bypassed
by anyone who opens devtools, so a flag that gates money, quota or privacy
cannot be one.

## 28. Performance budgets (Phase 52)

`verify:client-bundle` grew from a secret-leak scan into a size gate. Budgets
are in **gzipped** bytes, because raw size tracks minifier settings and chunk
counts while gzip is what crosses the network - and Next serves Brotli in
production, which is uniformly smaller, so the ceiling is the pessimistic
measurement by design.

| Budget | Measured | Ceiling |
| --- | --- | --- |
| Total client JavaScript | 304.9 KiB | 400 KiB |
| Largest single JS chunk | 71.6 KiB | 100 KiB |
| Total client CSS | 12.2 KiB | 20 KiB |

The largest-chunk budget is the one that earns its keep: total size can stay
flat while a single chunk doubles, which is exactly the change that turns a cold
start into a blank screen on a mid-range phone.

Every threshold is a measured value plus roughly a quarter of headroom, not a
round number someone liked. Re-baselining is a deliberate, visible act -
`AURORA_RECORD_BUDGETS=1 bun run verify:client-bundle` prints the numbers and
never writes them. A budget that the change it is meant to catch can raise is
not a budget.

## 29. Backup, restore and data integrity (Phase 52)

`db:integrity` (`scripts/verify-data-integrity.mts`) is read-only and
argument-free, which is what lets it be pointed at a restored copy. It checks:

- **Orphans** on 14 parent links. A row whose parent is missing is invisible to
  every query that joins, so the product silently loses it.
- **Required unique indexes exist AND are unique**, verified against
  `pg_index` by name *and* by actual key columns. Note the catalog choice:
  Prisma emits `CREATE UNIQUE INDEX`, which in PostgreSQL does **not**
  register a `pg_constraint` row - querying `pg_constraint` finds only the
  primary keys and reports every one of these as missing. That is a real trap
  this script already fell into once.
- **Uniqueness also holds in the data**, not only in the schema. A unique index
  can exist and still have duplicates if it was added after bad data with the
  migration's validation skipped.
- **Required NOT NULL columns really are NOT NULL.**
- **Playlist positions are contiguous from 0.** A gap hides a track from the UI
  with no error, because the list is rendered by position.
- **Every user-scoped row resolves to a real user.** This is the cross-user
  access boundary expressed as data.
- **Migration history is complete**, with no failed or unfinished migration.

`db:restore-drill` (`scripts/verify-restore.mts`) is the thing that makes a
backup a fact rather than a hypothesis: it creates a throwaway database,
`pg_dump`s the source, restores into the throwaway, runs the full integrity
verification **against the restored copy**, compares row counts across 13
tables, and drops the target in a `finally`.

Its guards are explicit because restoring a database is one of the few genuinely
destructive things in this repository: it refuses to start without
`AURORA_RESTORE_DRILL=1`, refuses if the target name equals the source name
(this is the check that matters most, and it runs before anything is created),
requires a plain lowercase name, and always drops what it created. It is not
wired into the default pipeline.

Row counts are compared as well as integrity, because integrity verification
proves the restored database is *internally consistent* and cannot prove
anything is still *there*: a dump that silently skipped a table would pass every
integrity check and lose the data.

## 30. Text selection policy (Phase 51 addendum)

**Content the user came to read stays selectable. Chrome the user might
accidentally drag past stays unselectable.**

Content means track titles, artist and album names, playlist names and
descriptions, error messages, share URLs, ids - anything whose text is the
product, because users select those to search them, paste them, or send them in
a bug report. Chrome means transport buttons, seek and volume sliders, drag
handles, nav links, and icons.

There is deliberately **no `*`, `body` or `:root` `user-select` rule**.
`quality-gates.test.ts` fails the build if one appears, because the blanket
version makes every piece of content uncopyable and the damage is invisible in
a screenshot - a selection that never happens draws nothing.

Where the rules live:

- `ui/button.tsx` already carries `select-none`, which is why the bulk of the
  control surface needs no per-component rule.
- `ui/icons.tsx` `base()` sets `userSelect` and `pointerEvents` through
  `style` on every icon. Through `style`, not as bare attributes: React does
  not recognise `userSelect` as a DOM prop, warns once, and DROPS it - so the
  attribute form is silently a no-op. The regression test caught exactly that.
- `globals.css` states `input, textarea, [contenteditable="true"] { user-select:
  text }` as a low-specificity DEFAULT. The real guarantee that no field is ever
  made unselectable is a test, not that rule, because Tailwind's `select-none`
  outranks it.
- `src/components/__tests__/text-selection.test.tsx` asserts both directions:
  content elements are not inside a `select-none` container, and the named
  interaction surfaces are.

## 31. Queue reorder concurrency (Phase 52 - documented, not changed)

`reorderPlaylist` in the DAL is **last-write-wins**: it validates that the
submitted set of track ids exactly matches the playlist's membership, then
writes the new positions inside a transaction.

This is safe against corruption and unsafe against surprise. A user reordering on
a phone and a laptop at the same instant will see one of the two orderings, with
no error and no conflict prompt. The honest fix is an optimistic-concurrency
revision column on `Playlist`, which is a schema migration plus a client that
sends and reconciles a revision.

It was not done here because it changes the wire shape of an existing action for
a rare race, and a migration is the one change in this phase that cannot be
reverted by deleting a file. It is recorded in `docs/scope-boundaries.md`
rather than left as an undocumented gap.

## 32. Aurora Glass and appearance (Phase 53)

### 32.1 One authority, and what it is allowed to touch

`src/lib/appearance/appearance.ts` is the only module that decides what an
appearance **is**: the shape, the eight ranges, the four presets, the defaults,
and the wire format. `src/components/appearance/appearance-root.tsx` is the only
client authority that decides what an appearance **does** to the document.

Neither imports anything from `src/lib/player`, `src/lib/music` or
`src/lib/playback`. That is the whole of the "appearance changes cannot affect
playback" claim, and it is asserted structurally in
`src/quality-gates.test.ts` rather than behaviourally, because by the time a
test can observe the engine an import has already been permitted.

Glass settings are deliberately **not** part of the playback session snapshot
(§26.4). They are a rendering preference of one browser, not a fact about what
is playing, and a restored session has no reason to inherit them.

### 32.2 The eight primitives, four derived values, and one ladder

Eight `--p-appearance-*` primitives are written by the sliders. Four more are
derived in CSS, not by the client:

| Token | Meaning |
| --- | --- |
| `--p-appearance-alpha` | base glass surface opacity |
| `--p-appearance-blur` | backdrop blur radius |
| `--p-appearance-saturation` | backdrop vibrancy multiplier |
| `--p-appearance-border` | drives every border alpha |
| `--p-appearance-aurora` | ambient glow intensity |
| `--p-appearance-dim` | scrim over the background image |
| `--p-appearance-bg-saturation` | background image saturation |
| `--p-appearance-bg-blur` | background image blur |
| `--p-appearance-chrome-lift` | **constant** additive delta for chrome surfaces |
| `--p-appearance-float-lift` | **constant** additive delta for floating surfaces |
| `--p-appearance-scrim-floor` | the contrast floor under a background image |
| `--p-z-backdrop` | `-1`, so the backdrop sits below in-flow content |

The two lifts are constants on purpose, and the three alphas are
`min(96%, (alpha + lift) * 100%)`. A small, dense, high-contrast surface needs
a firmer backdrop than a large, sparse one, so a header and a dialog cannot
share a value even when the user has picked one — bigger surface, more opaque,
which is the opposite of raw glassmorphism. The `min()` is not decoration:
`color-mix()` with a percentage over 100% is invalid, so a slider at its maximum
without a ceiling produces a declaration the browser drops and the surface goes
silently transparent.

`design-tokens.test.ts` asserts the ladder's ordering at every point on the
slider, and asserts that every stylesheet default equals the model's default —
the two authorities agreeing is the thing most likely to rot silently.

### 32.3 Four classes, and the hierarchy they encode

| Class | Job | Applied to |
| --- | --- | --- |
| `.aurora-glass` | chrome | header, sidebar, player, mini-player, app shell |
| `.aurora-glass-float` | floating surfaces | dialogs, queue panel, menus, locale switcher |
| `.aurora-glass-nested` | controls on a surface | radio groups, switches, preset buttons, sliders |
| `.aurora-glass-edge` | border only | cards, rows, list sections, banners |

Every one is scoped to `[data-aurora-glass="on"]`. With the attribute `off`, no
glass rule is in the cascade at all rather than resolving to values that
resemble the old ones — which is what makes OFF *provably* the pre-Phase-53
rendering rather than approximately it.

Two prohibitions are enforced by test, not by convention:

- **No nested `backdrop-filter`.** A control on a blurred surface gets a tint and
  a border, never a filter of its own. Two stacked backdrop roots force the
  browser to snapshot and re-blur the same pixels, and a control that looks less
  like glass than the surface around it is worse than no glass.
- **No `backdrop-filter` in any component.** `backdrop-filter` appears in
  `globals.css` and nowhere else; components reach glass only through the four
  classes. Otherwise there is no longer a single blur radius and no way to
  answer "how expensive is this page" without reading every file on it.

### 32.4 Three switches, and what "off" costs

- `data-aurora-glass="off"` — Glass Mode off.
- `data-aurora-blur="off"` — the user's blur is 0, and the `backdrop-filter`
  declarations are **removed** rather than set to `blur(0px)`, which still
  promotes the element and still costs a backdrop copy per frame. This is the
  mechanism behind the Minimal preset being the performance escape hatch.
- `@supports not (backdrop-filter…)` — the surfaces become **opaque**
  `--surface-*`, not translucent-without-blur. A semi-transparent panel with no
  blur behind it loses the legibility the blur was providing, and text on a
  photograph is exactly the case the scrim exists for.

There is no hardware-based downgrade. `docs/scope-boundaries.md` excludes device
fingerprinting, so a low-cost mode is an explicit user choice.

### 32.5 No flash, by construction

The four `data-aurora-*` attributes and the eight custom properties are
computed **during render** from the draft and written onto the shell root, so
they are in the server-rendered markup. A theme applied in an effect is the
default theme for one frame, which is a visible flash on every navigation and on
every appearance change. There is no effect that applies the theme, nothing to
run before paint, and nothing that can get out of step with the state.

### 32.6 The background, in four layers

`AuroraBackdrop` renders three inert children inside one `position: fixed`
container, front to back: image, ambient, scrim. Split into three elements
rather than three `background-image` entries so each can be `display: none`
independently — "two fully transparent gradients" is not the same as none.

The container is `position: fixed`, so it does not move when the document
scrolls and **no scroll listener exists anywhere** that could make it. It is
`aria-hidden` and `pointer-events: none`: decoration that happens to be
full-viewport has to be invisible to assistive technology and to the pointer, not
merely usually so.

`--p-z-backdrop: -1` plus `isolate` on the shell root keeps the backdrop behind
in-flow content, which is what lets the shell root stay transparent instead of
painting an opaque canvas over its own decoration.

### 32.7 The persistence path, and its two sinks

Resolution order is account → cookie → default, React-cached per request, the
same order `i18n/server.ts` uses for locale. A stored account preference is
never overwritten by a cookie.

A signed-in visitor with a **null** column falls through to the cookie, which is
what lets a choice made before signing in survive the way in; the null column is
then what lets it be adopted on their next change rather than silently at
sign-in. A stored preference wins, so a change made on another device is not
reverted by a stale cookie.

`decodeAppearance` is **total and per-field**: unknown keys are dropped, only
`v` is a hard gate, and one bad value costs that control rather than the whole
preference. Every read in `getRequestAppearance` is wrapped, because it runs in
the root layout of every authenticated route and an appearance preference is not
allowed to be the reason a page does not render.

The stored document **omits every field equal to the default**, so an untouched
visitor is worth `{"v":1}` — about twelve bytes on a cookie attached to every
same-origin request. Both sinks receive the same `encodeAppearance` output, so
they cannot disagree; `appearance-root.test.ts` asserts the byte size and the
round trip.

**The wire document is a TYPE, not a runtime schema.** `AppearanceWire` is
`{ v?: number } & Partial<Appearance>` — derived from the model, so the writer
and the reader cannot disagree about which fields exist, and checked by the
compiler at every call site. An earlier revision declared a `zod` object for it
and nothing ever parsed with it (`decodeAppearance` is per-field by design, so
all-or-nothing parsing was the wrong failure mode for a preference anyway), and
importing `zod` into this client-reachable module put the whole library into the
client bundle: **407.0 KiB against a 400 KiB budget, +33.5% over baseline.** With
the declaration expressed as a type the bundle is 318.8 KiB, +4.6%. A validator
nobody calls is a validator that will drift out of date and then be trusted.

**The cookie is written immediately; only the server action is debounced.** A
cookie write is a synchronous string assignment and is the *only* sink for a
signed-out visitor, so debouncing it would open a window in which a user changes
the glass and closes the tab, losing the change. The network round trip is what
must not happen once per slider tick. A signed-in visitor's cookie is written by
the action instead, so the account and the cookie values come from the same
encoder in the same call.

**Reset writes the default to both sinks** rather than deleting the column. A
deleted preference would immediately fall back to a cookie still holding the old
choice, so the reset would visibly undo itself on the next request.

### 32.8 Background image validation

Four stages, in order, and each one is a rejection reason rather than a crash:
syntax (https only, no credentials, length), transfer size and format sniffed
from **magic bytes** rather than from the extension or the `Content-Type`, a real
`decode()`, and then dimensions. The byte cap is 4 MiB and the pixel cap is
16 MP — 8 MP refused a 4K 3840×2160 image, which is an ordinary photograph.

A host that will not cooperate over CORS is **not** a rejection: the image is
loaded through an `HTMLImageElement` and `decode()`d instead, which needs no CORS
because nothing is read back out of it. Refusing there would reject a large
number of ordinary image hosts for a reason the user cannot act on.

Nothing is stored that has not been checked, and the value stored is the
**trimmed address that was validated**, not the raw text that was typed. Custom
backgrounds are an https URL and hand-authored SVG presets; there is no upload
(see `docs/scope-boundaries.md`).

**`checkBackgroundUrl` lives in `appearance.ts`, not here**, and both reasons
point the same way. The decoder needs it: a cookie is a string anybody can set, so
what comes back out of `decodeAppearance` is put through the same check the
settings form uses — with the `zod` schema that previously sat in its place, a
stored `http://` address was structurally legal and would have been painted. And
the panel needs it: one authority decides what a legal background address is,
rather than a validator here and a decoder there that could disagree about what
https means. It stays re-exported from this module so the validation vocabulary
stays importable from the one place that documents all four stages, and
`background-image.ts` is strictly a *supplement*: it adds the three stages that
need a network and a `DOM`.

### 32.8a Safety and honesty are different jobs, so the action reads the request raw

`decodeAppearance` turns untrusted data into something safe to render, and
quietly replacing an illegal address with "no background" is exactly right for
that. It is **wrong for a request**: the user pasted something, it was refused,
and normalising it before the check would report success for a setting that was
never applied — a saved-looking empty canvas with no explanation.

So `setAppearanceAction` reads the requested address **raw**, before decoding, and
rejects it with a reason. Decoding happens afterwards, and the decoder's own
re-check of the same address is what makes the stored value safe regardless of
who wrote it. The two are not redundant: the action is the *honesty* path and the
decoder is the *safety* path, and collapsing them is what would have produced the
silent failure.

### 32.9 Artwork-reactive ambience, and its limits

Mounted only when `artworkAmbient` is on, so an opted-out application never
subscribes to the engine at all — not subscribing is strictly cheaper than
subscribing and returning early.

It writes five custom properties on `document.documentElement` and **not into
React state**: the properties are read by one decorative layer, and pushing them
through state would re-render the entire shell on every track change for a
two-pixel gradient. Custom properties on `:root` are read by descendants without
invalidating anything React knows about. Because React did not put them there,
React will not remove them either, so there is an explicit unmount cleanup.

Only colours are written — no layout property — so nothing reflows and no scroll
position moves. The analysis is deferred to an idle callback, because a frame
spent decoding artwork during a track change is a frame the audio pipeline did
not get. The palette is memoised by artwork URL in a bounded cache, and the
colour maths is a **restraint window** (hue remapped into 170–340°, chroma
scaled then capped at 0.12, lightness clamped to 0.45–0.72) rather than a
faithful reproduction of the cover.

The window is `[170, 340)` — half-open, because the remap is a modulo over a
span of `MAX - MIN`. 340 and 339.9 are the same colour, so nothing is lost; the
bound is exclusive so a reader is not surprised by a hue of 170 in a test, and
the property is asserted.

### 32.10 What the accessibility position is

- Every control is a native element where one exists: `input[type=range]`,
  `button[role=switch]`, a real `radiogroup` with a roving tabindex. Keyboard
  stepping, Home/End and the `slider` role come from the platform.
- State is never colour-only. The switch spells On/Off; the selected preset
  carries `aria-checked` **and** a check glyph; every slider has an
  `aria-valuetext` with its range, because "0.62" is meaningless spoken aloud.
- Error messages travel as i18n **keys** and are translated at the render. Both
  branches of the background error are keys and both go through `t()` — this was
  a real defect, found by a test that read the rendered string.
- `prefers-reduced-motion` is honoured; the ambient drift keyframes live inside
  the existing `no-preference` block.
- **An accessible name is unique on a screen.** Two controls answering to the
  same name are indistinguishable to a screen-reader user and ambiguous to any
  role-based query, so a repeated *action* is fine but a repeated *name* is not:
  the library's section-header "Create playlist" and the empty-state CTA both
  exist, and the header one is named after the section it acts on
  (`library.createPlaylistInSection` → "Create playlist in Playlists"). The same
  rule applies to per-row action labels, which are scoped by the region they
  belong to rather than being globally unique — a track row and the player bar
  legitimately both say "Actions for <track>".
- **Headings do not skip a level, and an empty state says which level it is.**
  A skipped level breaks the outline a screen-reader user navigates by, and an
  empty state's title is `h3` inside a section that already has a heading and
  `h2` when the empty state *is* the section — so `EmptyState` takes
  `headingLevel` (`2 | 3`, default `3`) and the home page's three top-level
  states pass `2`. Measured 2026-09-27 with a Lighthouse `heading-order`
  failure: the home page read `h1` then `h3` with nothing between.
- **The accessible name contains the visible text** (WCAG 2.5.3, Label in
  Name), so a voice-control user can say what is on screen and get it. This is
  a DOM-text rule, not a visual one: the brand wordmark is two sibling spans
  rendered as "Aurora" over "Music", and with nothing between them the element's
  text content was the single word "AuroraMusic" — not inside the name "Aurora
  Music home", which Lighthouse's `label-content-name-mismatch` reported. A
  whitespace-only run fixes it and is not rendered as a flex item, so it costs
  the layout nothing.
- **Known and open:** the header's primary sign-in control is
  `accent-foreground` on `--accent` (`#f5f5f8` on `#8d5bed`) at 14px, measured
  at **3.97:1** where AA needs 4.5:1. It cannot be fixed in the foreground:
  `#8d5bed`'s relative luminance is 0.1902, so 4.5:1 would need a foreground
  luminance of 1.0309 and white is 1.0. Darkening `--accent` is a brand-colour
  decision, so it is recorded here rather than made in an audit pass.

## 33. Aurora V-Shape and the equalizer (Phase 53 addendum)

### 33.1 What changed in the audio path

Before this phase Aurora had **no Web Audio at all**. `PlayerEngine` owns one
`AudioSurface`, created as `new Audio()` in `engine-factory.ts`, and the element's
output went straight to the speakers. The pipeline the addendum describes —
`HTMLMediaElement → AudioContext/DSP → EQ → preamp → destination` — was being
*built*, not extended. The addendum's §6 asks to "resolve the previous +3 dB vs
−3/−3.5 dB inconsistency"; there was no prior EQ for that to refer to, and the
figure is now fixed in `eq.ts` with a test that fails if it moves.

The graph is:

```
HTMLAudioElement  (the engine's, created in engine-factory.ts)
      │  createMediaElementSource          ← the one-way door, taken LAST
      ▼
  BiquadFilter  31 Hz   ─┐
  BiquadFilter  62 Hz    │
  BiquadFilter  125 Hz   │
  BiquadFilter  250 Hz   │
  BiquadFilter  500 Hz   ├─ ten peaking filters, Q 1.41, chained in series
  BiquadFilter  1 kHz    │
  BiquadFilter  2 kHz    │
  BiquadFilter  4 kHz    │
  BiquadFilter  8 kHz    │
  BiquadFilter  16 kHz  ─┘
      ▼
  GainNode  (preamp / headroom)
      ▼
  AudioContext.destination
```

### 33.2 The one-way door, and the order it dictates

`createMediaElementSource()` **permanently re-homes** the element's output. There
is no API to reverse it: once the element is routed through a
`MediaElementAudioSourceNode`, it no longer reaches the speakers on its own.
Tearing the graph down therefore does not restore direct playback — it produces
**silence**.

That single fact dictates the whole order of operations, and every failure mode
below it is a non-event by construction:

1. resolve the element, and decline `no-element` if there is none
2. **require a user activation**, or defer (`isAwaitingGesture`) — nothing below
   can run without a started context, and deferring here allocates no context
3. **ask whether Web Audio may read this source at all** — `sourceVerdict`, with
   no source and an unreported CORS check both *deferring* and an unreadable
   source *declining* as `cors-tainted` (§33.8)
4. create the `AudioContext`
5. create the ten filters and chain them
6. create the preamp gain and wire it to `destination`
7. wire the last filter into the preamp
8. **only now** call `createMediaElementSource(element)`

Every failure at steps 1–7 leaves the element playing directly and untouched,
which is the entirety of §33's "fail gracefully and keep audio playback
functional". If step 8 itself throws, the element is not re-homed — that is what
throwing means — and the inert chain is discarded. **There is no ordering in
which this module can leave a listener with no sound.** Step 8 *completing* on a
source the browser will not let Web Audio read is a different matter — not an
ordering failure but a delivery one — and that is what step 3 exists to refuse
before the door is taken, and §33.8 measures for the case where the source
arrives later.

**Step 3 is before the context on purpose.** A source that cannot be used then
costs one string comparison instead of a `AudioContext`, a monotonic clock, ten
biquads and a gain node, all discarded. The audible cost of a decline is a
notice; the cost of finding out afterwards is that the element has already been
re-homed, and nothing in this feature can undo that.

**The gate in front of step 5, added after the first implementation of this
module shipped with the promise broken.** Steps 1–4 were never the risky part.
Step 5 was, because it was preceded by `await context.resume().catch(() =>
undefined)` — an unconditional commitment of the one-way door, whether or not
the browser had actually started the context. `resume()` does not fail
uniformly without a user activation: Safari rejects with `NotAllowedError`,
Chromium keeps the promise pending until a gesture. Both are swallowed
identically by a `.catch`, and re-homing an element into a context that never
started is **permanent silence**, because nothing in this feature ever calls
`resume()` a second time.

`engage()` is therefore split into an orchestrator and a `build()` that obeys
three rules:

- **Bounded resume.** `resume()` is awaited under `EQ_RESUME_TIMEOUT_MS`
  (1 s). The successful case resolves in a microtask, so the bound never
  delays an engagement that was going to work; it only caps the case where the
  browser is saying "not yet". Without it `engage()` could sit in flight
  indefinitely, and the store — which pushes on every change — would start a
  second engagement alongside it.
- **Re-home only on `context.state === "running"`.** Otherwise the inert chain
  is discarded, the context is closed, the element is never touched, and the
  attempt is *deferred* rather than failed: `isAwaitingGesture` becomes true
  and the next pointer/key/touch gesture re-runs it. A suspended context at
  page load is an ordinary lifecycle state, so it sets no `unsupportedReason`.
- **One engagement at a time.** `inflight` serialises concurrent `build()`s.
  A burst of configuration changes produces one context and one ten-filter
  chain; previously the loser of that race called `createMediaElementSource`
  second, threw `InvalidStateError`, and recorded a permanent `no-source`
  failure for a perfectly healthy graph.

`AudioGraphBridge` resolves the element through a registration rather than
creating it. `getElement()` returning `null` is a *supported answer* — server
render, a test-double surface, a browser with no Web Audio — and needs no special
handling because it is the same shape as "this browser cannot process audio".

### 33.3 Bypass is unity, never a disconnect

The corollary of 33.2. Turning the EQ off sets every band to 0 dB and the preamp
to 0 dB **and leaves the graph in place**. Disconnecting would be silence, not a
bypass. `effectiveGraphState()` returns all-zero bands and a 0 dB preamp when
disabled, and `bypass()` applies that through the normal parameter path — ten
`linearRampToValueAtTime` writes and one preamp write, on the nodes that are
already running. It never closes the context, never disconnects the source and
never recreates anything, so leaving bypass and returning costs nothing.

`dispose()` exists and is **test-only**. `PlayerEngine.cleanup()` remains what
stops audio.

### 33.4 One authority, one direction

```
  UI surfaces ──▶ eq-store.ts ──▶ eq-graph.ts ──▶ Web Audio
  (Settings, player, any popup)        │
                                        │ getEqElementResolver() ──▶ engine
                                        ▼
                              one HTMLAudioElement
```

- `eq.ts` is the single authority for the curve, the ranges, the presets, the
  headroom arithmetic and the wire format. It is pure and framework-free.
- `eq-store.ts` is the one canonical state (§42), reachable from non-React code.
  No surface holds a copy; `use-eq.ts` reads it through `useSyncExternalStore`.
- The engine knows **nothing** about the equalizer. It exposes exactly one
  addition: `mediaElement`, a read-only getter returning
  `HTMLAudioElement | null` — `null` when the surface is a test double, because
  a double is not connectable to Web Audio and pushing that check into every
  caller would be the wrong place for it.
- A quality gate asserts the dependency is one-way, that no `eq-*.ts` module
  imports anything under `lib/player`, `lib/music` or `lib/playback`, and that
  no playback module imports the EQ. §31/§32 are therefore true by
  construction, not by review.

A preset change is `graph.apply(state)` — parameter writes to the same ten
nodes. No node is created, destroyed or reconnected. The context is created
exactly once however many times `engage()` is called.

### 33.5 Headroom is the transfer function, not `max(band.gain)`

`peakingCoefficients()` (RBJ) produces the numbers handed to `BiquadFilterNode`
**and** the numbers `magnitudeDb()` evaluates, so the graph and the arithmetic
cannot disagree. `compositeMaxGainDb()` sums per-filter dB over a 513-point
logarithmic grid from 20 Hz to 20 kHz, **plus every band centre evaluated
exactly**.

The exact centre evaluations are load-bearing. A pure log grid does not land on
31 Hz, and a lone +12 dB band there measures 11.9945 dB on the grid — 0.0055 dB
*under* its own gain. Inaudible, and still the wrong direction for a function
whose job is to size headroom: it must never under-report, because everything
built on it assumes an upper bound. Ten extra evaluations make the guarantee
real.

**MEASURED, and this is the finding that matters:** Aurora V-Shape's composite
peak is **+3.8302 dB at ~61.7 Hz**, not the +3.0 dB the table implies. The
31/62/125 Hz group overlaps (drop 62 → 2.57; drop 31 → 3.38; drop 125 → 3.49).
The overlap excess is **0.83 dB**, so with the specified −3.5 dB preamp the chain
peaks at **+0.33 dB** — the addendum's own §6 arithmetic does not bound its own
shipped curve.

Resolution, and the reason it is a resolution rather than a change:

- `DEFAULT_PREAMP_DB = -3.5` **ships unchanged**. §52 exists precisely to stop
  this constant being "fixed" back to −3.
- The measured excess is documented at the constant and asserted in tests, so it
  cannot drift silently.
- `autoPreampDb` is composite-aware and returns **−4.3302 dB** for the V-Shape
  (a true −0.5 dB peak), available as "Auto Headroom" for anyone who wants the
  conservative figure.

The concrete demonstration that a naive bound is wrong: **two adjacent bands at
+6 dB peak at 7.19 dB**, so `−(max individual gain)` would under-compensate by
1.19 dB. That is the argument for computing the real thing.

`headroomSaturated()` reports when the range cannot express the requirement —
every band at +12 dB needs −18.93 dB against a −12 dB floor. The interface says
so rather than showing a reassuring clamped number.

**A measured borderline, recorded rather than rounded away:** a lone band at
+12 dB needs exactly −12.5 dB, which is 0.5 dB past the floor. The floor is not
widened to chase it; −12 dB is already a quarter of the signal's amplitude, and
the interface reports saturation instead of quietly protecting less than it says
it does. The saturation test carries a 1e-9 dB tolerance because a band at
exactly +11.5 dB evaluates to 11.500000000000037, and a bare comparison against
the floor would report a curve that *fits* as one that does not.

### 33.6 The curve, and where it came from

`AURORA_V_SHAPE` is a reference-informed musical choice, **not** a measurement of
any product and **not** Harman's tuning.

**The references actually used, and what each was used for.** They informed the
*kind of curve to build*; none of them supplied a gain figure.

- **Sean Olive, Todd Welti and Elisabeth McMullin (HARMAN)**, on headphone
  preference: the finding that listeners in blind tests consistently prefer a
  bass- and treble-emphasised target over a flat one, and the finding that
  preference is a *broad* curve rather than a sharp one. Used for the shape
  (wide low and high emphasis, relaxed mid) and for the confidence that a mild
  V is a defensible default. Their published tuning data is behind a paywall and
  concerns a different use case entirely; **no number here comes from it**, and
  none of it was copied or reverse-engineered.
- **RTINGS**, on consumer expectations for a "V-shape" vs "flat" EQ in headphones
  and speakers. Used only as a check that the terminology and the expected
  direction of each band match what a listener is looking for.
- **SoundGuys**, on headphone EQ practice. Used for the band-count and
  centre-frequency conventions a ten-band graphic equalizer is expected to use,
  which is why the centres are ISO-octave rounded rather than invented.

Forum presets, measurement charts and "target curves" found online were **not**
treated as authoritative, and the addendum's premise that HARMAN's work *is* a
V-shape is recorded as a false premise in the conflicts section below. Where the
addendum gave explicit per-band numbers, those numbers are what shipped — the
research was not used to override them.

| Band | Gain | Why this band |
|---|---:|---|
| 31 Hz | +2.5 | Sub presence without the 20–30 Hz rumble most hardware cannot reproduce |
| 62 Hz | +3.0 | The bass note most listeners actually feel; the peak of the composite |
| 125 Hz | +2.0 | Warmth, kept below 62 so the low end stays a shape and not a wall |
| 250 Hz | +0.5 | Just enough to keep the bass from sounding boxy |
| 500 Hz | −0.5 | First cut — the boxy/nasal region |
| 1 kHz | −1.0 | The deepest cut, so vocals sit forward |
| 2 kHz | −0.5 | Easing off the cut so presence returns |
| 4 kHz | +0.5 | Back to neutral; articulation |
| 8 kHz | +2.0 | The sparkle that makes it sound "open" |
| 16 kHz | +1.5 | Air, held under 8 kHz so it does not read as hiss |

Design constraints, stated as constraints:

- **Bands are 31 Hz – 16 kHz, not 20 Hz – 20 kHz.** A 20 Hz centre is below
  consumer reproduction limits — a control that does nothing. A 20 kHz centre is
  either inaudible or a hiss control. The ten centres above are ISO-octave
  rounded and each one is a place a listener can hear.
- **Q = 1.41 uniformly** — the textbook constant-Q octave graphic EQ. A narrower
  Q (≈2) would reduce band overlap, but at 31 Hz it produces a ~15 Hz bump below
  most hardware's reproduction limit: optimising for a shape nobody hears.
- **Flat is all 0 dB with a 0 dB preamp.** No stale V-Shape headroom.

### 33.7 Persistence: two sinks, one document

Same architecture as the appearance preference, reused rather than reinvented:

```
encodeEQ(config) ──▶ "aurora-eq" cookie      (immediate, always)
                └─▶ User.audioEq JSONB      (debounced, when signed in)
```

- A **column, not a table.** A second table is a second preference *system* —
  a second schema to migrate, a second write that can fail, a second thing to
  back up — and §40 rules that out. A second *column* on the existing table,
  through the same DAL/action/cookie shape, is a second preference, which is
  what this is.
- **A column, not a key inside `appearance`.** `Appearance` is a closed, typed,
  per-control shape with its own ranges, decoder and wire format. An audio key
  inside it would make it a bag of unrelated settings, break its per-field
  repair, and mean a glass edit could clobber a curve. Two domains, two
  documents, one table.
- The value is the **compact encoding**: every field equal to the default is
  omitted, so a listener who has not opened the equalizer is worth `{"v":1}` —
  eleven bytes. A fully hand-edited ten-band curve measures **221 bytes**.
- `EQWire` is a **type, not a runtime schema** — the same reasoning as
  `AppearanceWire`; zod once cost 88 KiB of gzip in this codebase. `decodeEQ`
  is total and per-field, with only `v` as a hard gate.
- The decoder **hardens the node count**: a stored band at an unknown frequency
  is *dropped, not added* — a cookie must not decide how many filters exist. A
  stored `flat` carrying stray gains is a contradiction and the preset wins.
- **No reset action**, and that is a decision. `setEQAction` already writes the
  default document to both sinks, and a dedicated reset action would be a second
  write path for one effect, with a second opportunity for the two to disagree
  about what the default is.
- **§39 separation is enforced, not promised.** A quality gate fails the build if
  any session/snapshot file mentions `audioEq`, `eqPreset`, `preamp` or
  `AURORA_V_SHAPE`, and another fails it if the playback snapshot names an EQ
  field. The equalizer is a device preference; a queue position is not; and
  "clear my playback session" must not clear the curve.

### 33.8 Degradation, and what is NOT covered

`EqGraph.engage()` returns `false` — a **supported outcome**, not an error — for
`no-element`, `no-web-audio` and `cors-tainted`. In every case playback continues
untouched and the interface says the equalizer is unavailable *in the same breath
as the failure*, because a notice reporting only the problem reads as "music is
broken".

`cors-tainted` gets its own notice text (`eq.unsupportedSource`) rather than
sharing `eq.unsupported`. The two reasons are not the same kind of fact:
`no-web-audio` is about the listener's browser, and "this browser cannot process
audio" is an answer to a question nobody asked when the real cause is the
provider's stream.

Two **deferrals** are deliberately not in that list, because neither is a
failure and reporting either as one would put an error notice in front of a
listener whose equalizer is healthy:

- `isAwaitingGesture` — "the browser wants a gesture first, the graph is fine,
  and it will retry by itself".
- `isAwaitingSource` — "there is nothing to re-home yet, or the element's CORS
  check has not reported, and the graph is listening for the event that answers
  it". This is the ordinary state of a listener who switches the equalizer on
  before pressing play.

`eq-store.push()` maps both to `unsupportedReason: null`.

Parameter changes are smoothed: `cancelScheduledValues` →
`setValueAtTime(current)` → `linearRampToValueAtTime(target, now + 0.03)`. The
anchor is not optional: a ramp with no anchor ramps from whatever the last event
left, which on a fresh gain is 0 — an audible full-scale jump on the first drag.
The same treatment is applied to frequency and to Q, because a filter whose
centre jumps while its gain is already changing produces an artefact that
smoothing only one of the two does not fix.

`sanitizeGraphState(state, fresh)` guards what reaches those ramps, and it is
**one rule per situation rather than one rule for all of them**:

- **On apply, non-finite gain/frequency/Q is rejected, not rewritten.** It is
  passed through so `ramp()` drops it before it can reach an `AudioParam`, and
  the parameter keeps the number already in the graph — the last known good
  value. Nothing is scheduled, so nothing moves to a curve the listener never
  asked for.
- **On a fresh build, non-finite frequency/Q is replaced** with the canonical
  centre and `EQ_BAND_Q`. There is no "already in the graph" to keep at that
  point, and a node's own defaults are 350 Hz / Q 1 — neither is one of
  Aurora's bands.
- **Finite values are clamped** to the model's own ranges: band gain
  −12…+12 dB, preamp −12…0 dB. **Non-finite preamp becomes 0 dB** (unity),
  which is the model's own `dbToLinearSafe` answer: a preamp nobody can describe
  must neither amplify nor attenuate.

Anything it had to touch is reported once as `eq_parameter_sanitized`.

**The silence, measured, and the gate that now stands in front of it.** The
stream URLs are cross-origin googlevideo and the element carries no
`crossOrigin`. Per specification a `MediaElementAudioSourceNode` over such a
resource outputs **zeroes**, and on 2026-09-26 that was confirmed end to end in
a real Chromium against a real provider stream. The element was healthy —
`paused: false`, `readyState: 4`, `currentTime` advancing, `volume: 1`,
`muted: false`, `AudioContext.state: "running"`, all ten filters `peaking` at
exactly the configured gains, preamp at the right linear value — while an
analyser tapped at the source node and at the preamp both read **exactly 0**.
Chrome named the cause: *"MediaElementAudioSource outputs zeroes due to CORS
access restrictions."*

**The curve was never the cause.** Injecting 0.05 DC at the first filter and
reading the preamp returned the configured attenuation of it, so the chain, the
biquads and the headroom were all provably correct. Flat was equally silent, and
so was V-Shape → Bypass → V-Shape, because Bypass leaves the door open. What
made the music stop was *engaging the graph at all* on an unreadable source.

The obvious fix was tested rather than assumed, and it does not work: setting
`element.crossOrigin = "anonymous"` and reloading makes the browser log *"No
'Access-Control-Allow-Origin' header is present on the requested resource"* and
the element fail outright with `MEDIA_ERR_SRC_NOT_SUPPORTED` (errorCode 4) —
**strictly worse than the silence.** The attribute cannot be set here; it
belongs to whoever owns media delivery.

**So the graph answers the question before it takes the door, and the answer is
local.** `sourceVerdict(url, element, origin)` in `eq-graph.ts` returns one of
three values, and the third is the reason it is not a boolean:

| verdict | when | what the graph does |
| --- | --- | --- |
| `readable` | same-origin; or `blob:`/`data:`; or a cross-origin source whose element set `crossOrigin` and has loaded (`readyState > 0`, no `error`) | engages |
| `unreadable` | cross-origin with no CORS opt-in; or a failed check; or an unparseable URL | `decline("cors-tainted")` — the element is never touched |
| `not-yet` | opted in, but the check has neither passed nor failed | defers, and listens for the event that reports |

**It asks the network nothing.** An earlier version issued its own ranged,
`mode: "cors"` `fetch()` and read the verdict from whether it resolved. That was
measuring the wrong thing, and the test suite caught it rather than review:
Aurora's CSP is `connect-src 'self' ws: wss:`, so the probe's own request was
blocked **by the page's policy** before it left the browser — a `TypeError`
indistinguishable from a CORS refusal, which would have declined the equalizer
for sources Web Audio could read perfectly well. A probe that inherits the app's
policy is not a measurement of the media. `eq-graph.test.ts` now stubs `fetch`
to throw and asserts the gate still decides correctly, so this cannot return.

**Consequence, stated plainly.** On this media delivery path the equalizer
**declines**, the listener is told the *stream* is the problem rather than their
browser, and their music plays. The same code engages — and is measurably
audible — the moment media delivery is something Web Audio may read. That
capability is a media-delivery change wearing an equalizer costume and is
recorded in `docs/scope-boundaries.md` as deliberately not built here.

**The limit of the gate, stated rather than hidden.** The verdict is asked before
the door, so it is asked about the source the element has *at that moment*. A
later `src` cannot be refused, only noticed: `onSourceChange` subscribes to
`loadstart`/`emptied`/`loadedmetadata`/`canplay`/`error`, and a source that
arrives unreadable is **reported** (`eq_source_unreadable_after_engage`, surfaced
as the same stream notice) and never torn down — a teardown would leave the
element re-homed into a closed context, which is the same silence with less
information. This is unreachable while no Aurora source is CORS-readable; it is
documented so that it is not a surprise if media delivery ever changes.

### 33.9 The mode model, one atomic apply, latest-wins

**The four modes are `flat`, `aurora-v`, `custom` and `bypass`** — the model's
own names. `bypass` is **derived, never stored**: `effectiveMode(config,
comparing)` returns `"bypass"` whenever the equalizer is off or the
hold-to-compare control is held, and otherwise `config.presetId`. It is the one
place the rule *"off means neutral"* is written down, which is why `enabled` and
`bypass` cannot disagree: there is no `bypass` flag to contradict `enabled`,
because it is computed from `enabled` at the moment it is asked for.

**Mode is separate from parameters.** A mode names a *policy* for choosing bands
and preamp — Flat → every band 0 dB and a 0 dB preamp (no stale V-Shape
headroom); V-Shape → the shipped ten-band curve under the declared −3.5 dB
preamp; Custom → the listener's edited bands under automatic headroom — and
bands/preamp are the parameters that policy resolves to. `effectiveGraphState()`
performs the resolution, `graph.apply(state)` performs **one atomic write** of
the result, and `push()` is the only bridge between them. Custom is independent
of the presets: Custom → V-Shape → Custom restores the edited curve rather than
the preset's.

**What a mode change is forbidden to do** — pause, stop, reset position,
recreate the media element, replace an `AudioSource`, trigger a resolver
request, reload a track, clear the queue, recreate the controller or recreate
the `AudioContext` — is guaranteed structurally rather than by review: `apply()`
has no path that constructs a node and no path that touches the element, and the
only constructor in the module is `build()`, which runs once per engagement. A
preset change is ten `AudioParam` writes to the nodes that already exist.

**Latest request wins.** `push()` stamps each request with a monotonic
`pushGeneration` and only the `.then` whose generation is still current writes
`engaged`/`unsupportedReason` back to the store; `engage()` re-reads `requested`
after each in-flight build and applies the newest one. A rapid
Flat → V-Shape → Flat therefore lands on Flat in the graph *and* in the
interface, and a stale attempt can never stamp an error over a successful one.

**Diagnostics** — one event per transition, one per failure, primitive fields
only (the logger drops URL-shaped and credential-shaped keys regardless):

| Event | Level | Emitted when |
|---|---|---|
| `eq_mode_change_requested` | info | the derived mode changed |
| `eq_preset_applied` | info | `choosePreset` committed a different curve |
| `eq_state_applied` | info | a write actually moved the graph |
| `eq_bypass_changed` | info | the live graph was neutralised |
| `eq_audio_context_state` | info / warn | engaged, deferred to a gesture, declined |
| `eq_audio_graph_health` | info | at engagement, and on a mode transition |
| `eq_parameter_sanitized` | warn | a non-finite or out-of-range value was refused |
| `eq_transition_error` | warn | a parameter write threw |
| `eq_state_reverted` | warn | the last-known-good curve was restored |

`eq_audio_graph_health` is deliberately a *transition* check, not a per-frame
one: `health()` reads `filterCount`, `contextState`, `preampConnected` and
`awaitingGesture`, and runs where those being wrong would matter — at
engagement and on a mode change.

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
   the session snapshot persists `TrackRef` + display metadata only, and
   every restored entry is re-resolved fresh on play. No audio data of any
   kind is stored: no blobs, no segments, no offline cache.
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
19. Multilingual UI is Vietnamese-default with English option only —
    `src/lib/i18n/vi.ts` is the `Messages` contract source of truth,
    parity enforced by type plus test; playback engines never consume
    locale context, so switching languages cannot interrupt music, reset
    the queue, or recreate players; no `localStorage`/`sessionStorage`/
    `indexedDB` (cookie + `User.locale` only).
20. Single design-value authority — `src/app/globals.css` is the only
    place a literal design value is written. Primitives (`--p-*`) hold the
    literals, components consume semantic tokens only and never a ramp step
    directly, and no token definition is self-referential (invalid CSS that
    fails silently). Enforced statically by `design-tokens.test.ts`.
21. Every animation has a reduced-motion path — decorative motion is
    declared only inside a `prefers-reduced-motion: no-preference` block,
    and the blanket `reduce` net may shorten motion but must never touch
    `opacity`, `visibility`, `display`, or `transform`. Motion is limited
    to compositor-friendly properties.
22. In-app navigation never unmounts the `(app)` layout — the layout owns
    `PlayerHost`, and therefore the audio engine, the playback controller,
    the persistence controller, and the memory-only radio session. All
    in-app navigation therefore goes through the App Router (`router.push`,
    `Link`), never a native form submission or `location` assignment, both
    of which destroy the document and run the engine's shutdown cleanup.
    Consequently a search, a route change, or a locale switch cannot
    interrupt playback, replace the queue, or drop a radio session.
    Enforced by `search-field.test.tsx` (no `action`/`method` on the form)
    and `search-navigation.spec.ts` (a `window` sentinel must survive
    search navigation and must not survive a real reload).
23. Recommendations are deterministic and local — the pipeline in
    `src/lib/recommendations/` reads Aurora's own signals, ranks with a
    documented rule set, and returns plain `Track`s. It never calls the
    network directly, never touches the clock or a random source, and never
    reaches an ML, embedding, LLM or external recommendation service. The
    layer may not import provider internals or write to the queue.
24. `QueueManager` remains the only queue writer — the continuation
    coordinator decides *when* and *how much* to generate and appends only
    through the queue facade; it owns no queue state and no playback.
    Radio is the other, pre-existing writer and stays authoritative: while a
    radio session is active, generic continuation defers to it.
25. Continuation never overrides an explicit user command — Play, Play
    Playlist/Album/Track, Next, Previous, Stop, Clear Queue and Replace
    Queue all take precedence; clearing never repopulates, and replacing
    resets the continuation context. Off means the queue ends normally.
26. Every `app/actions/*` module opens with `"use server"` and exports only
    actions and types. A client component may import an action; it may never
    cause the module — and therefore the Prisma/pg chain behind it — to be
    bundled for the browser. Enforced by
    `src/lib/__tests__/phase47-architecture.test.ts`.
27. A public playlist URL carries only an opaque share token — no playlist
    id, no owner id, no provider id. The public read model omits `ownerId`
    and `shareToken` by type, and the query requires both a matching token
    and `visibility = "shared"`, so a private playlist is not reachable by
    guessing an identifier and a revoked link stops resolving immediately.
28. Nothing algorithm-specific is persisted — the session snapshot stores the
    real queue, current track, position, shuffle and repeat. Recommendation
    and continuation state is memory-only and bounded.
29. The autoplay UI has exactly one implementation and one state binder.
    `AutoplayButton` (`src/components/player/autoplay-button.tsx`) is the only
    control; the player bar, the full player and the queue panel all render it,
    so one feature cannot end up with two icons, two active treatments or two
    sets of wording. `useKeepListening`
    (`src/lib/listening/use-keep-listening.ts`) is the only binding between the
    coordinator and any surface, and its save result is module-level shared
    state rather than per-caller `useState` — otherwise the surface that
    rendered a failed write would not be the surface that performed it. A
    whitelist in `src/lib/__tests__/phase47-architecture.test.ts` pins the
    known hosts, so a rogue fourth control is a test failure rather than a
    design drift.
30. `instance.ts` is the coordinator's notification contract, not merely a
    holder: its single listener set is woken both when a coordinator appears
    and on every state change inside it (the relay is detached when the
    coordinator is replaced or cleared). A `useSyncExternalStore` subscriber
    bound there therefore reads a live snapshot, which is what lets the icon
    show the transient `generating` state that no other store event surfaces.
    Any future refactor that keeps the two listener sets separate reintroduces
    a control that renders a stale value.
31. The user-facing term is "Autoplay" / "Tự động phát" while the internal name
    stays `keepListening` (column, action, coordinator). The internal name
    describes the mechanism; the product term describes the setting. Renaming
    the internals is not required, and the spec is what a listener reads.
32. **Overlap is resolved by a named layer, never by a number.** Components
    consume the `--p-z-*` stack published by `globals.css` and never write a
    z-index literal; the stack's *order* is asserted, not merely documented,
    so the two orderings the product depends on — queue (`z-dialog`) above
    full player (`z-sheet`), and mini player (`z-player`) above bottom
    navigation (`z-rail`) — are test failures if they ever invert. Two
    `fixed` siblings with no shared parent are kept apart by geometry *and*
    by layer, because either alone is insufficient. Enforced statically by
    `src/components/ui/__tests__/layering.test.ts` and behaviourally by
    `e2e/layering-presence.spec.ts` and `e2e/responsive-layers.spec.ts`.
33. **Presence is centralised and an exit always completes.** Every animated
    overlay goes through `usePresence`; no component hand-rolls its own
    unmount timing, and `if (!open) return null` is not an accepted way to
    close one. Unmount is timer-driven (mirroring the duration tokens)
    rather than `animationend`-driven, so it cannot depend on an event that
    jsdom never fires, a reduced-motion stylesheet never lets through, or a
    backgrounded tab drops. An exiting overlay carries `inert` from
    `presenceProps` for its whole exit, so it is never focusable, never
    announced, and never able to intercept a click meant for what is behind
    it — and reduced motion shortens the animation without skipping the
    cleanup. Enforced by `src/components/ui/__tests__/presence.test.tsx`
    (17 cases, including both rapid-toggle directions and the unmount
    budget).
34. **The shared catalog's write path is a trust boundary, because there is
    nothing else to authorize it.** `Track`/`Artist`/`Album` have no owner,
    so the per-row `requireUser`/owner recheck that protects `Playlist`,
    `Like` and `Follow` has no analogue here; the *shape* of what a client may
    cause to be written is the only control point that exists. `upsertTrack`
    therefore excludes `streamUrl`, `previewUrl` and `metadata` from its
    parameter type and writes neither on create nor on update, and
    `addTrackSchema` omits them so the untrusted edge strips them. This does
    not weaken invariant 8 — it is the write-side counterpart of it: no URL
    reaches the catalog, and none is ever playback input.
35. **Bun is the only package manager, and the lockfile says so.** `bun.lock`
    is the sole dependency authority; a `package-lock.json` in the tree is a
    defect, not a compatibility shim, because two lockfiles silently disagree
    and the loser is whichever the developer happened to run. `packageManager`
    pins the exact Bun version so CI and a laptop resolve identically. Node
    remains a *runtime* for toolchain internals that shell out to it
    (Prisma's engine spawn, Next's helpers) and is deliberately not
    constrained: it installs nothing and runs no project script. The
    consequence that matters architecturally is that `next build`/`next start`
    execute under Bun, so a runtime-specific assumption (error shape, fetch
    behaviour, child-process resolution) must be proven under Bun rather than
    assumed from Node, which is how the `isPortFree` refusal-detection bug
    was found and fixed.
36. **Installed Aurora and browser Aurora are the same application.** There is
    no PWA build, no install-only bundle, and no duplicated product logic:
    installed mode is a display-mode difference over the same routes, the same
    shell, and the same playback authority. Consequently the installable
    surface has exactly one source of each truth — one manifest
    (`src/app/manifest.ts`), one identity module (`src/lib/app-metadata.ts`),
    one install authority (`InstallProvider`), one platform/capability
    detector (`src/lib/pwa/platform.ts`), and one service worker
    (`public/sw.js`). A second definition of any of them is a defect, and the
    tests fail on one. A capability is advertised only when it is measured or
    implemented: `offlineAudio` and `pushNotifications` are permanently
    `false`, because there is no offline download and no push service, and
    promising either would be a claim the system cannot honour.
37. **The application worker never takes control of a running session.** A new
    worker parks rather than `skipWaiting()`, and the page releases it at
    `pagehide`. Playback is a continuous experience that must survive a
    deploy, so a service-worker update is only ever allowed to land between
    documents. This is the same reasoning as invariant 33's presence contract:
    a transient must not interrupt a transient.
38. **The equalizer is a colouration layer, and it can never take playback down
    with it.** Aurora has exactly one `AudioContext`, one `HTMLAudioElement` and
    one `PlayerEngine`; the ten `BiquadFilterNode`s and the preamp `GainNode` are
    spliced into the path the engine already owned, and the engine knows nothing
    about them. The load-bearing constraint is that
    `createMediaElementSource()` is **irreversible** — once the element is routed
    into a graph it can never reach the speakers on its own — so the graph is
    fully built and wired to `destination` *before* the element is re-homed, and
    every failure above that line leaves the element playing directly. There is
    consequently no ordering in which an equalizer error produces silence:
    disabling it is **unity gain through the live graph**, never a disconnect,
    and `EqGraph.dispose()` exists for tests only. A preset or band change writes
    parameters to the same ten nodes; it never rebuilds, never reconnects and
    never creates a second context, however many times it is applied. Enforced
    statically by `src/quality-gates.test.ts` (one `new Audio(`, one
    `AudioContext` construction site, no `eq-*` import in any playback module,
    no playback import in any `eq-*` module) and behaviourally by
    `src/lib/audio/__tests__/eq-graph.test.ts`, which drives a fake
    `AudioContext` and asserts that a failed engagement never touches the
    element, and by
    `src/lib/audio/__tests__/eq-store.test.ts`, which drives the same fake
    through the store and asserts the whole chain — an action to an `AudioParam`
    — on one context and one set of ten nodes. The mode model is
    `flat`/`aurora-v`/`custom`/`bypass`, where `bypass` is derived by
    `effectiveMode()` from `enabled` and `comparing` rather than stored, so
    there is no second flag that could contradict `enabled`; `push()` carries a
    monotonic generation so the latest requested state wins; and `build()` only
    re-homes the element once `AudioContext.state === "running"`, deferring to
    the next user gesture otherwise, because re-homing into a context that
    never started is the one path to permanent silence and it is now closed.
39. **Headroom is measured from the real transfer function, and saturation is
    reported rather than hidden.** `peakingCoefficients()` produces the numbers
    handed to the node *and* the numbers the headroom arithmetic evaluates, so
    graph and calculation cannot disagree; `compositeMaxGainDb()` sums per-filter
    dB across a 513-point logarithmic grid **plus every band centre evaluated
    exactly**, because a grid that misses 31 Hz under-reports a lone +12 dB band
    by 0.0055 dB and a ceiling that under-reports is worse than no ceiling. It
    follows that `-(max individual band gain)` is **not** a bound — two adjacent
    +6 dB bands peak at 7.19 dB, and the shipped Aurora V-Shape peaks at
    **+3.8302 dB at ~61.7 Hz**, so the specified −3.5 dB preamp leaves +0.33 dB
    of peak. `DEFAULT_PREAMP_DB` is therefore exactly −3.5 and is frozen by
    test; the measured overlap is documented at the constant rather than
    "corrected" out of it, and `autoPreampDb` offers the composite-aware −4.3302
    dB as "Auto Headroom". When the −12…0 dB range cannot express what a curve
    needs, the interface says so — a clamped, reassuring number would be a lie
    about protection that is not being provided.
40. **Equalizer state is a device preference and playback state is not.** The
    curve persists to the same two sinks the appearance preference uses — an
    immediate `aurora-eq` cookie and a debounced nullable `User.audioEq` column
    — as the compact encoding that omits every field equal to the default. A
    *column on the existing table* is reuse of the preference architecture; a new
    table or a key nested inside `appearance` would each be a second preference
    system, and the latter would break that closed document's per-field repair so
    a glass edit could clobber a curve. No `AudioSource`, stream URL, provider id,
    position or queue is ever persisted with it, and no session/snapshot module
    may mention the equalizer at all. `EQWire` is a type, not a runtime schema,
    the decoder is total and per-field with `v` as the only hard gate, and a
    stored band at an unknown frequency is dropped rather than added — a cookie
    must never decide how many filters exist. Enforced by
    `src/quality-gates.test.ts` and the reviewed migration allowlist in
    `src/lib/dal/__tests__/playback-schema.test.ts`.
41. **The three user collections hold one entry per CANONICAL track, and
    "canonical" has exactly one definition.** Playlist membership, the active
    queue and Recently Played are the only collections in the product that
    deduplicate, and they deduplicate for the same reason: a listener means
    "this song", not "this row". The identity behind that word is
    `src/lib/domain/track-dedupe.ts` alone, which is why
    `canonicalTrackKeys` is what `queue-relation.ts` reads and
    `AUTO_MERGE_CLASSIFICATIONS` is what `unified-search.ts` reads — a second
    key format or a second merge threshold is a second identity system, and it
    would let the queue call a duplicate "new" while search calls it "merged".

    Two tiers, in this order, and never the reverse: an exact `source:id` key
    lookup (O(1), a `Map`, and the only tier that runs in a hot path), then
    `TrackMatcher` on a key miss. Normalization always precedes both: a tier can
    only see what the normalizer could build. Only `exact` and `strong` merge —
    `possible` is a question, not an answer, and acting on it is how a
    different song sharing a title gets deleted. A track that cannot canonicalize
    at all (no stable provider id, no title, no artist) is **never** a
    duplicate and is always kept: a malformed row is not evidence about
    anything, and failing open is the same choice `QueueManager` already makes
    for a track it cannot align.

    Where each rule is *enforced* differs, and deliberately so:

    | Collection | Enforcement | Why there |
    |---|---|---|
    | Playlist membership | `@@unique([playlistId, trackId])` + canonical check in `addTrackToPlaylist` | The constraint closes the concurrent-write window; the check sees the cross-provider renderings it cannot |
    | Active queue | The store, at the single point the array is materialized | There is no server round trip, so the rule has to be local to the one owner of the array |
    | Recently Played | `@@unique([userId, trackId])` + canonical merge in `recordPlayed` + read-side collapse | Same split as playlists, for the same reason |

    Ordering is never violated: normalize → canonical identity → dedupe →
    collect. A list deduplicated before normalization is deduplicated against a
    key format that does not exist yet.

    Three things are explicitly NOT deduplicated, because collapsing them would
    destroy the evidence they exist to keep: analytics, per-play event streams
    and audit logs. Aurora has no per-play event table, so that exclusion is
    currently free — `RecentlyPlayed` stores *current recency state* and is
    consumed only as a recency signal (radio seeds, recommendation affinity, the
    library and home lists), never as a play count. Should a per-play event log
    ever be introduced it is a NEW model beside this one, never a relaxation of
    this constraint; "how many times did they play it" and "when did they last
    play it" are different questions, and only the second is stored here.

    Deduplication is also never a React concern. `TrackList`'s occurrence
    counter disambiguates keys for *provider* collections, which may legitimately
    repeat; a user collection that reaches a component holding two entries for
    one song is a bug upstream, and hiding it in a render would leave the
    database wrong while making the symptom disappear.
42. **An open menu is painted whole, where its trigger is.** Four claims, and
    all four are the responsibility of whoever adds a menu: the trigger's own
    `relative` wrapper is the positioning context (no app-root box, no
    `fixed`); no ancestor between the surface and the page carries a clip, so
    a host that needs `overflow-hidden` for artwork **splits layers** rather
    than clipping its children; overlap is resolved with the `z-dropdown`
    token, never a number; and the direction comes from `useMenuOpenUp` alone,
    measured from the trigger and the surface actually in the slot. A surface
    that has to escape a scroll container escapes it by rendering into a
    layer inside the same panel — never into `<body>`, which would drop it out
    of the dialog's focus trap and behind the panel — and then closes when
    that container scrolls, because a menu anchored to a row it can no longer
    see is a menu about the wrong row. "Outside click" is scoped to the dialog
    that *hosts* the trigger, so a panel that is itself a dialog does not
    exempt its own contents. Enforced by
    `src/components/ui/__tests__/menu-placement.test.tsx` (the rule),
    `src/components/ui/__tests__/menu-clipping.test.ts` (the clip classes),
    `src/components/player/__tests__/queue-panel.test.tsx` (the layer and the
    three dismissals), `e2e/menu-clipping.spec.ts` (the resolved geometry), and
    §21.4.

---

## UNRESOLVED DOCUMENTATION CONFLICTS

If a future conflict requires a product decision, record it here rather than
inventing an answer.

### Open — Phase 53 addendum

**1. The addendum's §2 volume/mute instruction contradicts this repository.**

§2 says "do NOT persist volume/mute". `PRODUCT_SPEC.md` §7, this file, and E2E
Journey 17 all treat volume and mute as **persisted** user preferences, and the
code does persist them. The addendum is the newer document but not the
canonical one: `AGENTS.md` names `PRODUCT_SPEC.md` and this file as the sources
of truth for scope and architecture, and neither was changed to match. Volume
and mute are therefore **left persisted**, and the discrepancy is reported rather
than silently resolved. The consequence is worth stating plainly — the addendum
adds a second *persistable preference* to a page that already had one, so if the
instruction is ever honoured, `appearance` and `audioEq` need a stated
relationship at that point.

**2. §6's "resolve the +3 dB vs −3/−3.5 dB inconsistency" refers to nothing that
exists.** The addendum describes the new curve as reconciling a *previous* EQ
and a previous preamp decision. Aurora had no equalizer, no `AudioContext`, no
`BiquadFilterNode` and no preamp of any kind before this phase, so there is no
prior decision to reconcile and nothing to resolve *with*. §52's instruction not
to "fix" −3.5 back to −3 is nevertheless satisfied prospectively: −3.5 is
declared once in `src/lib/audio/eq.ts`, frozen by test, and the reasoning that
motivated it is recorded in §33.5.

**3. §3's framing of "Harman" as a V-Shape is a false premise, and was not
adopted.** HARMAN's published work (Sean Olive, Todd Welti, Elisabeth McMullin)
is concerned with *loudness* matching and headphone/room correction, not with a
consumer V-shaped listening curve, and the research is behind a paywall. Aurora
V-Shape is therefore documented as a **reference-informed musical choice** and
nothing more: no proprietary tuning was consulted, copied, reverse-engineered or
claimed, and no forum or measurement chart was treated as authoritative. The
independent sources actually used are listed in §33.6 and in the phase report.

**4. §5's own arithmetic does not bound its own curve.** §5 derives −3.5 dB from
"+3.0 dB maximum boost", and §33.5 measures the shipped table's composite peak at
**+3.8302 dB**, so the specified preamp leaves +0.33 dB of peak. This is a
defect in the specification, not a decision left open: the constant ships
unchanged at −3.5 as instructed, the excess is documented and asserted, and the
composite-aware −4.3302 dB is offered as "Auto Headroom". See §33.5.

Resolved during Phase 32 (objective, code-supported):

- Home page copy "Playlist creation and editing arrive in a later phase"
  (`src/app/(app)/page.tsx`) is stale: playlist create/edit/delete now
  exists via dialogs and server actions. Product spec documents the
  implemented behavior; the copy is a UI-text fix for a later phase
  (no behavior change made here).
