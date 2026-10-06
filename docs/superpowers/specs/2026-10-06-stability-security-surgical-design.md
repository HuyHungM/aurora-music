# Stability + Security (Surgical, no migration) — Design Spec

- Date: 2026-10-06
- Status: approved (owner review 2026-10-06; 3 P0 + 3 P1 conditions applied)
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
  (`https:` stops plaintext + `no-referrer` stops `Referer` leakage; neither
  asserts host trust — remote artwork stays allowed pending a host audit.)
- Prod boot without or with a malformed `AURORA_PUBLIC_URL` fails closed
  (E2E harness exempt).
- Crafted/legacy `provider: "local"` snapshot entries never restore.
- Only the three canonical production provider IDs (`youtube`, `deezer`,
  `spotify`) may be registered; tests use those same IDs and do not bypass
  the allowlist.

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
shift helper shape. The negative-position check runs BEFORE Phase A, never
after the shift:

- Pre-check (before Phase A): inspect the observed positions.
  - If every position `>= 0`: use the constant negative-shift fast path below.
  - If any position `< 0` (legacy/corrupt row): skip the batch shift entirely
    and use the per-row ascending renumber slow path inside the same tx
    (N statements, always correct). Slow path only, never the common case.
- Phase A (fast path only): shift all memberships of the playlist by
  `-(max + 1)` so every row lands strictly negative. With the pre-checked
  precondition `position >= 0`, the destination range is provably empty (no
  normal row is negative) and pairwise distinct (a constant shift is injective).
- Phase B: assign final `0..k-1` via the existing single `unnest` UPDATE.
  Targets are `>= 0`, current rows are all `< 0`: no overlap by construction.
- `compactPositions` gets the same treatment through the shared helper path:
  same pre-check, same fast/slow branch.

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

Invariant (multi-statement mutations): the ownership predicate must protect
the actual mutation statements, not merely precede them with a separate
ownership write. For `reorderPlaylist` (ownership + Phase A + Phase B +
read-back) and the other tx mutations, the ownership condition lives INSIDE
the same transaction as the mutation statements: the tx re-asserts
`where: { id: playlistId, userId }` on its writes (or aborts when the guarded
write affects 0 rows), so the sequence T1-begin-reorder → T2-revoke/delete →
T1-mutate cannot commit a mutation after ownership is gone — it resolves to
the existing typed errors. A standalone ownership `updateMany` issued before
the tx opens does NOT satisfy this invariant. The DB test must prove the
T1/T2 race above.

### 4.3 Atomic search-history trim

Current state: `addSearch` does create → `findMany skip: 50` → `deleteMany`
non-atomically (`search-history.ts:17-34`); concurrent searches can overfill.

Change: wrap the three steps in one `$transaction`; keep the no-`count()`
shape (the `skip: HISTORY_LIMIT` read is already the exact over-limit
predicate). Trim only when the read is non-empty. `HISTORY_LIMIT = 50` and the
display caps (library 20, empty-search 8) are unchanged.

No strict invariant is claimed at every instant under concurrency: a plain
transaction closes the intra-request race (create → probe → delete can no
longer interleave with itself) but does not by itself prove `COUNT <= 50`
under concurrent transactions at Postgres default isolation, and this slice
adds no explicit locking or isolation upgrade. The guarantee is convergence:
concurrent `addSearch` operations converge to the existing 50-entry retention
policy without introducing an unbounded race window, and the DB test must
assert the final retained set obeys the policy.

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

Threat model (explicit): `https:`-only stops plaintext HTTP requests;
`referrerPolicy="no-referrer"` stops `Referer` leakage. Neither establishes
host trust: `https://attacker.example/beacon.gif` is still a syntactically
valid value and the browser will still request it. Remote artwork stays
intentionally allowed because provider/shared-catalog hosts have not yet
been audited (see §3 non-goals: catalog `http:` tightening deferred). A
host allowlist is a future slice, not this one.

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
`parsePublicOrigin` already rejects malformed values at the schema boundary;
the implementation adds a prod malformed-`AURORA_PUBLIC_URL` test only if no
existing `parseEnv` test covers it, without widening validation scope.

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

- Reorder/compact: one interactive tx (existing budget), pre-check → Phase A
  shift → Phase B place → read-back. No statement leaves the tx.
- Ownership: authorized-write-first, classifying-read-only-on-failure, with
  the predicate INSIDE the mutation tx for multi-statement mutations (§4.2).
  Arrival order decides concurrent writers; losers get an existing typed error.
- Search trim: single `$transaction` (create + probe + conditional delete).
  Convergence guarantee only (see §4.3); no isolation/locking upgrade.
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
  canonical three, `parseEnv` prod missing/malformed `AURORA_PUBLIC_URL`
  (malformed case added only if uncovered).
- DB (`bun run test:db -- playlist/search-history`, serial suite) — mandatory
  cases:
  1. Reorder dense: `0,1,2,3`.
  2. Reorder gapped: `0,4,5,9`.
  3. Reorder negative legacy: `-3,0,4,9` (takes the pre-check slow path).
  4. Concurrent reorder: T1 `A → D` vs T2 `B → C`.
  5. Concurrent reorder + delete/revoke ownership (T1-begin → T2-revoke →
     T1-mutate cannot commit; typed errors only).
  6. Artwork legacy `http:` DB value: renders send no `Referer`; no data
     migration required.
  7. Snapshot `provider: "local"`: rejected; v1 → v2 migration still passes.
  8. Registry: `youtube` ✓ / `deezer` ✓ / `spotify` ✓ register; a fourth id
     is rejected; tests use the same IDs (no bypass).
  Full `playlist.db.test.ts` (~13 min vs Aiven) before merge.
- Gates: `bun run test`, `bun run lint`, `bun run typecheck` (after `bun run
  build` on a clean tree — Next 16 `.next/types` requirement, per `AGENTS.md`).
  No e2e required except keeping any existing `Artwork` component suite green;
  no `NEXT_PUBLIC_*`, no browser storage, no bare `NextResponse.json`.
- Docs in the same implementation diff: `ARCHITECTURE.md` §12–13 (retire the
  P0 KNOWN DEFECT note, describe temp-range + atomic ownership), `PRODUCT_SPEC.md`
  §3/§8 (origin requirement, artwork `https:`), `docs/security.md` +
  `docs/deployment.md` (origin + artwork render policy).

## 8. Risks and rollback

- No migration ⇒ rollback is a revert. Slow-path branch (pre-check finds a
  negative position → per-row renumber, decided before Phase A) bounds the one
  shape the batch form cannot assume.
- `https:`-only artwork may reject a previously-saved `http:` value on next
  edit: the editor surfaces the existing field message; no data migration (no
  mass rewrite of shared rows in this slice). `https:` ≠ host trust is now
  explicit (§4.5), so no reviewer can mistake this slice for a host allowlist.
- Prod boot guard is the one boot-breaking change: mitigated by the E2E
  exemption and a deployment-doc line; staging deploy validates before prod.

## 9. Acceptance checklist

- [ ] Reorder + compact hold on dense (`0,1,2,3`), gapped (`0,4,5,9`),
  negative-legacy (`-3,0,4,9`), concurrent reorder (T1 vs T2), and concurrent
  reorder + delete/revoke — with no raw `P2002`.
- [ ] Ownership predicate lives inside the mutation tx; the T1-begin →
  T2-revoke/delete → T1-mutate race cannot commit after ownership is gone;
  losers get the existing typed errors; no stale-write win.
- [ ] Concurrent `addSearch` converges to the 50-entry retention policy
  without an unbounded race window; final retained set obeys the policy;
  caps unchanged elsewhere. (No strict every-instant `≤ 50` claim without
  a locking/isolation upgrade — deliberately out of scope.)
- [ ] `remove`/`reorder` refs bounded; `orderedRefs` capped at 200.
- [ ] `http:` artwork rejected at write; `Artwork` sends no `Referer`;
  legacy stored `http:` rows render without `Referer` (no data migration).
  `https:` ≠ host trust is documented (threat model §4.5).
- [ ] Prod without or with malformed `AURORA_PUBLIC_URL` fails boot; E2E
  harness exempt; docs updated. (Malformed test added only if uncovered.)
- [ ] `local` snapshot entries rejected; v1 → v2 migration still passes.
- [ ] Only `youtube`/`deezer`/`spotify` register; a fourth id is rejected;
  tests use the same IDs (no bypass).
- [ ] `ARCHITECTURE.md` P0 note retired; `PRODUCT_SPEC.md`/security/deployment
      updated in the same change; full gates green.
