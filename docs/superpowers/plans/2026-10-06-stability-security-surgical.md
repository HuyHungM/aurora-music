# Stability + Security (Surgical) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved surgical slice: atomic playlist writes, bounded validation, https-only artwork + no-referrer render, prod origin fail-closed, snapshot/registry guards — with zero migrations.

**Architecture:** Seven sequential tasks on the existing DAL/validation/config/snapshot/registry seams. Pure-function guards first, then tx changes, then render + docs. Each task is TDD with its own test cycle and commit.

**Tech Stack:** Bun 1.4.0 (`bun run …`), Next.js 16.3.5, Prisma 7 + Postgres, Zod 4, Vitest 4 (unit) + vitest.db (serial) .

**Spec:** `docs/superpowers/specs/2026-10-06-stability-security-surgical-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- No new Prisma migration; `playback-schema.test.ts` allowlist untouched.
- No CSP change (`next.config.ts` `img-src` stays as-is).
- No new user-facing error copy; `preservePlayback: true` semantics unchanged.
- `PLAYLIST_TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 15_000 }` unchanged.
- `HISTORY_LIMIT = 50`; display caps unchanged (library 20, empty-search 8).
- `orderedRefs` cap = 200 (`MAX_PERSISTED_QUEUE_ENTRIES`).
- `providerIdSchema` = trim, 1–64; `idSchema` = trim, 1–256.
- Canonical provider IDs = exactly `{ youtube, deezer, spotify }`; tests reuse these IDs, no bypass.
- `Artwork` primitive (`src/components/ui/artwork.tsx`) is the single render fix point — both `Image` branches.
- Prod guard exempts only `AURORA_E2E_ALLOW_TEST_FLAGS === "1"`; dev/LAN keeps header-derived origins.
- Docs ship in the same branch: `ARCHITECTURE.md` §12–13 (retire P0 note), `PRODUCT_SPEC.md` §3/§8, `docs/security.md`, `docs/deployment.md`.
- Quality gates per task: no `NEXT_PUBLIC_*`, no browser storage, no bare `NextResponse.json`, `jsonResponse(`/request-id on API routes.

## Review Focus

- Empty-playlist reorder `orderedRefs: []` must no-op without touching positions — expect success with `[]` items (pinned in Task 5).
- `orderedRefs` containing a duplicate or unknown ref must raise the existing `ConflictError`, never partially write (pinned in Task 5).
- Artwork `""` vs `null` vs `undefined` semantics preserved: `undefined` = untouched, `null` = clear, `""` = rejected (pinned in Task 1).
- Prod + `AURORA_E2E_ALLOW_TEST_FLAGS=1` without `AURORA_PUBLIC_URL` still boots (harness path, pinned in Task 3).
- Legacy stored `http:` artwork row renders with no `Referer` and requires no data migration (pinned in Task 7).

---

## File structure

- `src/lib/validation/schemas.ts` — Task 1: reuse `providerIdSchema`/`idSchema` in `removeTrackSchema`/`reorderPlaylistSchema`, cap `orderedRefs` at 200, `playlistArtworkSchema` https-only.
- `src/lib/player/queue-snapshot.ts` (`isValidEntry`) + `src/lib/providers/registry.ts` (`registerProvider`) — Task 2: one-condition guards each, no I/O.
- `src/lib/config/env.ts` (`parseEnv` production branch) — Task 3: `AURORA_PUBLIC_URL` required in prod, E2E-exempt.
- `src/lib/dal/search-history.ts` (`addSearch`) — Task 4: single `$transaction`, convergence guarantee.
- `src/lib/dal/playlist.ts` (`reorderPlaylist`, `shiftPositionsAboveRange`, `compactPositions`) — Task 5: pre-check → fast temp-negative shift → place, else slow per-row renumber.
- `src/lib/dal/playlist.ts` (all six mutations) — Task 6: ownership predicate inside the mutation tx.
- `src/components/ui/artwork.tsx` + docs — Task 7: `referrerPolicy="no-referrer"` both branches, doc updates, full gates.

---

### Task 1: Input validation hardening

**Files:**
- Modify: `src/lib/validation/schemas.ts:275-291` (`removeTrackSchema`, `reorderPlaylistSchema`), `:40-71` (`playlistArtworkSchema`)
- Test: `src/lib/validation/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: `providerIdSchema` (trim, 1–64), `idSchema` (trim, 1–256), `PLAYLIST_ARTWORK_MAX_LENGTH = 2048`
- Produces: `removeTrackSchema: { playlistId: idSchema, trackRef: { provider: providerIdSchema, providerTrackId: idSchema } }`, `reorderPlaylistSchema: { playlistId: idSchema, orderedRefs: Array<{provider: providerIdSchema, providerTrackId: idSchema}>.max(200) }`, `playlistArtworkSchema` (https-only, host required, ≤2048, `undefined` = untouched / `null` = clear)

- [ ] **Step 1: Write the failing tests** in `src/lib/validation/__tests__/schemas.test.ts`:

```ts
it("trims and bounds remove/reorder refs", () => {
  expect(removeTrackSchema.parse({ playlistId: "pl1", trackRef: { provider: "  youtube ", providerTrackId: " v1 " } }).trackRef.provider).toBe("youtube");
  expect(() => removeTrackSchema.parse({ playlistId: "pl1", trackRef: { provider: "", providerTrackId: "v1" } })).toThrow();
  expect(() => reorderPlaylistSchema.parse({ playlistId: "pl1", orderedRefs: Array.from({ length: 201 }, (_, i) => ({ provider: "youtube", providerTrackId: `v${i}` })) })).toThrow();
});
it("accepts https artwork, rejects http/data/blob/file/protocol-relative", () => {
  expect(playlistArtworkSchema.parse("https://cdn.example/a.jpg")).toBe("https://cdn.example/a.jpg");
  for (const bad of ["http://cdn.example/a.jpg", "data:image/png;base64,x", "blob:https://x/y", "file:///x", "//cdn.example/a.jpg", ""]) {
    expect(() => playlistArtworkSchema.parse(bad)).toThrow();
  }
  expect(playlistArtworkSchema.parse(null)).toBe(null);
  expect(playlistArtworkSchema.parse(undefined)).toBe(undefined);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test -- src/lib/validation/__tests__/schemas.test.ts`
Expected: FAIL (bare `z.string()` accepts `""`/untrimmed/`http:`; no length cap)

- [ ] **Step 3: Implement** the three schema changes in `src/lib/validation/schemas.ts` (reuse, no new helpers; keep existing messages)

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test -- src/lib/validation/__tests__/schemas.test.ts`
Expected: PASS, no other suite broken

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/schemas.ts src/lib/validation/__tests__/schemas.test.ts
git commit -m "fix: bound playlist refs, cap orderedRefs at 200, https-only artwork"
```

### Task 2: Snapshot local + registry allowlist guards

**Files:**
- Modify: `src/lib/player/queue-snapshot.ts:244-265` (`isValidEntry`), `src/lib/providers/registry.ts:7-9` (`registerProvider`)
- Test: `src/lib/player/__tests__/queue-snapshot.test.ts`, `src/lib/providers/__tests__/registry.test.ts` (create; follows `provider-boundary.test.ts` style)

**Interfaces:**
- Consumes: Task 1 (none — independent pure guards)
- Produces: `isValidEntry` rejects trimmed `provider === "local"`; `registerProvider(provider: MusicProvider): void` throws on `id ∉ {youtube,deezer,spotify}`

- [ ] **Step 1: Write the failing tests**:

```ts
// queue-snapshot.test.ts
it("rejects provider:local entries but keeps v1->v2 migration green", () => {
  const bad = { version: 2, entries: [{ provider: " local ", providerTrackId: "f", title: "t", artistId: "a", artistName: "n" }], playOrder: [0], position: 0, mediaPosition: 0, shuffle: false, repeat: "off", volume: 1, muted: false, savedAt: 1 };
  expect(validateQueueSnapshot(bad)).toBeNull();
});
// registry.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearProviders, registerProvider } from "@/lib/providers/registry";
import { makeFakeProvider } from "@/lib/providers/__tests__/fake-provider";

beforeEach(() => clearProviders());
afterEach(() => clearProviders());

it("accepts youtube/deezer/spotify, rejects a fourth id", () => {
  expect(() => registerProvider(makeFakeProvider("youtube"))).not.toThrow();
  expect(() => registerProvider(makeFakeProvider("deezer"))).not.toThrow();
  expect(() => registerProvider(makeFakeProvider("spotify"))).not.toThrow();
  expect(() => registerProvider(makeFakeProvider("apple"))).toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test -- src/lib/player/__tests__/queue-snapshot.test.ts src/lib/providers/__tests__/registry.test.ts`
Expected: FAIL (validator accepts `local`; registry accepts any id)

- [ ] **Step 3: Implement** one trimmed-compare condition in `isValidEntry`; one allowlist assert in `registerProvider` (no test escape hatch)

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test -- src/lib/player/__tests__/queue-snapshot.test.ts src/lib/providers/__tests__/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/player/queue-snapshot.ts src/lib/providers/registry.ts src/lib/player/__tests__/queue-snapshot.test.ts src/lib/providers/__tests__/registry.test.ts
git commit -m "fix: reject local snapshot entries, freeze provider registry at three"
```

### Task 3: Prod origin boot guard

**Files:**
- Modify: `src/lib/config/env.ts:228-258` (`parseEnv` production branch)
- Test: `src/lib/config/env.test.ts`

**Interfaces:**
- Consumes: `parsePublicOrigin` (existing schema-boundary validation)
- Produces: `parseEnv` throws `ConfigError` naming `AURORA_PUBLIC_URL` when `NODE_ENV === "production"` and the var is missing or malformed, unless `AURORA_E2E_ALLOW_TEST_FLAGS === "1"`

- [ ] **Step 1: Write the failing tests**:

```ts
it("fails closed without AURORA_PUBLIC_URL in production", () => {
  expect(() => parseEnv({ DATABASE_URL: "postgres://x", NODE_ENV: "production", AUTH_SECRET: "s" })).toThrow(/AURORA_PUBLIC_URL/);
});
it("exempts the E2E harness and keeps dev header behavior", () => {
  const env = parseEnv({ DATABASE_URL: "postgres://x", NODE_ENV: "production", AUTH_SECRET: "s", AURORA_E2E_ALLOW_TEST_FLAGS: "1" });
  expect(env.NODE_ENV).toBe("production");
});
```

Plus malformed case (`AURORA_PUBLIC_URL: "https://host/path"`) — add only if no existing `parseEnv` test covers it; otherwise assert the existing coverage and skip.

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test -- src/lib/config/env.test.ts`
Expected: FAIL (prod boots without the var)

- [ ] **Step 3: Implement** the prod-branch throw in `parseEnv`; keep the `AUTH_URL`/`NEXTAUTH_URL` disagreement check untouched

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test -- src/lib/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/env.ts src/lib/config/env.test.ts
git commit -m "fix: require AURORA_PUBLIC_URL in production (E2E-exempt)"
```

### Task 4: Atomic search-history trim

**Files:**
- Modify: `src/lib/dal/search-history.ts:8-35` (`addSearch`)
- Test: `src/lib/dal/__tests__/recently-search.db.test.ts`

**Interfaces:**
- Consumes: `HISTORY_LIMIT = 50`, `prisma.searchHistory` delegate
- Produces: `addSearch(userId: string, query: string, db?: PrismaClient): Promise<void>` — same signature, create+probe+conditional-delete in one `$transaction`

- [ ] **Step 1: Write the failing test** (concurrent over-limit convergence):

```ts
it("converges to the 50-entry retention policy under concurrent adds", async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => addSearch(userId, `q-${i}`, prisma)));
  const rows = await listSearchHistory(userId, 100, prisma);
  expect(rows.length).toBeLessThanOrEqual(50);
}, 60000);
```

Follow `playlist-positions.db.test.ts` + `harness.ts` (`dbTest.createUser`, `vi.setConfig({ testTimeout: 60_000 })`).

- [ ] **Step 2: Run to verify it fails or races**

Run: `bun run test:db -- src/lib/dal/__tests__/recently-search.db.test.ts`
Expected: FAIL or flaky overfill on the non-atomic path

- [ ] **Step 3: Implement** the `$transaction` wrap (keep no-`count()` `skip: HISTORY_LIMIT` probe; delete only when non-empty)

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test:db -- src/lib/dal/__tests__/recently-search.db.test.ts`
Expected: PASS, retained set obeys policy (convergence, not every-instant ≤50 — per spec §4.3)

- [ ] **Step 5: Commit**

```bash
git add src/lib/dal/search-history.ts src/lib/dal/__tests__/recently-search.db.test.ts
git commit -m "fix: wrap search-history trim in one transaction"
```

### Task 5: Reorder temp-negative-range with pre-check

**Files:**
- Modify: `src/lib/dal/playlist.ts:399-483` (`reorderPlaylist`), `:533-551` (`shiftPositionsAboveRange`), `:568-593` (`compactPositions`)
- Test: `src/lib/dal/__tests__/playlist-positions.db.test.ts`

**Interfaces:**
- Consumes: `dbTest.seedPlaylistAtPositions`, `dbTest.makeTrack`, `PLAYLIST_TRANSACTION_OPTIONS`
- Produces: `reorderPlaylist(userId, playlistId, orderedRefs: TrackRef[], db?): Promise<Playlist>` — signature unchanged; pre-check → fast `-(max+1)` shift → `unnest` place `0..k-1`, else slow per-row ascending renumber in the same tx

- [ ] **Step 1: Write the failing tests** (use `seedSparse`/`positionsOf` helpers already in the file):

```ts
it("reorders dense 0,1,2,3 without P2002", ...);
it("reorders gapped 0,4,5,9 without P2002", ...); // exists — keep green
it("takes the slow path for negative legacy -3,0,4,9 and lands 0..3", async () => {
  const id = await seedSparse([-3, 0, 4, 9], tracks);
  const out = await reorderPlaylist(ownerId, id, [refs reversed], prisma);
  expect(await positionsOf(id)).toEqual([0, 1, 2, 3]);
});
it("holds under concurrent reorder T1 vs T2", ...); // Promise.all two reversals, one wins cleanly, no raw P2002
it("empty orderedRefs on empty playlist no-ops", ...);
it("duplicate/unknown refs raise ConflictError without partial write", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test:db -- src/lib/dal/__tests__/playlist-positions.db.test.ts`
Expected: FAIL (negative-legacy + concurrent shapes; dense/gapped already pass on span shift)

- [ ] **Step 3: Implement** the pre-check + Phase A (`-(max + 1)`) + Phase B + slow-path branch in `reorderPlaylist`; route `compactPositions` through the same helper path

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test:db -- src/lib/dal/__tests__/playlist-positions.db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dal/playlist.ts src/lib/dal/__tests__/playlist-positions.db.test.ts
git commit -m "fix: temp-negative-range reorder with negative-position slow path"
```

### Task 6: Atomic ownership inside the mutation tx

**Files:**
- Modify: `src/lib/dal/playlist.ts:119-142` (`updatePlaylist`), `:158-205` (`setPlaylistVisibility`), `:280-287` (`deletePlaylist`), `:289-363` (`addTrackToPlaylist`), `:365-397` (`removeTrackFromPlaylist`), `:399-483` (`reorderPlaylist`)
- Test: `src/lib/dal/__tests__/playlist.db.test.ts`

**Interfaces:**
- Consumes: Task 5 reorder tx shape; `ResourceNotFoundError` / `AuthorizationError` with existing messages
- Produces: same six signatures; every mutation write carries `where: { id: playlistId, userId }` INSIDE its tx/step; affected-count 0 → single `select: { userId }` classifying read

- [ ] **Step 1: Write the failing test** (the spec's T1/T2 race):

```ts
it("T1-begin-reorder + T2-delete cannot commit after ownership is gone", async () => {
  // T1 opens reorder tx (deferred commit), T2 deletes the playlist, T1 attempts commit
  // expect: T1 resolves to ResourceNotFoundError or AuthorizationError — never a committed reorder
});
```

Plus: non-owner mutation → `AuthorizationError`, missing id → `ResourceNotFoundError` (preserve semantics).

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:db -- src/lib/dal/__tests__/playlist.db.test.ts`
Expected: FAIL (standalone pre-tx ownership check lets the stale write through)

- [ ] **Step 3: Implement** authorized-write-first with the predicate inside each tx; a standalone pre-tx ownership write does NOT satisfy the invariant (§4.2)

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test:db -- src/lib/dal/__tests__/playlist.db.test.ts`
Expected: PASS; full `playlist.db.test.ts` before merge (~13 min vs Aiven)

- [ ] **Step 5: Commit**

```bash
git add src/lib/dal/playlist.ts src/lib/dal/__tests__/playlist.db.test.ts
git commit -m "fix: ownership predicate inside playlist mutation transactions"
```

### Task 7: Artwork render + docs + final gates

**Files:**
- Modify: `src/components/ui/artwork.tsx:65-105` (both `Image` branches), `ARCHITECTURE.md` §12–13, `PRODUCT_SPEC.md` §3/§8, `docs/security.md`, `docs/deployment.md`
- Test: `src/components/ui/__tests__/artwork.test.tsx` (create; assert `referrerPolicy`)

**Interfaces:**
- Consumes: Tasks 1–6 (all guards in place)
- Produces: `Artwork` renders `referrerPolicy="no-referrer"` on both branches; P0 KNOWN DEFECT note retired; origin + artwork policies documented

- [ ] **Step 1: Write the failing test**:

```tsx
it("renders artwork images with no-referrer", () => {
  render(<Artwork src="https://cdn.example/a.jpg" alt="cover" />);
  const img = screen.getByAltText("cover") as HTMLImageElement;
  expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
});
```

Legacy-`http:` row case: render with `src="http://legacy.example/a.jpg"` → same assertion, no migration.

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test -- src/components/ui/__tests__/artwork.test.tsx`
Expected: FAIL (no `referrerPolicy` today)

- [ ] **Step 3: Implement** `referrerPolicy="no-referrer"` on both `Image` branches; update the four docs in the same branch (origin requirement, artwork `https:` + render policy, temp-range + atomic ownership, threat model `https:` ≠ host trust)

- [ ] **Step 4: Run the full gates**

Run: `bun run test` then `bun run test:db -- src/lib/dal/__tests__/playlist.db.test.ts src/lib/dal/__tests__/playlist-positions.db.test.ts src/lib/dal/__tests__/recently-search.db.test.ts` then `bun run lint` then `bun run build` + `bun run typecheck`
Expected: all green (build before typecheck on a clean tree — Next 16 `.next/types`)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/artwork.tsx src/components/ui/__tests__/artwork.test.tsx ARCHITECTURE.md PRODUCT_SPEC.md docs/security.md docs/deployment.md
git commit -m "fix: artwork no-referrer render, retire P0 reorder note, document origin policy"
```
