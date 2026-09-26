# YouTube request map (Phase 55 audit)

Measured from the working tree at the start of Phase 55. One `Innertube`
instance exists (`playback/innertube-client.ts`) and is used for **playback
resolution only**. Everything in the "discovery" half of the table below goes
through `client.ts` to `https://www.googleapis.com/youtube/v3`.

**After Phase 55**, that one instance is shared with discovery (it lives in
`innertube/session.ts`), and the discovery operations route through
`tiered-transport.ts`. The table below is kept as the *before* picture because
the reasoning that produced the decisions depends on it; the *after* picture is
in "What was built" at the end.

## Quota buckets, per Google

| Bucket | Endpoints | Cost |
|---|---|---|
| `search.list` (separate) | `search.list` | **100 units/day default** |
| read/write (shared) | `videos.list`, `channels.list`, `playlists.list`, `playlistItems.list` | 1 unit/call |

So the entire optimisation problem is **`search.list`**. Everything else is
already in the cheap bucket, and moving it buys almost nothing while adding a
parser-failure surface.

## The inventory

**Read `SOURCE TODAY` and `CACHE` as the audit-time baseline**, captured before
any Phase 55 code existed. They are left unedited on purpose: the point of the
table is the *before* picture, so that "what changed and why" is checkable
against something rather than asserted. The `INNERTUBE?` column records
feasibility, and two of its entries were wrong the first time — they were
revised against captured payloads, and the corrections are recorded below.

| # | FILE | FUNCTION | ENDPOINT | TRIGGER | FREQ | CACHE | SOURCE TODAY | INNERTUBE? | DATA API? | MUST BE OFFICIAL? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `youtube-provider.ts:97` | `searchTracks` | `search.list type=video` | `/search` page render, radio discovery (`backend.ts:58`), any fan-out via `ExtractorManager.searchAll` | **per query, per user** | **none** | Data API | yes (`Innertube.search`, typed `type: "video"`) | yes | no — InnerTube is sufficient |
| 2 | `youtube-provider.ts:119` | `searchArtists` | `search.list type=channel` | `/search` page render, radio artist avenues | **per query, per user** | **none** | Data API | yes (`Channel` nodes; name in `author.name`) | yes | no |
| 3 | `youtube-provider.ts:138` | `getArtistTracks` | `search.list channelId` | artist page, radio artist avenue | per artist page | **none** | Data API | yes (`getChannel().getVideos()` → `current_tab`) | yes | no |
| 4 | `youtube-provider.ts:170` | `getTrack` | `videos.list` | track page, `ExtractorManager.getTrack` | per track | **none** | Data API | yes (`getInfo`) | yes | no — 1 unit either way |
| 5 | `youtube-provider.ts:136` | `searchArtists`→`getChannels` | `channels.list` | follows #2 | per query | **none** | Data API | partial | yes | **yes** — channel snippet/subscriber metadata is official; InnerTube's is a lossy UI-shaped read |
| 6 | `youtube-provider.ts:316` | `getPlaylist` | `playlists.list` | playlist share view | per playlist | **none** | Data API | thin in v18 (WEB `Playlist` has no `contents`) | yes | **yes** (already 1 unit) |
| 7 | `youtube-provider.ts:332` | `getPlaylistItems` | `playlistItems.list` | playlist share view; page-walks **up to 10 pages** | per playlist, per page | **none** | Data API | thin in v18 | yes | **yes** (already 1 unit) |
| 8 | `youtube-provider.ts:368` | playlist hydration | `videos.list` (batched ×50) | after #7 | per playlist page | **none** | Data API | yes | yes | no |
| 9 | `playback/innertube-client.ts:350` | `getMediaInfo` | InnerTube `getInfo` | every play / source expiry | per play | **in-flight only** | **InnerTube** | — | — | no |
| 10 | `server.ts:242` | `fetchArtistDetail` | `channels.list` | `/artist/[id]` | per page | **none** | Data API | — | yes | yes (see #5) |
| 11 | `server.ts:260` | `fetchTrackDetail` | `videos.list` | `/track/[id]` | per page | **none** | Data API | yes | yes | no |
| 12 | `server.ts:295` | `fetchRecommendations` | — | not advertised by YouTube | 0 | — | — | — | — | n/a |
| 13 | `radio/service.ts:289,309,335,344` | 4 avenues | #1 / #3 | every radio generation | per generation | **none** | Data API | yes | yes | no |

Row 2 originally read "yes (`LockupView.content_type === 'CHANNEL'`)" and row 3
did not mention where the rows live at all. Both were written from the same
remembered schema and both were wrong; see the measured table further down.
Rows 1–4 and 8 are now InnerTube-primary with a TTL cache, 5–7 remain official
and `channels.list` gained a 6-hour cache, and row 9 is unchanged except that
the session is now shared with discovery rather than private to playback.

`tracks.popular`, `tracks.featured`, `tracks.recommendations`, `search.albums`,
`albums.get`, `albums.tracks` are **not advertised** by the YouTube provider, so
home sections and album pages never reach it. Radio's `popularTracks` avenue is
therefore inert for YouTube.

## What this means

- **`search.list` is reached from three distinct operations** (#1, #2, #3), all
  of which fire on ordinary user search and again on every radio generation.
- **There is no cache of any kind** anywhere in `src/lib` — no TTL cache, no
  in-flight dedup outside the playback client, no negative cache. A reload of
  the same search page re-spends the same quota.
- **In-flight dedup exists only for `getMediaInfo`** (`innertube-client.ts:250`).
  #1–#8 have none, so three components asking for the same video simultaneously
  produce three `videos.list` calls.
- **No circuit breaker.** `client.ts` maps quota reasons to a `retryable` flag,
  and `quotaExceeded` is correctly marked **non**-retryable. (An earlier draft of
  this document claimed the opposite; the claim was wrong, and the gap was
  narrower than it first looked.) What was actually missing is that
  non-retryable is not the same as *stop calling*: a `dailyLimitExceeded` with
  `retryable: false` still left the **next** user request making another call
  that also failed. Not a retry storm, but a call-per-request, all of which burn
  latency and produce error paths. `innertube/data-api-circuit.ts` is that gap.
- **`getVideos` requests `snippet,contentDetails,status`** although `status` is
  never read by the normalizer.
- **`getPlaylistItems` page-walks up to 10 pages** at 50/page to satisfy an
  `offset+limit` window that is 50 by default.

## Decisions taken

1. **`search.list` → InnerTube** for #1, #2, #3, with a deterministic quality
   gate and Data API fallback. This is the whole point of the phase.
2. **`videos.list` → InnerTube** (#4, #8): 1 unit → 0, and `getInfo` returns
   the duration the Data API does.
3. **Playlists stay on the Data API** (#6, #7). They are already in the 1-unit
   bucket, and `youtubei.js@18.0.0`'s WEB `Playlist` exposes no `contents`, so
   the InnerTube path would be a weaker parser for no quota gain. Recording
   this as a deliberate non-change is the point of §35.
4. **`channels.list` stays** (#5, #10) as OFFICIAL-DATA-REQUIRED: it is
   authoritative channel metadata at 1 unit, and InnerTube has no equivalent
   structured read.
5. **Add L1 in-flight dedup + L2 TTL cache + negative cache** over the whole
   transport, and a **quota circuit breaker** over the Data API only.
6. **Bound the playlist page walk** to what the window actually needs.
7. **Drop `status` from `videos.list`** (`snippet,contentDetails` only).

## Endpoint classification (§35, final)

Every Data API endpoint that remains reachable, with the class that explains
why. "No unexplained Data API request" means every row here has a reason.

| Endpoint | Class | Why |
|---|---|---|
| `search.list type=video` | **FALLBACK** | Primary is InnerTube. Official only when InnerTube is down or returns something unparseable. |
| `search.list type=channel` | **FALLBACK** | Same, for channel discovery. The `UC`-prefix guard is why this cannot return videos. |
| `search.list channelId` | **FALLBACK** | Same, for an artist's uploads tab. |
| `videos.list` | **FALLBACK** | Primary is InnerTube `getInfo`. Official only on primary failure. |
| `channels.list` | **OFFICIAL-DATA-REQUIRED** | InnerTube has no structured channel snippet. The artist name, description and artwork all come from here, and `TrackMatcher` matches on that name. 1 unit, now cached for 6h. |
| `playlists.list` | **OFFICIAL-DATA-REQUIRED** | `youtubei.js@18`'s WEB `Playlist` has no `contents`. Already 1 unit. Now cached. |
| `playlistItems.list` | **OFFICIAL-DATA-REQUIRED** | Same, and the page walk needs `pageToken`/`totalResults`. Already 1 unit. Now cached per token. |
| InnerTube `getInfo` (playback) | **ESSENTIAL** | Stream resolution. Already InnerTube; unchanged except that it now shares the one session. |
| InnerTube `getInfo` (discovery) | **ESSENTIAL** | Primary metadata source. Never cached if it carries a signed URL (§56). |

`tracks.popular`, `tracks.featured`, `tracks.recommendations`, `search.albums`,
`albums.get`, `albums.tracks` remain **not advertised** by the YouTube provider,
so home sections and album pages never reach it and radio's `popularTracks`
avenue stays inert. No `related`-via-InnerTube was added: the provider does not
advertise `tracks.recommendations`, so that would be a new feature rather than
an optimisation.

## What was built

The tier lives at the transport seam, not in the provider. `YouTubeApiTransport`
(`types.ts`) is the existing interface; an InnerTube implementation and a
tiered router both satisfy it, so **`youtube-provider.ts` has zero Phase 55
changes**. Adding a second data source cost one module, not a refactor.

| Concern | Where | Note |
|---|---|---|
| Shared session | `innertube/session.ts` | The only `Innertube.create()`. Asserted by test, not by convention. |
| Shape adapters | `innertube/shapes.ts` | `Video` / `Channel` / `LockupView` / `getInfo` → Data API shapes. Measured, not assumed — see below. |
| Cache | `innertube/cache.ts` | L1 in-flight, L2 memory TTL, negative TTL, `forbids` predicate, prefix invalidation. |
| Telemetry | `innertube/metrics.ts` | One owner per counter. See below. |
| Breaker | `innertube/data-api-circuit.ts` | Per-class open windows; recovery by window expiry, not by success. |
| Primary transport | `innertube/transport.ts` | Discovery over InnerTube, typed search, one deadline per operation, bounded concurrency. |
| Router | `tiered-transport.ts` | The pure `decideSearchSource` gate, and the five-outcome routing table. |
| Official client | `client.ts` | Now circuit-aware, `part=` narrowed to `snippet,contentDetails`. |

## Measured, not assumed: what the library actually returns

This section exists because the first implementation of the primary path was
**wrong in a way that every test agreed with**, and the whole phase therefore
saved no quota while the suite was green. The failure mode is worth recording
precisely, because it is not a subtle one and it was still invisible.

The original adapters were written against a remembered schema — "in v18 the
search results are all `LockupView`" — and the tests were written to match the
adapters. A live `youtubei.js@18.0.0` session says otherwise:

| Call | Rows | Where the rows are | Node family |
|---|---|---|---|
| `yt.search(q, { type: "video" })` | 20 | `.results` | 19 `Video`, 1 `Channel` |
| `yt.search(q, { type: "channel" })` | 20 | `.results` | 20 `Channel` |
| `yt.search(q)` (unfiltered) | 22 | `.results` | + `OfficialCardView`, 2 `GridShelfView` |
| `yt.getChannel(id).getVideos()` | 30 | `current_tab.content.contents` | `RichItem`-wrapped `LockupView` |
| `yt.getInfo(id)` | — | `basic_info` | `author` is a **string**; thumbnails at `basic_info.thumbnail` |

Four defects followed from that gap, each of which alone was enough to send
every request to the official API:

1. **`videoSearchItem` skipped every real search row.** It read
   `content_id`/`metadata` (LockupView) and not `video_id`/`title`/`author`
   (`Video`). It returned `null` rather than throwing — which is correct
   defensive behaviour and exactly why the failure was silent.
2. **`channelSearchItem` had no way to name a channel.** A real `Channel` node
   keeps its display name in `author.name`; the adapter looked for `title` and a
   `metadata` block, found neither, and dropped the row.
3. **`getInfo` lost the channel and the artwork.** `basic_info.author` is a
   plain string, so `asRecord(basic.author)` returned `null` and
   `channelTitle`/`channelId` silently vanished from every hydrated track;
   thumbnails live at `basic_info.thumbnail`, not at the top level.
4. **`nodeListOf` never found the channel tab.** It looked at `contents` and
   `page_contents`; the rows are at `current_tab.content.contents`, each behind
   a `RichItem` wrapper.

And one defect that was not a shape mismatch at all:

5. **`page_contents` throws on a search response.** It is a lazy getter, and in
   `youtubei.js@18.0.0` (`dist/src/core/mixins/Feed.js`) it reads
   `this.#memo.getType(Tab)?.[0].content`. The `?.` guards the index and then
   dereferences anyway; a search has no `Tab` node, so *asking* for
   `page_contents` raises `TypeError: Cannot read properties of undefined
   (reading 'content')` and lost the entire search. The location is now read
   inside its own `try`, because a throwing accessor is a location that does not
   exist rather than a reason to abandon the lookup.

The unfiltered search also returns an `OfficialCardView`, a node v18.0.0 has no
parser for; its JIT recovery then throws the same `TypeError`. Asking InnerTube
for a **typed** result set removes that node, returns only the family being
kept, and roughly halves the latency. The filter is load-bearing, not tidiness.

Why the quality gate did not save this: it did its job perfectly. An empty or
unmappable primary result reads as a parse failure, so the router sent the
request to the official API and users got correct results from a source that
costs quota. The fail-closed design worked; the parsing underneath it did not.
**A fallback that absorbs every primary failure is also a mechanism for hiding
a primary that never worked** — which is why the fix is verified against live
YouTube rather than against fixtures.

Rule adopted: a new fixture in `innertube/__tests__/shapes.test.ts` is added by
capturing a real response, not by describing one.

### Measured result

Official-API request counts, real InnerTube against live YouTube, via the
tiered transport (`scripts/` probe, since removed):

| Workload | InnerTube upstream | Official `search.list` | Time |
|---|---|---|---|
| 10 distinct searches | 10 | **0** | 5798 ms |
| 20 identical searches | 1 (19 cache hits) | **0** | 494 ms |
| 25 concurrent identical searches | 1 (24 dedupe hits) | **0** | 472 ms |

`innertubeShareOfSearch: 1`, `dataApiFallbackRate: 0` throughout. Before the
fix, every row in that table was an official request at 100 units each.

Official-API latency could not be measured in this environment: the configured
`YOUTUBE_API_KEY` is rejected by Google (`400 — API key not valid`), so the
fallback path returns in 63–315 ms with an error rather than a result. That
makes the environment a *harsher* test than production for the primary path —
both sources were failing for most of the phase — and it is why the phase's
behaviour was established from live InnerTube rather than from the fallback.

### Findings worth keeping

**The one-session rule is asserted, not documented.** Both boundary tests count
`Innertube.create(` after stripping comments, and the parent test requires the
constructor count to be exactly one file. A comment explaining the rule by
naming the forbidden call is exactly what a naive grep flags, so the tests strip
comments first — otherwise the explanation of the invariant fails as a violation
of it.

**One owner per counter.** `search.innertube` was being incremented by the
transport's timed wrapper, by the cache's miss path, and by the router's
"primary answered" callback. Six searches reported seven, and
`innertubeShareOfSearch` could not be interpreted at all. The ownership is now
fixed and documented in `metrics.ts`, and `snapshot.requests` reports the two
numbers the phase is judged on — outbound requests and official-API requests —
in the units quota is actually spent in.

**A circuit that refuses all traffic cannot confirm recovery by success.**
`reportSuccess()` closes it early for the transient classes, but the recovery
path for a quota limit is the window expiring and the next call going out as a
half-open probe. Probing a knowingly-exhausted daily budget every few seconds is
the retry storm the breaker exists to prevent; the answer to "has the quota
reset?" is the clock, not another request.

**Two budgets in series are two budgets, not one.** The transport wrapped the
session handshake in a timeout and then wrapped `session().then(search)` in a
second one, so an unreachable primary cost 24 s before the official API was
tried — and because a failed handshake cleared its memo slot, every subsequent
avenue paid it again. A radio station asks for two avenues, so one user request
went from a single API call to roughly a minute. The E2E radio journey is what
caught it: the queue sat on "Finding more tracks…" past its 20 s window. The
rule is now **one deadline per operation, including the handshake**, plus a short
window during which a failed handshake is remembered as failed so a dead primary
is paid for once rather than once per caller. `innertube/__tests__/transport.test.ts`
pins all of it, including that a 50-item metadata batch does not pay the
handshake fifty times.

**Parser breakage is its own failure class.** A `TypeError` from inside the
library means the request succeeded and the *parser* could not read the answer —
retrying will not help, and an operator can act on it (adapt or upgrade). It is
recorded as `innertube_parser_broken` rather than folded into the generic
`innertube_failed` bucket, which mostly means "the network wobbled".


