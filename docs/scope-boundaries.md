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
- Offline music / downloads
- Lyrics display (only the `explicit_lyrics` boolean is mapped)
- Social features (comments, feeds, activity)
- Collaborative playlists / playlist privacy / sharing
- Upload-based cover management (artwork is a URL field only)
- Payments / subscriptions
- Analytics / external telemetry
- Live radio / live streams (resolver rejects live/upcoming)
- Equalizer / sleep timer / crossfade / gapless playback
- New providers beyond YouTube / Deezer / Spotify
- Queue history navigation across sessions
- Autoplay / related-track insertion

## Deliberately partial features

- **Radio:** static catalog preview only. Mood stations are hard-coded
  labels; live audio streaming is explicitly disclaimed on the page.
- **Playlist artwork UI:** URL field only.
- **Install/update UX:** manifest + service-worker registration only; no
  update or install prompt UI.

## Deferred (not scheduled)

Mood stations, live radio streaming, and any item under non-goals above
are deferred without a scheduled phase. Converting a deferred item into
work requires a new phase authorization — this file never authorizes it.

## Dependency audit baseline (Phase 31)

- Baseline: `npm audit` recorded; known advisories triaged as accepted or
  scheduled. Gate fails closed on new high/critical advisories outside the
  baseline until re-triaged.
- Lockfile canonical (`package-lock.json`); no Bun/pnpm/Yarn migration.
- `youtubei.js` pinned at 18.0.0; upgrades require re-running format
  validation and live playback verification.

## Stale scaffold cleanup (Phase 31)

- Stock `create-next-app` scaffold wording removed where it contradicted
  implemented behavior; remaining generic README text carries no product
  meaning (see `ARCHITECTURE.md` unresolved-conflicts log for the one known
  stale UI copy item).
