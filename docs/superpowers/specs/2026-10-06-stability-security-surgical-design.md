# Stability + Security (Surgical, no migration) — Design Spec

- Date: 2026-10-06
- Status: proposed (awaiting owner review)
- Scope: read-only review findings → one surgical implementation slice
- Priority source: owner chose "Ổn định + Bảo mật", approach "Surgical, không migration"
- Doc rule: the implementation change that follows this spec updates `PRODUCT_SPEC.md`
  and/or `ARCHITECTURE.md` in the same change when it alters observable behavior
  (per `AGENTS.md` documentation rule). This spec file itself changes no behavior.

## 1. Shared understanding

**Intent.** Close the stability + security findings that can fail a real playlist
edit or leak data, with the smallest diff that holds: no new migration, no CSP
change, no quota/a11y work. The deferred backlog (InnerTube gate, resolve-link
fan-out, circuit breaker, DAL pagination, CI build-before-typecheck, audit gate,
live-region/a11y/PWA, dep bumps, observability) stays untouched in later slices.

**Constraints.**

- No new Prisma migration; `playback-schema.test.ts` allowlist untouched.
- No CSP change (`img-src` stays as-is; Deezer/Spotify artwork keeps working).
- No new user-facing error copy; `preservePlayback` semantics unchanged.
- Bun is the runtime (`bun run …`); behavior changes ship with doc updates.

**Success criteria.**

- Concurrent/edge-case playlist reorder never surfaces raw `P2002`
  `PlaylistTrack_playlistId_position_key` for the covered shapes.
- No check-then-act ownership window on playlist mutations; error semantics
  (`ResourceNotFoundError` vs `AuthorizationError`) preserved.
- No `http:` artwork persisted; no `Referer` leaked by artwork renders.
- Prod boot without `AURORA_PUBLIC_URL` fails closed (E2E harness exempt).
- Crafted/legacy `provider: "local"` snapshot entries never restore.
- A fourth production provider id cannot register outside tests.

## 2. Approaches considered

- **A. Surgical, no migration (chosen).** Temp-negative-range reorder in one tx,
  atomic `where: { id, userId }` ownership, tx-wrapped trim, zod tightening,
  `https:`-only playlist artwork + `referrerpolicy` at the single `Artwork`
  primitive, prod `PUBLIC_URL` boot guard, one-condition snapshot/registry
  guards. Smallest diff, no migration history rewrite.
- **B. Constraint-first, with migration.** `DEFERRABLE INITIALLY DEFERRED` on
  `@@unique([playlistId, position])` + `CHECK (visibility IN …)`. Correct
  by construction under concurrency, but needs a production migration, a
  `playback-schema.test.ts` allowlist + rollback analysis update, and a full
  `playlist.db.test.ts` run (~13 min against Aiven). Rejected for this slice.
- **C. Phased A then B.** Do A now, schedule the migration after measuring real
  collision rates. Rejected as a separate decision: B stays a future option,
  not a commitment of this slice.

## 3. Scope and non-goals

**In scope (7 workstreams, §4).**

1. Reorder temp-range (`src/lib/dal/playlist.ts`).
2. Atomic ownership (`src/lib/dal/playlist.ts`).
3. Atomic search-history trim (`src/lib/dal/search-history.ts`).
4. Input validation (`src/lib/validation/schemas.ts`).
5. Artwork write + render (`schemas.ts`, `src/components/ui/artwork.tsx`).
6. Prod origin boot guard (`src/lib/config/env.ts`, docs).
7. Snapshot + registry guards (`src/lib/player/queue-snapshot.ts`,
   `src/lib/providers/registry.ts`).

**Non-goals.** Quota/perf (InnerTube gate breadth, resolve-link fan-out cap,
breaker on `reportOtherFailure`, `fetchHomeSection` capability path, DAL
pagination, `recordPlayed` RTs), CI/toolchain (build-before-typecheck, `bun
audit`, db env drift, e2e self-skip), UX/a11y/PWA (live regions, targets,
menu keys, focus restore, motion vocab, tokens, SW locale), dep bumps,
observability endpoints, catalog `http:` tightening (deferred: provider image
hosts need an audit first; changing shared-catalog bounds risks rejecting
legitimate provider payloads).

## 4. Design

### 4.1 Reorder without collision (no migration)

Current state: `reorderPlaylist` shifts every row up by `span = max - min + 1`
via one `updateMany({ increment })`, then assigns `0..k-1` via one `unnest`
UPDATE (`src/lib/dal/playlist.ts:449-476`, helper `:533-551`). Postgres checks
the non-deferrable unique per row, unordered, so the shift destination can
still overlap a not-yet-visited row. `ARCHITECTURE.md` §13 records this as a
P0 KNOWN DEFECT; `compactPositions` (`:568-593`) shares the helper.

Change: 3-phase temp-negative-range inside the existing transaction, reusing the
shift helper shape:

- Phase A: shift all memberships of the playlist by `-(max + 1)` so every
  row lands strictly negative. With the standing precondition `position >= 0`,
  the destination range is provably empty (no normal row is negative) and
  pairwise distinct (a constant shift is injective).
- Phase B: assign final `0..k-1` via the existing single `unnest` UPDATE.
  Targets are `>= 0`, current rows are all `< 0`: no overlap by construction.
- Guard: if any observed position is `< 0` (legacy/corrupt row), fall back to a
  per-row ascending renumber inside the same tx (N statements, always correct)
  rather than the batch form. Slow path only, never the common case.
- `compactPositions` gets the same treatment through the shared helper path.

Statement budget stays constant-order (3–4 statements, not `2N + 5`); the 20 s
interactive-tx budget (`PLAYLIST_TRANSACTION_OPTIONS`) is unchanged.

### 4.2 Atomic ownership

Current state: `requirePlaylistOwner` (`playlist.ts:94-107`) reads, then each
mutation (`updatePlaylist`, `setPlaylistVisibility`, `deletePlaylist`,
`addTrackToPlaylist`, `removeTrackFromPlaylist`, `reorderPlaylist`) writes in a
separate statement — a delete/revoke can land between (TOCTOU).

Change: each mutation performs the write as
`updateMany`/`deleteMany`/`$transaction` step with `where: { id: playlistId,
userId }` and checks the affected count. Only when the count is 0, do one
`select: { userId }` read to preserve today's distinction: row absent →
`ResourceNotFoundError`, present-but-foreign → `AuthorizationError`, with the
existing messages. No oracle is introduced (the distinguishing read happens
only after a failed authorized write, same as today's failure cases). Share
revocation and concurrent delete then resolve to one of the two existing
errors instead of acting on a stale read.

### 4.3 Atomic search-history trim

Current state: `addSearch` does create → `findMany skip: 50` → `deleteMany`
non-atomically (`search-history.ts:17-34`); concurrent searches can overfill.

Change: wrap the three steps in one `$transaction`; keep the no-`count()`
shape (the `skip: HISTORY_LIMIT` read is already the exact over-limit
predicate). Trim only when the read is non-empty. `HISTORY_LIMIT = 50` and the
display caps (library 20, empty-search 8) are unchanged.

### 4.4 Input validation

Current state: `removeTrackSchema` / `reorderPlaylistSchema` use bare
`z.string()` for `provider` / `providerTrackId` (`schemas.ts:275-291`), while
`trackInputSchema` and `idSchema` already trim + bound (`:3-5`, `:177-208`).

Change: reuse `providerIdSchema` (trim, 1–64) and `idSchema` (trim, 1–256) for
both schemas. Cap `orderedRefs` length at 200 (the persisted-queue cap,
`MAX_PERSISTED_QUEUE_ENTRIES`) so a megabyte array cannot reach the tx. Wire
shape only; DAL matching semantics unchanged.

### 4.5 Artwork write + render

Current state: `playlistArtworkSchema` accepts `http:` (`schemas.ts:40-71`);
`next.config.ts:37` keeps `img-src http: data: blob:`; `Artwork`
(`src/components/ui/artwork.tsx:65-105`) renders `next/image unoptimized` in
two branches with no referrer policy — a persisted `http://attacker/beacon.gif`
in the shared catalog would make every viewer (including anonymous
shared-playlist visitors) issue a plaintext cross-origin request leaking IP/UA.

Change (both halves, one slice):

- Write: `playlistArtworkSchema` accepts `https:` only (host required, ≤2048,
  existing `javascript:`/`data:`/`blob:`/`file:`/protocol-relative rejections
  kept). Client and server share the schema, so feedback and enforcement agree.
- Render: add `referrerPolicy="no-referrer"` to both `Image` branches of the
  single `Artwork` primitive. Every surface (library card, playlist page,
  add-to-playlist picker, share preview, artwork editor preview) routes through
  it — verified call sites in `playlist-share-control.tsx:406`,
  `playlist-artwork-editor.tsx:137,173` and the card/row components — so one
  edit covers all renders. Defense in depth alongside the write rule, not a
  substitute: existing `http:` rows stop leaking `Referer` even before they
  are replaced.

CSP is deliberately untouched.

### 4.6 Prod origin boot guard

Current state: `AURORA_PUBLIC_URL` is optional (`env.ts:88`); without it prod
falls back to `Host`/`x-forwarded-host` (`trustHost: true`,
`src/lib/auth/options.ts:121`; `[...nextauth]/route.ts:47-59`). A proxy that
appends the internal port reproduces the exact `redirect_uri_mismatch` the
declaration exists to prevent, and a spoofed `Host` can steer OAuth redirects.

Change: in `parseEnv` production branch (`env.ts:228-258`), throw `ConfigError`
when `AURORA_PUBLIC_URL` is absent, exempting only the E2E harness
(`AURORA_E2E_ALLOW_TEST_FLAGS === "1"`, which serves `next start` on localhost
by design). Keep the existing `AUTH_URL`/`NEXTAUTH_URL` disagreement check
(`:214-226`); add a deployment-doc line that exactly one public origin must be
declared. Behavior change, so the implementation change updates
`docs/deployment.md` (+ `PRODUCT_SPEC.md` §3 origin paragraph) in the same
diff. Dev/LAN (`NODE_ENV != production`) keeps header-derived origins.

### 4.7 Snapshot + registry guards

- Snapshot: `isValidEntry` (`queue-snapshot.ts:244-265`) gains one condition —
  reject `provider === "local"` (trimmed compare, mirroring `toEntry :135`).
  The writer already drops local entries; the validator currently does not, so
  a crafted/legacy row could restore an unplayable entry. Migration path
  (`migrateQueueSnapshot → validateCurrentQueueSnapshot → isValidEntry`) is
  covered by the same condition.
- Registry: `registerProvider` (`registry.ts:7-9`) asserts
  `id ∈ { youtube, deezer, spotify }` (`PRODUCT_SPEC.md` §4 frozen list).
  Today's test doubles already reuse those canonical ids
  (`makeFakeProvider("youtube" | "deezer" | "spotify")`), so no test escape
  hatch is added; a future test needing a new id updates the assertion
  deliberately rather than slipping a fourth production provider in.

## 5. Transaction and data-flow notes

- Reorder/compact: one interactive tx (existing budget), Phase A shift →
  Phase B place → read-back. No statement leaves the tx.
- Ownership: authorized-write-first, classifying-read-only-on-failure. Arrival
  order decides concurrent writers; losers get an existing typed error.
- Search trim: single `$transaction` (create + probe + conditional delete).
- Snapshot/registry/validation: pure function changes, no I/O, no new state.

## 6. Error handling

No new user-facing copy. All failures keep their current curated messages,
`preservePlayback: true`, and retry affordances. P0 reorder exhaustion keeps
the current safe-failure shape (typed conflict, user retries); it must no
longer surface raw `P2002`. Ownership keeps `ResourceNotFoundError` vs
`AuthorizationError` with existing messages. Boot guard failure is a
`ConfigError` naming `AURORA_PUBLIC_URL` (operator-facing, never rendered to
listeners).

## 7. Testing and verification

- Unit (no DB): schemas (`remove`/`reorder` trim/bounds/caps, artwork
  `https:`-only + rejections), `validateQueueSnapshot` rejects `local` +
  keeps v1→v2 migration green, registry rejects a fourth id and accepts the
  canonical three.
- DB (`bun run test:db -- playlist/search-history`, serial suite): concurrent
  reorder over gapped positions (the `0,4,5,9`-class shapes), remove-head +
  compact, TOCTOU delete/revoke between check and write, concurrent
  `addSearch` over-limit trim. Full `playlist.db.test.ts` (~13 min vs Aiven)
  before merge.
- Gates: `bun run test`, `bun run lint`, `bun run typecheck` (after `bun run
  build` on a clean tree — Next 16 `.next/types` requirement, per `AGENTS.md`).
  No e2e required except keeping any existing `Artwork` component suite green;
  no `NEXT_PUBLIC_*`, no browser storage, no bare `NextResponse.json`.
- Docs in the same implementation diff: `ARCHITECTURE.md` §12–13 (retire the
  P0 KNOWN DEFECT note, describe temp-range + atomic ownership), `PRODUCT_SPEC.md`
  §3/§8 (origin requirement, artwork `https:`), `docs/security.md` + 
  `docs/deployment.md` (origin + artwork render policy).

## 8. Risks and rollback

- No migration ⇒ rollback is a revert. Temp-range fallback (per-row renumber
  on negative positions) bounds the one shape the batch form cannot assume.
- `https:`-only artwork may reject a previously-saved `http:` value on next
  edit: the editor surfaces the existing field message; no data migration (no
  mass rewrite of shared rows in this slice).
- Prod boot guard is the one boot-breaking change: mitigated by the E2E
  exemption and a deployment-doc line; staging deploy validates before prod.

## 9. Acceptance checklist

- [ ] Reorder + compact hold on gapped/dense/racy shapes with no raw `P2002`.
- [ ] Ownership races resolve to the existing typed errors; no stale-write win.
- [ ] Trim stays ≤ 50 under concurrency; caps unchanged elsewhere.
- [ ] `remove`/`reorder` refs bounded; `orderedRefs` capped at 200.
- [ ] `http:` artwork rejected at write; `Artwork` sends no `Referer`.
- [ ] Prod without `AURORA_PUBLIC_URL` fails boot; E2E harness exempt; docs updated.
- [ ] `local` snapshot entries rejected; fourth provider id rejected.
- [ ] `ARCHITECTURE.md` P0 note retired; `PRODUCT_SPEC.md`/security/deployment
      updated in the same change; full gates green.
