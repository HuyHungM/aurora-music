# AURORA MUSIC — MUSIC ENGINE MASTER IMPLEMENTATION PROMPT

## 0. AGENT ROLE

You are the principal software engineer responsible for implementing the Aurora Music Engine inside an existing production-grade Next.js/React/TypeScript codebase.

You are NOT starting a new project.

You are NOT allowed to blindly implement a generic music-engine tutorial.

You must first understand the existing Aurora architecture, existing contracts, existing player state, existing persistence model, existing provider abstractions, and existing tests.

Your implementation must fit Aurora.

The final result must feel like a reusable music engine inspired by DisTube's architectural ideas, but adapted for:

- a web application
- browser playback
- Aurora's existing frontend/player architecture
- the existing database/DAL
- authenticated playback state
- multiple metadata providers
- YouTube-based playback resolution

The engine must not become a collection of provider-specific API calls scattered through React components.

---

# 1. EXECUTION CONTRACT

Follow this execution model strictly.

## 1.1 Phase-by-phase execution

The implementation is divided into phases.

You MUST execute only the explicitly requested phase.

For example:

- If the user says `implement Phase 00`, execute Phase 00 only.
- If the user says `implement Phase 03`, execute Phase 03 only.
- Do NOT silently continue into Phase 04.
- Do NOT implement future phases "because they are needed" unless the current phase genuinely cannot function without a tiny compatibility adjustment.

At the end of every phase:

1. Run the required validation.
2. Inspect the resulting diff.
3. Verify architectural invariants.
4. Produce a concise implementation report.
5. Stop.

Do not continue automatically.

---

# 2. SOURCE OF TRUTH

Before modifying code, read and respect:

```text
AGENTS.md
ARCHITECTURE.md
PRODUCT_SPEC.md
package.json
lockfile
.env.example
database schema / Prisma files
existing provider abstractions
existing music/player code
existing Zustand stores
existing server actions / API routes
existing tests
```

The repository itself is authoritative for implementation details.

This prompt defines the intended Music Engine architecture and constraints.

When this prompt conflicts with an existing valid Aurora contract:

1. inspect both carefully;
2. preserve the existing Aurora contract when possible;
3. adapt the new engine around it;
4. only change an existing contract when the current architecture genuinely cannot support the Music Engine;
5. document such changes explicitly.

Never perform a broad rewrite merely to make the code resemble this prompt.

---

# 3. CURRENT PROVIDER STATE — IMPORTANT

The repository has already been cleaned up.

The following are NOT providers anymore and MUST NOT be recreated:

```text
Mock Provider
Mock Extractor
Jamendo
ZingMP3
nvhung9/mp3-api
Audius
```

Do not add them back.

Do not create replacement mock providers.

Do not create temporary fake production providers "just to make the architecture work".

The production Music Engine must contain exactly these three external music sources:

```text
YouTube
Deezer
Spotify
```

And only these three.

---

# 4. PROVIDER RESPONSIBILITIES

## 4.1 YouTube

YouTube is both:

### Metadata/discovery provider

Responsible where supported for:

- search
- track metadata
- artist metadata
- album metadata
- playlist metadata
- related/discovery metadata where supported

### Playback provider

YouTube is the primary playback-resolution source.

It is the final playable provider in Aurora's playback pipeline.

Conceptually:

```text
YouTube Track
    ↓
YouTubeResolver
    ↓
AudioSource
    ↓
Aurora PlaybackController
    ↓
Web Player
```

---

# 5. DEEZER

Deezer is a metadata/discovery provider.

Allowed responsibilities:

- search
- track metadata
- artist metadata
- album metadata
- playlist metadata
- artwork
- catalog discovery
- cross-source matching

Deezer is NOT a direct full-track audio provider.

Never pretend that a Deezer metadata response is itself a playable audio source.

Playback must use TrackMatcher + YouTube resolution.

Conceptually:

```text
Deezer Track
    ↓
TrackMatcher
    ↓
YouTube equivalent
    ↓
YouTubeResolver
    ↓
AudioSource
    ↓
Aurora Web Player
```

---

# 6. SPOTIFY

Spotify is a metadata/discovery provider.

Allowed responsibilities:

- search
- track metadata
- artist metadata
- album metadata
- playlist metadata
- artwork
- catalog discovery
- cross-source matching

Spotify is NOT a direct playback provider in Aurora.

Do NOT use:

```text
Spotify Web Playback SDK
Spotify audio streaming
Spotify MP3 extraction
Spotify direct audio URLs
```

Playback must use:

```text
Spotify metadata
    ↓
TrackMatcher
    ↓
YouTube equivalent
    ↓
YouTubeResolver
    ↓
AudioSource
```

---

# 7. FINAL PROVIDER MATRIX

The production capability model should conceptually be:

| Capability                   | YouTube         | Deezer          | Spotify         |
| ---------------------------- | --------------- | --------------- | --------------- |
| Search                       | YES             | YES             | YES             |
| Track metadata               | YES             | YES             | YES             |
| Artist metadata              | YES             | YES             | YES             |
| Album metadata               | YES             | YES             | YES             |
| Playlist metadata            | YES             | YES             | YES             |
| Artwork                      | YES             | YES             | YES             |
| Discovery/related            | WHERE SUPPORTED | WHERE SUPPORTED | WHERE SUPPORTED |
| Direct playback              | YES             | NO              | NO              |
| Playback resolver            | YES             | NO              | NO              |
| Cross-source matching target | YES             | SOURCE          | SOURCE          |

Do not invent capabilities that an external API does not actually provide.

Optional methods should only exist when the provider genuinely supports them.

---

# 8. CORE ARCHITECTURE

The target architecture is:

```text
MusicEngine
    │
    ├── ExtractorManager
    │       ├── YouTubeExtractor
    │       ├── DeezerExtractor
    │       └── SpotifyExtractor
    │
    ├── TrackNormalizer
    │
    ├── TrackMatcher
    │
    ├── PlaybackResolver
    │       └── YouTubeResolver
    │
    ├── QueueManager
    │
    └── PlaybackController
             │
             ▼
        Aurora Web Player
```

The critical architectural principle is:

```text
Metadata source != Playback source
```

A Spotify or Deezer track does not need to provide the actual audio.

The Music Engine maps metadata tracks into a playable representation.

---

# 9. CANONICAL PLAYBACK ARCHITECTURE

## 9.1 YouTube track

```text
YouTube Track
    ↓
YouTubeResolver
    ↓
AudioSource
    ↓
PlaybackController
    ↓
Aurora Web Player
```

## 9.2 Spotify track

```text
Spotify Track
    ↓
TrackMatcher
    ↓
Equivalent YouTube Track
    ↓
YouTubeResolver
    ↓
AudioSource
    ↓
PlaybackController
    ↓
Aurora Web Player
```

## 9.3 Deezer track

```text
Deezer Track
    ↓
TrackMatcher
    ↓
Equivalent YouTube Track
    ↓
YouTubeResolver
    ↓
AudioSource
    ↓
PlaybackController
    ↓
Aurora Web Player
```

---

# 10. BROWSER PLAYBACK MODEL

Aurora is a web music application.

Unlike Discord-oriented DisTube implementations, there is no Discord Voice connection.

The pipeline is:

```text
Extractor
    ↓
Normalized Track
    ↓
Resolver
    ↓
AudioSource
    ↓
Aurora Backend/API
    ↓
PlaybackController
    ↓
Web Player
    ↓
HTMLAudioElement / browser audio pipeline
```

The frontend player must remain provider-agnostic.

The frontend must NOT understand:

```text
YouTube
Spotify
Deezer
Extractor internals
provider-specific API responses
provider-specific matching rules
provider-specific stream extraction
```

The frontend should understand Aurora's internal abstractions only.

---

# 11. PHASE 00 — READ-ONLY CODEBASE AUDIT

This phase is mandatory before implementation.

Phase 00 MUST make no source-code changes.

## Objective

Understand the existing Aurora application and determine exactly where the Music Engine should integrate.

## Inspect

Read:

```text
AGENTS.md
ARCHITECTURE.md
PRODUCT_SPEC.md
package.json
lockfile
.env.example
Prisma schema
migrations
src/
tests/
scripts/
```

Search the repository for:

```text
MusicProvider
ProviderCapability
Track
Artist
Album
Playlist
AudioSource
SearchResult
PlaybackResolver
PlaybackController
PlayerEngine
PlayerProvider
Extractor
Resolver
Queue
QueueManager
MusicEngine
PlayerStore
PlaybackState
RecentlyPlayed
```

Also inspect:

```text
server actions
API routes
route handlers
Zustand stores
React player components
database repositories
DAL services
authentication boundaries
```

## Provider cleanliness audit

Confirm that production architecture contains:

```text
YouTube
Deezer
Spotify
```

and does NOT contain:

```text
MockProvider
MockExtractor
Jamendo
ZingMP3
nvhung9/mp3-api
Audius
Spotify Web Playback SDK
```

Do not recreate removed code.

Do not perform a cleanup implementation if the repository is already clean.

Only report whether the expected cleanup state is present.

## Audit the existing player

Determine:

- where playback state lives
- how the current player loads audio
- whether there is already an audio engine
- whether HTMLAudioElement already exists
- how seeking works
- how duration is tracked
- how buffering is tracked
- how volume works
- how errors are represented
- how autoplay is handled
- how queue state is stored
- how current track state is stored
- how recent playback is persisted
- how authentication affects persistence

## Audit current provider abstractions

Determine whether Aurora already has:

- provider interfaces
- normalized media types
- capability declarations
- source references
- resolver abstractions
- search abstractions
- provider registries
- provider-specific DTOs

Reuse these whenever appropriate.

## Audit database

Determine whether existing Prisma/DAL models can represent:

- stable provider IDs
- source references
- playlists
- playback state
- recently played items
- user ownership

Do not introduce database migrations unless genuinely required by the requested phase.

## Audit dependencies

Identify:

- existing HTTP clients
- validation libraries
- URL parsers
- media utilities
- state libraries
- testing libraries
- audio libraries
- retry utilities
- logging utilities

Do not install dependencies merely because they are fashionable.

## Deliverable

Produce:

### A. Current architecture map

```text
UI
↓
...
```

### B. Existing contract inventory

List relevant interfaces/types/classes.

### C. Provider matrix

```text
Provider | Search | Metadata | Playback | Existing implementation
```

### D. Player architecture

Explain exactly how current playback works.

### E. Integration strategy

Explain where the Music Engine should connect.

### F. Risks

Identify:

- duplicate architecture risk
- state ownership conflicts
- server/client boundary issues
- hydration risks
- concurrency risks
- persistence conflicts
- provider assumptions
- existing queue assumptions

### G. Migration plan

Show:

```text
existing Aurora component
        ↓
new Music Engine responsibility
        ↓
integration boundary
```

### H. Frozen contracts

List existing contracts that should NOT be casually changed.

Phase 00 then STOPS.

---

# 12. PHASE 01 — DOMAIN CONTRACTS

Create or adapt the core normalized domain model.

Possible concepts:

```text
Track
Artist
Album
Playlist
Artwork
SourceReference
TrackIdentity
AudioSource
SearchResult
```

The exact implementation must fit Aurora.

A conceptual Track model is:

```ts
interface Track {
  id: string;
  title: string;
  artists: Artist[];
  album?: Album;
  durationMs: number;
  artwork?: Artwork;

  source: {
    type: "youtube" | "spotify" | "deezer";
    id: string;
    url?: string;
  };

  playback?: {
    provider: "youtube";
    playable: boolean;
  };
}
```

Do not blindly copy this interface.

Adapt it to existing Aurora contracts.

## Source references

Consider representing a logical track with multiple provider references:

```text
TrackIdentity
    ↓
SourceReference[]
```

For example:

```text
logical track: lac-troi-son-tung
    ├── YouTube video ID
    ├── Spotify track ID
    └── Deezer track ID
```

## AudioSource

Conceptually:

```ts
interface AudioSource {
  url: string;
  mimeType?: string;
  durationMs?: number;
  expiresAt?: Date;
}
```

AudioSource is ephemeral.

Never treat an expiring stream URL as stable track identity.

## Typed errors

Define or adapt errors for:

```text
ProviderError
ExtractorError
NormalizationError
TrackNotFoundError
TrackMatchError
PlaybackResolutionError
PlaybackError
QueueError
```

Keep errors serializable across server/client boundaries.

## Tests

Add tests for:

- valid track
- source identity
- optional playback information
- AudioSource expiry
- malformed provider data
- invalid normalized values
- provider-safe serialization

STOP after validation.

---

# 13. PHASE 02 — EXTRACTOR CONTRACT + EXTRACTOR MANAGER

Implement or adapt the extractor abstraction.

Conceptually:

```ts
interface Extractor {
  readonly name: string;

  validate(input: string): boolean;

  search(query: string): Promise<SearchResult>;

  getTrack(identifier: string): Promise<Track | null>;

  getPlaylist(identifier: string): Promise<Playlist | null>;

  getAlbum?(identifier: string): Promise<Album | null>;

  getArtist?(identifier: string): Promise<Artist | null>;
}
```

Playable extractors should be separate from metadata-only extractors.

Conceptually:

```ts
interface PlayableExtractor extends Extractor {
  resolve(track: Track): Promise<AudioSource>;
}
```

Do NOT force Spotify and Deezer to implement playback.

## ExtractorManager responsibilities

- provider registration
- provider lookup
- input validation
- URL detection
- plain-text search fan-out
- provider failure isolation
- result normalization
- deduplication hooks
- capability-aware dispatch

Production registry:

```text
YouTubeExtractor
DeezerExtractor
SpotifyExtractor
```

Nothing else.

## Search fan-out

For:

```text
Lạc Trôi
```

run:

```text
YouTube
Deezer
Spotify
```

then:

```text
provider results
    ↓
normalize
    ↓
deduplicate
    ↓
unified SearchResult[]
```

One provider failing should not automatically destroy the entire search result when partial results are valid.

Implement typed partial-failure handling.

## URL detection

Recognize:

```text
youtube.com/...
youtu.be/...

open.spotify.com/track/...
open.spotify.com/album/...
open.spotify.com/playlist/...

deezer.com/track/...
deezer.com/album/...
deezer.com/playlist/...
```

Do not hardcode provider logic inside React components.

## Tests

Test:

- provider registration
- duplicate registration
- lookup
- URL detection
- plain text search
- provider failures
- partial results
- malformed URLs
- unsupported URLs
- provider-independent dispatch

STOP after validation.

---

# 14. PHASE 03 — YOUTUBE EXTRACTOR

Implement the real YouTube extractor using the existing project's approved dependency/network strategy.

Responsibilities:

```text
search
getTrack
getPlaylist
getAlbum where actually supported
getArtist where actually supported
resolve/playback source
```

Do not invent unsupported API behavior.

## Normalization

Convert YouTube responses into Aurora's normalized model.

The rest of Aurora must not consume raw YouTube DTOs.

## Playback

The resolver must produce a fresh AudioSource at play time.

Never persist temporary stream URLs.

Stable identity should remain:

```text
YouTube videoId
```

## Resolution requirements

Handle:

- unavailable videos
- deleted videos
- private videos
- age restrictions where detectable
- invalid media
- provider rate limits
- transient failures
- expired sources
- resolution timeout

Use typed errors.

## Tests

Use deterministic provider-response fixtures or isolated test doubles only inside test infrastructure.

Do NOT create a MockProvider in production.

Cover:

- valid search
- track lookup
- playlist lookup
- invalid response
- unavailable media
- successful resolution
- failed resolution
- source expiry handling

STOP after validation.

---

# 15. PHASE 04 — DEEZER EXTRACTOR

Implement Deezer as a metadata-only extractor.

Responsibilities:

```text
search
getTrack
getPlaylist
getAlbum
getArtist
artwork
```

Do NOT implement direct Deezer playback.

Do NOT fabricate AudioSource from metadata.

Do NOT add a `resolve()` method unless an existing abstraction makes it optional and the implementation does not pretend Deezer is playable.

Normalize:

```text
title
artists
album
duration
artwork
source ID
source URL
```

Preserve enough metadata for TrackMatcher.

Tests must cover:

- search
- track
- album
- playlist
- artist
- malformed responses
- missing artwork
- missing album
- missing artist
- duration normalization
- unavailable tracks

STOP after validation.

---

# 16. PHASE 05 — SPOTIFY EXTRACTOR

Implement Spotify as a metadata-only extractor.

Responsibilities:

```text
search
getTrack
getAlbum
getArtist
getPlaylist
artwork
catalog discovery
```

Never use:

```text
Spotify Web Playback SDK
Spotify streaming playback
Spotify MP3 extraction
```

Normalize Spotify responses into Aurora's internal models.

Preserve metadata required by TrackMatcher:

```text
track title
artists
album
duration
artwork
explicit state where available
version information where available
stable Spotify track ID
```

Tests must cover:

- search
- track
- album
- playlist
- artist
- malformed data
- missing metadata
- normalization

STOP after validation.

---

# 17. PHASE 06 — TRACK NORMALIZATION + CROSS-SOURCE DEDUPLICATION

Implement the normalization layer.

The entire Aurora application should consume normalized models rather than raw provider responses.

## Normalize

Handle:

- title normalization
- whitespace
- punctuation
- Unicode
- Vietnamese text
- artist names
- album names
- duration
- artwork
- explicit state
- source identifiers
- URLs

Be careful with Vietnamese music.

Normalization MUST NOT destroy meaningful distinctions.

Do not over-normalize titles.

## Version indicators

Detect meaningful tokens such as:

```text
remix
live
acoustic
instrumental
karaoke
cover
sped up
slowed
nightcore
radio edit
extended
demo
version
```

Do not automatically erase these indicators.

They are important for matching correctness.

## Cross-source deduplication

Example:

```text
YouTube: Lạc Trôi
Spotify: Lạc Trôi
Deezer: Lạc Trôi
```

should be representable as one logical identity when confidence is sufficient.

Potential model:

```text
TrackIdentity
    ↓
SourceReference[]
```

Never merge tracks merely because titles look similar.

Tests must cover:

- exact same track
- same track with punctuation differences
- different artists
- same artist but different song
- remix vs original
- live vs studio
- cover vs original
- clean vs explicit
- duplicate provider result

STOP after validation.

---

# 18. PHASE 07 — TRACK MATCHER

Implement the dedicated TrackMatcher.

This is one of the most important components.

Purpose:

```text
Spotify/Deezer metadata
        ↓
find best matching playable YouTube track
```

## Matching signals

Consider:

- normalized title
- normalized artists
- artist ordering
- duration difference
- album
- version indicators
- live/remix/acoustic status
- explicit/clean metadata
- YouTube title
- YouTube description/metadata where available
- source URL/video metadata
- confidence score

## Hard rejection conditions

Do NOT accept a match merely because a title is similar.

Reject or heavily penalize:

```text
remix
live
acoustic
cover
karaoke
instrumental
sped-up
slowed
nightcore
fan edit
unofficial alternate version
```

when the requested source indicates the original/studio version.

Likewise, do not turn an explicit/clean mismatch into a silent substitution when the distinction matters.

## Confidence

Use a deterministic confidence model.

Conceptually:

```text
title score
artist score
duration score
album score
version score
metadata score
----------------
final confidence
```

Define a minimum threshold.

Below the threshold:

```text
NO MATCH
```

rather than returning a suspicious video.

## Tests

Include realistic Vietnamese examples.

Test:

- exact match
- punctuation difference
- accent differences
- artist alias
- featuring artists
- duration tolerance
- remix rejection
- live rejection
- cover rejection
- karaoke rejection
- sped-up rejection
- unrelated same-title tracks
- low confidence
- no match

STOP after validation.

---

# 19. PHASE 08 — PLAYBACK RESOLVER

Implement the unified playback-resolution layer.

## Required flows

### YouTube

```text
Track
 ↓
YouTubeResolver
 ↓
AudioSource
```

### Spotify

```text
Spotify Track
 ↓
TrackMatcher
 ↓
YouTube Track
 ↓
YouTubeResolver
 ↓
AudioSource
```

### Deezer

```text
Deezer Track
 ↓
TrackMatcher
 ↓
YouTube Track
 ↓
YouTubeResolver
 ↓
AudioSource
```

## Critical rule

Resolution happens at play time.

Never persist:

```text
temporary stream URL
signed URL
expiring media URL
session playback URL
```

Persist stable identities only.

Examples:

```text
YouTube videoId
Spotify trackId
Deezer trackId
```

## Errors

Differentiate:

```text
track not found
track not playable
match failed
resolver failed
provider unavailable
source expired
network error
```

Retry only errors that are actually retryable.

Do not blindly retry permanent failures.

## Tests

Test every provider path.

STOP after validation.

---

# 20. PHASE 09 — QUEUE MANAGER

Integrate with the EXISTING queue implementation.

Do NOT create a second queue system if Aurora already has one.

Queue operations must support or adapt:

```text
add
remove
move
clear
next
previous
shuffle
repeat-one
repeat-all
no-repeat
history
```

Conceptually:

```ts
interface QueueItem {
  track: Track;
  addedBy?: User;
  addedAt: Date;
}
```

The exact shape must match Aurora's architecture.

## Queue invariants

Guarantee:

- no accidental duplicate current-track state
- index correctness
- reorder correctness
- previous behavior correctness
- repeat-one correctness
- repeat-all correctness
- queue-end behavior
- shuffle consistency
- empty queue safety

Test state transitions thoroughly.

STOP after validation.

---

# 21. PHASE 10 — PLAYBACK CONTROLLER

The PlaybackController is the bridge between the engine and Aurora's existing player.

Do NOT create a second audio engine.

The existing player remains the final browser playback layer unless Phase 00 proves it cannot support the required architecture.

Conceptually:

```text
MusicEngine
    ↓
PlaybackResolver
    ↓
AudioSource
    ↓
PlaybackController
    ↓
Existing Aurora Player
```

PlaybackController should handle:

```text
load
play
pause
resume
stop
seek
volume
track transition
source expiration
playback errors
```

Keep browser-specific code at the appropriate boundary.

The core engine should not depend on React components.

STOP after validation.

---

# 22. PHASE 11 — MUSIC ENGINE ORCHESTRATOR

Implement the top-level MusicEngine.

The API should be inspired by:

```ts
music.play(input);

music.pause();
music.resume();
music.stop();

music.skip();
music.previous();

music.seek(seconds);
music.setVolume(volume);

music.shuffle();

music.setRepeat("off");
music.setRepeat("track");
music.setRepeat("queue");

music.queue.add(track);
music.queue.remove(index);
music.queue.move(from, to);
music.queue.clear();
```

Adapt names and semantics to existing Aurora contracts.

## MusicEngine responsibilities

The engine should orchestrate:

```text
input detection
provider selection
search
track lookup
normalization
matching
playback resolution
queue
playback controller
events
errors
```

The engine should NOT directly manipulate React components.

## Input handling

Support:

### Provider URLs

```text
YouTube URL
Spotify track URL
Spotify album URL
Spotify playlist URL
Deezer track URL
Deezer album URL
Deezer playlist URL
```

### Plain text

Example:

```text
Lạc Trôi
```

Search across:

```text
YouTube
Deezer
Spotify
```

and return unified results.

---

# 23. PHASE 12 — MUSIC ENGINE EVENTS

Implement or integrate engine events:

```text
trackStart
trackEnd
trackError
queueEnd
error
```

Additional events may include:

```text
trackLoading
trackResolved
queueUpdated
playbackStarted
playbackPaused
playbackStopped
```

but only when they fit the existing architecture.

Events must have typed payloads.

Do not emit provider-specific UI events.

For example, avoid:

```text
youtubeTrackStarted
spotifyTrackStarted
deezerTrackStarted
```

Prefer:

```text
trackStart
```

with source metadata inside the normalized event payload.

---

# 24. PHASE 13 — SEARCH INTEGRATION

Connect the new source-aware search engine to Aurora's search layer.

Flow:

```text
User query
    ↓
MusicEngine / ExtractorManager
    ↓
YouTube
Deezer
Spotify
    ↓
Normalize
    ↓
Deduplicate
    ↓
Unified results
    ↓
UI
```

The UI must not call provider APIs directly.

Bad:

```text
SearchPage → Spotify API
SearchPage → YouTube API
SearchPage → Deezer API
```

Good:

```text
SearchPage
    ↓
Aurora search boundary
    ↓
MusicEngine
    ↓
Provider layer
```

Provider-specific logic remains inside the engine.

---

# 25. PHASE 14 — COLLECTION PLAYBACK

Support playback of external collections.

Collections may include:

```text
YouTube playlists
Spotify playlists
Deezer playlists
albums
artist-derived collections
```

The engine should convert them into normalized tracks.

Example:

```text
Spotify Playlist
    ↓
SpotifyExtractor
    ↓
Track[]
    ↓
TrackMatcher when needed
    ↓
Queue
    ↓
Playback
```

Do not confuse external provider playlists with Aurora-owned playlists.

Aurora-owned playlists remain Aurora domain entities.

External collections remain source-derived entities.

Do not rewrite existing playlist functionality unnecessarily.

---

# 26. PHASE 15 — PERSISTENT PLAYBACK INTEGRATION

Integrate Music Engine behavior with Aurora's existing playback persistence.

Important:

Persist stable state only.

Examples:

```text
track identity
provider/source IDs
queue state where existing Aurora architecture allows it
position
user ownership
timestamps
```

Do NOT persist temporary:

```text
stream URL
signed media URL
expiring resolver output
provider session URL
```

When restoring playback:

```text
persisted stable identity
    ↓
resolve fresh source
    ↓
play
```

If a previously persisted track can no longer be resolved:

```text
do not crash
do not loop endlessly
do not reuse stale URL
```

Handle the stale state explicitly.

Preserve all existing account-isolation and persistence guarantees.

---

# 27. PHASE 16 — RECENTLY PLAYED + EVENT INTEGRATION

Integrate track lifecycle with existing recently-played functionality.

Do not create a second recently-played system.

Use the existing:

- qualification rules
- DAL
- server actions
- persistence
- authentication

The Music Engine should emit enough lifecycle information for the existing application layer to record playback.

Do not persist every transient event.

Respect existing qualification thresholds.

---

# 28. PHASE 17 — CONCURRENCY + FAILURE HARDENING

This phase focuses on production reliability.

Audit for:

## Race conditions

Examples:

```text
user skips while resolving
user clicks play twice
user seeks during source load
queue changes while track is resolving
old resolver completes after new track selected
```

Implement cancellation/generation/token protection where appropriate.

## Stale async results

Example:

```text
Track A starts resolving
Track B starts resolving
Track A finishes late
Track A must NOT overwrite Track B
```

## Provider failure

A provider failure should not unnecessarily crash unrelated functionality.

Examples:

```text
Spotify unavailable
    ↓
YouTube search may still work
```

```text
Deezer unavailable
    ↓
YouTube and Spotify search may continue
```

## Match failure

```text
Spotify track
    ↓
No sufficiently confident YouTube match
```

must become a controlled failure.

Do not play a random approximate result.

## Playback failure

Handle:

- network failure
- expired URL
- unsupported media
- browser playback rejection
- source resolution failure
- provider failure

without corrupting queue state.

---

# 29. PHASE 18 — PROVIDER-INDEPENDENCE AUDIT

Perform a dedicated architectural audit.

Search for provider-specific logic leaking into:

```text
React components
hooks
pages
layout
player UI
queue UI
playlist UI
generic search UI
shared domain components
```

Especially search for patterns like:

```ts
if (provider === "youtube") ...
if (provider === "spotify") ...
if (provider === "deezer") ...
```

These are not automatically wrong.

The question is WHERE they exist.

Provider-specific behavior belongs in:

```text
extractors
resolvers
matcher
engine
provider adapters
```

not in generic UI behavior.

The frontend should ask Aurora-level questions:

```text
Can this track be played?
Play this track.
Add this track to queue.
Open this album.
Open this artist.
```

not:

```text
How do I play a Spotify track?
How do I resolve a YouTube URL?
How do I search Deezer?
```

---

# 30. PHASE 19 — ARCHITECTURAL STRUCTURE AUDIT

Conceptual structure:

```text
src/
└── music/
    ├── engine/
    │   ├── MusicEngine.ts
    │   ├── QueueManager.ts
    │   ├── PlaybackManager.ts
    │   ├── PlaybackController.ts
    │   ├── ExtractorManager.ts
    │   └── TrackMatcher.ts
    │
    ├── extractors/
    │   ├── youtube/
    │   │   ├── YouTubeExtractor.ts
    │   │   └── ...
    │   │
    │   ├── deezer/
    │   │   ├── DeezerExtractor.ts
    │   │   └── ...
    │   │
    │   └── spotify/
    │       ├── SpotifyExtractor.ts
    │       └── ...
    │
    ├── resolvers/
    │   └── youtube/
    │       ├── YouTubeResolver.ts
    │       └── ...
    │
    ├── models/
    │   ├── Track.ts
    │   ├── Artist.ts
    │   ├── Album.ts
    │   ├── Playlist.ts
    │   ├── AudioSource.ts
    │   └── SearchResult.ts
    │
    └── events/
        └── MusicEvents.ts
```

This is NOT a command to create this exact structure.

Inspect Aurora first.

Reuse existing directories and abstractions where appropriate.

Do not create duplicate concepts such as:

```text
src/music/Track.ts
src/domain/music/Track.ts
src/player/Track.ts
src/providers/Track.ts
```

unless there is an explicit architectural reason.

Prefer one canonical domain model.

---

# 31. DATABASE RULES

Never store temporary playback URLs permanently.

Never use stream URLs as stable identity.

Stable provider identifiers may be persisted.

Examples:

```text
YouTube videoId
Spotify trackId
Deezer trackId
```

Database models should represent durable application state.

Playback resolver output is ephemeral.

Do not create unnecessary migrations.

Before any schema change, prove why the current model cannot support the requirement.

---

# 32. ENVIRONMENT CONFIGURATION

Provider configuration must follow the existing Aurora conventions.

Do not leak secrets into:

```text
client components
public environment variables
browser bundles
serialized props
```

Keep server-only credentials server-side.

Do not introduce provider configuration that is not required.

Do not leave legacy:

```text
Jamendo
ZingMP3
Mock provider
Audius
```

environment variables behind as active configuration.

Because the old providers have already been removed, this is an audit requirement rather than a migration feature.

---

# 33. TESTING POLICY

Testing must be comprehensive.

## Unit tests

Test:

```text
normalization
matching
URL detection
provider selection
deduplication
queue transitions
repeat modes
resolver behavior
typed errors
event emission
```

## Integration tests

Test:

```text
search
provider orchestration
Spotify → YouTube matching
Deezer → YouTube matching
YouTube playback resolution
queue → playback
player integration
```

## Test infrastructure rule

Do NOT recreate a production MockProvider.

Test infrastructure may use:

```text
fixtures
deterministic response payloads
dependency injection
HTTP interception
isolated test doubles
```

but these MUST remain test-only.

Never register them in the production provider registry.

## Regression testing

Never delete existing tests merely because the implementation changed.

When contracts change:

1. update tests deliberately;
2. preserve behavioral coverage;
3. explain contract changes in the phase report.

---

# 34. PERFORMANCE REQUIREMENTS

Avoid unnecessary provider calls.

Search should support controlled concurrency.

Do not serialize:

```text
YouTube
then Deezer
then Spotify
```

unless there is a concrete reason.

Prefer parallel execution with failure isolation when safe.

Do not repeatedly resolve the same playback source unnecessarily.

Do not run expensive matching logic repeatedly for the same track within a single flow when caching can safely help.

Do not introduce permanent cache semantics for temporary stream URLs.

---

# 35. SECURITY REQUIREMENTS

Provider credentials must remain server-side.

Validate external API responses before normalization.

Treat provider responses as untrusted external data.

Validate:

```text
IDs
URLs
durations
titles
artists
album data
playlist data
artwork URLs
stream URLs
```

Never trust provider input simply because it came from a known provider.

Do not allow provider data to inject arbitrary application state.

Do not expose secret API keys in client bundles.

---

# 36. OBSERVABILITY

The Music Engine should make failures diagnosable.

Logs/errors should identify useful context such as:

```text
operation
provider
stable track ID
query
failure category
retryability
resolution stage
```

Do not log:

```text
API secrets
tokens
private credentials
unnecessary personal data
```

Avoid noisy logs during normal playback.

---

# 37. HARD ARCHITECTURAL INVARIANTS

These invariants MUST remain true after implementation.

## INVARIANT 1 — Exactly three production music providers

```text
YouTube
Deezer
Spotify
```

## INVARIANT 2 — Only YouTube provides playback resolution

```text
Spotify ─┐
         ├→ TrackMatcher → YouTubeResolver → AudioSource
Deezer ──┘

YouTube ───────────────→ YouTubeResolver → AudioSource
```

## INVARIANT 3 — No Spotify Web Playback SDK

Never introduce it.

## INVARIANT 4 — No Deezer direct playback assumption

Metadata only.

## INVARIANT 5 — No temporary URL persistence

Temporary playback URLs remain ephemeral.

## INVARIANT 6 — UI is provider-agnostic

Provider-specific logic stays below the application boundary.

## INVARIANT 7 — One queue system

Do not create duplicate queue state.

## INVARIANT 8 — One playback engine

Do not create a second browser audio architecture.

## INVARIANT 9 — Normalized domain models

The application must not consume raw provider DTOs directly.

## INVARIANT 10 — No random fallback matching

A low-confidence match is a failed match.

## INVARIANT 11 — Existing Aurora architecture remains intact

The Music Engine integrates with Aurora; it does not replace Aurora.

---

# 38. FORBIDDEN IMPLEMENTATION PATTERNS

Do NOT:

```text
create a second player
create a second queue
create a second Track model without justification
call provider APIs directly from React components
store temporary media URLs
use Spotify Web Playback SDK
treat Spotify as an audio provider
treat Deezer as an audio provider
reintroduce Jamendo
reintroduce ZingMP3
reintroduce nvhung9/mp3-api
reintroduce Audius
reintroduce MockProvider
scatter provider-specific conditionals throughout UI
copy provider DTOs into the database
rewrite unrelated Aurora features
perform broad migrations without evidence
silently weaken existing tests
use approximate track matching below the configured confidence threshold
```

---

# 39. CODE QUALITY RULES

Prefer:

```text
small cohesive modules
explicit contracts
typed boundaries
deterministic behavior
dependency injection where appropriate
clear error types
testable pure functions
single responsibility
```

Avoid:

```text
god classes
provider-specific spaghetti
global mutable state
hidden network calls
implicit fallbacks
magic numbers
duplicate normalization algorithms
duplicate queue logic
duplicate playback state
```

Document non-obvious algorithms.

Especially document:

```text
matching score
confidence threshold
duration tolerance
version penalties
retry policy
resolver expiration handling
queue transition semantics
```

---

# 40. IMPLEMENTATION DISCIPLINE

For every phase:

## STEP 1

Inspect the repository state.

## STEP 2

Identify existing contracts relevant to the phase.

## STEP 3

Determine the smallest architectural change required.

## STEP 4

Implement.

## STEP 5

Write/update tests.

## STEP 6

Run targeted tests.

## STEP 7

Run TypeScript checks.

## STEP 8

Run lint.

## STEP 9

Run build if appropriate.

## STEP 10

Inspect git diff.

## STEP 11

Search for forbidden patterns introduced by the change.

## STEP 12

Verify phase acceptance criteria.

## STEP 13

Stop.

---

# 41. VALIDATION GATES

Depending on the project scripts, use the repository's actual commands.

At minimum, when applicable:

```text
typecheck
lint
unit tests
integration tests
database tests
build
```

Do not fabricate commands.

Inspect `package.json` first.

If a validation gate cannot run:

1. state exactly why;
2. do not pretend it passed;
3. continue with the remaining valid gates.

---

# 42. GIT / DIFF DISCIPLINE

Before finishing a phase:

Inspect:

```text
git status
git diff
git diff --stat
```

Verify:

- no accidental unrelated file edits
- no generated garbage
- no secrets
- no temporary files
- no provider reintroduction
- no duplicate architecture
- no accidental migration
- no test deletion without reason

Keep the diff focused on the requested phase.

---

# 43. FINAL PRE-PHASE CHECK

Before starting implementation in ANY phase after Phase 00, verify:

```text
[ ] YouTube remains supported
[ ] Deezer remains metadata-only
[ ] Spotify remains metadata-only
[ ] YouTube remains the playback resolver
[ ] Mock Provider is not present in production
[ ] Jamendo is not present
[ ] ZingMP3 is not present
[ ] nvhung9/mp3-api is not present
[ ] Audius is not present
[ ] Spotify Web Playback SDK is not present
[ ] UI remains provider-agnostic
[ ] existing player architecture is preserved
[ ] existing queue architecture is preserved
[ ] existing persistence contracts are preserved
```

If any invariant is unexpectedly violated by pre-existing code, do not silently "fix everything".

Report it and adapt the phase implementation safely.

---

# 44. PHASE ORDER

The intended implementation order is:

```text
PHASE 00 — Read-only Codebase Audit
    ↓
PHASE 01 — Domain Contracts
    ↓
PHASE 02 — Extractor Interface + ExtractorManager
    ↓
PHASE 03 — YouTube Extractor + Resolver
    ↓
PHASE 04 — Deezer Extractor
    ↓
PHASE 05 — Spotify Extractor
    ↓
PHASE 06 — Track Normalization + Deduplication
    ↓
PHASE 07 — TrackMatcher
    ↓
PHASE 08 — PlaybackResolver
    ↓
PHASE 09 — QueueManager Integration
    ↓
PHASE 10 — PlaybackController Integration
    ↓
PHASE 11 — MusicEngine Orchestration
    ↓
PHASE 12 — Engine Events
    ↓
PHASE 13 — Unified Search Integration
    ↓
PHASE 14 — Collection Playback
    ↓
PHASE 15 — Persistent Playback Integration
    ↓
PHASE 16 — Recently Played Integration
    ↓
PHASE 17 — Concurrency + Failure Hardening
    ↓
PHASE 18 — Provider Independence Audit
    ↓
PHASE 19 — Final Architecture + Full Integration Audit
```

Do not skip dependency-critical phases without explaining why an existing Aurora implementation already satisfies them.

---

# 45. FINAL ACCEPTANCE CRITERIA

The Music Engine is considered complete only when all of the following are true.

## Provider architecture

```text
YouTube
Deezer
Spotify
```

are the only production external providers.

## Playback

A YouTube track can resolve to playable AudioSource.

A Spotify track can:

```text
Spotify metadata
→ match
→ YouTube
→ resolve
→ play
```

A Deezer track can:

```text
Deezer metadata
→ match
→ YouTube
→ resolve
→ play
```

## Search

A normal query can fan out across all three providers and return normalized unified results.

## URLs

The engine detects:

```text
YouTube URLs
Spotify track/album/playlist URLs
Deezer track/album/playlist URLs
```

## Normalization

The rest of Aurora does not depend on raw provider DTOs.

## Matching

Incorrect versions such as:

```text
live
remix
cover
karaoke
sped-up
slowed
```

are not casually accepted as substitutes.

## Queue

Queue state remains correct across:

```text
add
remove
move
next
previous
shuffle
repeat
clear
```

## Playback

There is exactly one authoritative browser playback architecture.

## Persistence

Temporary stream URLs are never persisted.

## UI

React components do not contain provider-specific playback logic.

## Reliability

Provider failures, matching failures and playback failures are controlled and typed.

## Tests

Relevant unit/integration/regression tests pass.

## Build

Production build passes.

## Architecture

No duplicate music engine architecture exists.

No obsolete provider has been reintroduced.

---

# 46. REQUIRED FINAL REPORT FORMAT

After each phase, report using this structure:

```text
## PHASE
<phase number + name>

## STATUS
PASS / BLOCKED / PARTIAL

## IMPLEMENTED
- ...
- ...
- ...

## FILES CHANGED
- ...
- ...
- ...

## ARCHITECTURE IMPACT
- ...
- ...

## TESTS
- ...
- ...

## VALIDATION
- Typecheck: PASS/FAIL
- Lint: PASS/FAIL
- Unit tests: PASS/FAIL
- Integration tests: PASS/FAIL
- Build: PASS/FAIL

## PROVIDER INVARIANT CHECK
- YouTube: PASS
- Deezer metadata-only: PASS
- Spotify metadata-only: PASS
- YouTube playback resolver: PASS
- Mock Provider absent: PASS
- Jamendo absent: PASS
- ZingMP3 absent: PASS
- Audius absent: PASS
- Spotify Web Playback SDK absent: PASS

## RISKS / FOLLOW-UPS
- ...

## STOPPED AT
<phase>
```

Do not claim PASS if a validation gate actually failed.

---

# 47. MOST IMPORTANT RULE

Before writing code, understand the repository.

Before changing architecture, understand existing architecture.

Before adding a new abstraction, search for an existing equivalent.

Before creating a new state store, search for an existing source of truth.

Before adding a database model, inspect the existing DAL and Prisma schema.

Before adding a new dependency, inspect current dependencies.

Before changing playback, inspect the existing player.

Before changing queue behavior, inspect the existing queue.

Before changing persistence, inspect the existing persistence contracts.

Before changing provider behavior, inspect the existing provider abstraction.

The goal is NOT to make Aurora look like the architecture in this prompt.

The goal is to make Aurora's existing architecture capable of cleanly supporting this Music Engine.

---

# 48. STARTING INSTRUCTION

When this master prompt is given to you, DO NOT immediately implement the entire Music Engine.

First determine which phase the user explicitly requested.

If no specific phase is given, start with:

```text
PHASE 00 — READ-ONLY CODEBASE AUDIT
```

Phase 00 must be read-only.

Do not modify source code during Phase 00.

After Phase 00, stop and present the audit.

For all later phases, implement only that phase, validate it thoroughly, report the result, and stop.

The final architectural target is:

```text
                    ┌──────────────────┐
                    │    MusicEngine   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ ExtractorManager │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
         YouTube         Deezer         Spotify
              │              │              │
              │         metadata only      │
              │              │              │
              └──────────────┼──────────────┘
                             ▼
                     TrackNormalizer
                             │
                             ▼
                       TrackMatcher
                             │
                 Spotify/Deezer → YouTube
                             │
                             ▼
                    YouTubeResolver
                             │
                             ▼
                        AudioSource
                             │
                             ▼
                  PlaybackController
                             │
                             ▼
                    Aurora Web Player
                             │
                             ▼
                     HTMLAudioElement
```

The engine must remain:

```text
provider-independent at the UI layer
metadata/playback separated
queue-aware
resolver-driven
testable
failure-tolerant
persistent-state-safe
compatible with existing Aurora architecture
```

And the ONLY production music providers are:

```text
YouTube
Deezer
Spotify
```
