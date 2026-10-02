<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Sources of truth

- `PRODUCT_SPEC.md` — intended current product scope.
- `ARCHITECTURE.md` — technical architecture and invariants (the real reference; ~1.6k lines, section-numbered — cite `§N`).
- `docs/scope-boundaries.md` — deliberate exclusions/deferred features.
- `docs/security.md` — operational security posture.
- `docs/deployment.md` — release/deployment procedure.
- Precedence when sources conflict: production code > Prisma schema / executable
  contracts > tests and gates > `PRODUCT_SPEC.md` > `ARCHITECTURE.md` > the rest.
- Phase reports were historical evidence, not specification, and the early ones
  are gone from the tree. They are not a citation target: a rule that used to
  live in one now lives in one of the documents above.

**Documentation rule (enforced socially, not by a gate):** a behavior change
updates `PRODUCT_SPEC.md` and/or `ARCHITECTURE.md` **in the same change**; a new
exclusion or deferral updates `docs/scope-boundaries.md`. A code-only diff that
changes observable behavior is incomplete.

## Toolchain

**Bun is the canonical package manager and script runtime.** `bun.lock` is the
only lockfile; there is no `package-lock.json`.

- Install: `bun install` (CI uses `bun install --frozen-lockfile`).
- Scripts: `bun run <script>`. One-off CLIs: `bunx <cli>`.
- **Never write `npm run`, `npm ci`, `npm test` or `npx` in code, docs or CI.**
  This is RULE 57 and it is enforced by `src/quality-gates.test.ts`, which
  greps the whole tree (root, `docs`, `src`, `scripts`, `e2e`, `.github`) for
  those tokens and fails the suite. `AGENTS.md` is the sole exemption, because
  it is the file that names the forbidden commands.
- A `postinstall` hook runs `prisma generate`; the client is emitted to
  `src/generated` (gitignored). Never delete it without reinstalling.
- `bun run typecheck` depends on `.next/types`, which only a `next build` (or
  `next dev`) generates. On a clean clone run `bun run build` **first**. This is
  Next.js 16 behaviour, not a Bun limitation.

## Verification

Three separate suites with three configs — pick by suffix, not by guessing.

| Command | Config | Matches |
|---|---|---|
| `bun run test` | `vitest.config.mts` | `src/**/*.test.{ts,tsx}`, **excluding** `*.db.test.ts`. No DB, no network. |
| `bun run test:db` | `vitest.db.config.mts` | `src/**/*.db.test.ts`. Runs `prisma migrate deploy` first. |
| `bun run test:e2e:playback` | `vitest.live.config.mts` + Playwright | `src/**/*.live.spec.ts`, then `playwright test --project=chromium`. |

- Single test: `bun run test -- src/app/__tests__/design-tokens.test.ts`
  (extra args pass through to `vitest run`). Same `--` form for
  `bun run test:db -- <path>`.
- `bun run test` needs no database: `src/test-setup.ts` injects a dummy
  `DATABASE_URL` and mocks `@/lib/auth` and `@/app/actions/locale`, because
  component suites transitively reach server-action modules that vite-node
  cannot resolve.
- `test:db` is **deliberately serial** (`fileParallelism: false`) — the suites
  share one database and several assert on counts across a user's whole
  history. It points at a remote Aiven instance at ~296 ms per round trip, so
  it is genuinely slow (a full `playlist.db.test.ts` run is ~13 min). A test
  needing more than the 60 s budget should get a **local, documented** timeout,
  never a bump to the config — the rationale is in that config's header comment.
- E2E and `*.live.spec.ts` are **self-skipping** unless `AURORA_E2E_LIVE_PLAYBACK=1`,
  so a plain `bunx playwright test` never touches YouTube. Playwright's
  `webServer` runs `bun run start -p 3100`, so **`bun run build` must have run
  first**, and it sets `AURORA_E2E_ALLOW_TEST_FLAGS=1` because `next start` means
  `NODE_ENV=production` and `parseEnv` otherwise fails the boot closed on the
  test flags. Do not add that acknowledgment anywhere else.
- Other gates worth knowing: `bun run verify:client-bundle` (needs a build;
  scans production chunks for server markers and enforces gzip budgets),
  `verify:share-route`, `smoke:prod -- --spawn` (needs `.next/BUILD_ID`),
  `db:verify` / `db:check` / `db:integrity` / `db:restore-drill`.
- CI order (`.github/workflows/ci.yml`, three jobs): `typecheck → lint → test`,
  then `test:db → db:verify` against Postgres 16, then
  `build → verify:client-bundle → test:e2e:playback → smoke:prod`.
  Local release order is in `docs/deployment.md` — build precedes validate.

## Gates that will fail your diff

These are static greps in `bun run test`, not behavioural tests. Read them
before changing the thing they guard, not after the red.

- `src/quality-gates.test.ts` — no npm/npx repo-wide; exactly one lockfile; no
  `NEXT_PUBLIC_*` in `.env.example` or source; no `localStorage` /
  `sessionStorage` / `indexedDB` in production source (narrow exemption:
  `src/lib/offline/{capability,storage}.ts` only, and its size is asserted);
  every `*.live.spec.ts` must self-skip on the flag; public assets are an
  **allowlist**; every API route must answer via `jsonResponse(`
  (`src/lib/api/transport.ts`) or `REQUEST_ID_RESPONSE_HEADER`
  (`src/lib/api/request-id.ts`), never a bare `NextResponse.json(`; the CSP and
  security headers in `next.config.ts` must not be weakened; no blanket
  `cursor: pointer` / `user-select: none` in `globals.css`; the rate limiter
  may only stand down on `AURORA_E2E_AUTH === "1"`.
- `src/components/__tests__/client-boundary.test.ts` — `"use client"` files
  (and all of `src/lib/player`) must not import `@/lib/db`, `@/lib/dal/`,
  `@/lib/auth`, `@/lib/config/env`, `@/lib/providers/server`.
- `src/app/__tests__/design-tokens.test.ts` — parses `src/app/globals.css` with
  comments stripped, then fails on a self-referential property, an unresolved
  `var()`, a shim that redefines a literal, a primitive with no reachable use,
  a utility class with no call site (and vice versa), a non-monotonic radius
  ramp, a Tailwind default shadowed unintentionally, or a decorative animation
  with no `prefers-reduced-motion` path. It also holds a large "aurora glass"
  suite: every surface alpha must derive from the user's alpha, every rule must
  scope to the glass attribute (so OFF is not "reduced"), and `backdrop-filter`
  is banned from components and from nested surfaces entirely.
- `src/lib/dal/__tests__/playback-schema.test.ts` — the migration **allowlist**.
  A new migration fails this closed until its rollback analysis is recorded
  there, and it also guards required compound indexes. Deploy migrations
  explicitly (`bunx prisma migrate deploy`); never auto-migrate at boot.

## Architecture invariants that are not obvious from filenames

`ARCHITECTURE.md` §2 is the single-authority table. The short version:

- **One authority per concern.** `MusicEngine` is the only high-level facade;
  `PlayerEngine` owns the single `HTMLAudioElement`; `QueueManager` owns *no*
  state (it delegates to the Zustand `PlayerStore`); `PlaybackController` is the
  only playback orchestrator; `src/lib/dal/*` is the only persistence path;
  `src/lib/diagnostics/logger.ts` is the only logger. If you find yourself
  adding a second queue array, a second audio element, or a second persistence
  writer, you are violating the architecture — not extending it.
- **Playback URLs are ephemeral and memory-only.** The only way a URL reaches
  `PlayerEngine` is a freshly resolved `AudioSource`. Never persist a stream
  URL: not in the DB (`upsertTrack` refuses `streamUrl`/`previewUrl` at the
  type level), not in storage, not in the service worker. Only `TrackRef`
  (`provider` + `providerTrackId`) is persisted.
- **`src/lib/domain/track-dedupe.ts` is the one duplicate policy**, shared
  verbatim by the client store and the server DAL. Fail open, never merge
  `possible`, first occurrence wins. Do not re-implement it per call site.
- **Search normalization** goes through `src/lib/search/normalize.ts` /
  `match-text.ts`; there is **no SQL-level text search** in this repo by design
  (§13). Vietnamese diacritics are folded for comparison but never transliterated.
- **Design values live only in `src/app/globals.css`**: literals only inside a
  `--p-*` primitive, components consume only semantic tokens. Named gradients
  are classes (`.aurora-fill`), not theme keys — Tailwind 4 generates nothing
  from a gradient theme entry.
- **Browser storage is banned** (see the quality gates). Preferences persist in
  cookies, IndexedDB only for the single offline-directory handle, or the DB.
- `src/lib/config/env.ts` (`parseEnv`) is the boot gate: it validates names
  only, and refuses test flags in production unless the second acknowledgment
  variable is set.