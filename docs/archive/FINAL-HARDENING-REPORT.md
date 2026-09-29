# Aurora Music — Final Hardening Report

**Date:** 2026-09-28
**Scope:** Resolve the findings in the two prior QA reports (`fe-report.txt`,
`be-report.txt`) plus the carried-forward `QA_REPORT.md` / `AUDIT_REPORT.md`
items; reproduce/prioritize/fix confirmed issues; add regression tests; run the
full regression; verify production readiness.
**Method:** reproduce → classify (REAL BUG / FALSE POSITIVE / EXPECTED /
ENVIRONMENT / TEST / NEEDS INVESTIGATION) → smallest fix → regression → re-run
all gates on both runtimes.

---

## 1. Release decision

> ### 🚫 NOT READY — for the **Cloudflare Workers** target.
> The OpenNext build succeeds and the Worker preview boots and serves the app,
> but the Worker **cannot reach PostgreSQL** with TLS verification ON because
> Aiven's per-project CA cannot be supplied to `cloudflare:sockets`. This is an
> external trust-boundary requirement (Hyperdrive or a publicly-trusted DB
> certificate), not an application defect and not fixable in-app.
>
> ### ✅ READY — for the **Node** target (`next start` behind cloudflared),
> which is the currently documented production path. Every gate is green there,
> including a live DB, `health: ready`, and 23/23 production smoke checks.

The prior BE report reached "ship the build" on the grounds that Workers is not
the production path. That is true for the Node deployment, but the release rule
for this mission explicitly makes Cloudflare/OpenNext a blocker, and a
DB-backed Worker that cannot read its database has not passed. Both statements
are kept separate above rather than collapsed.

---

## 2. Findings matrix

Classification legend: **REAL BUG** · **FALSE POSITIVE** · **EXPECTED** ·
**ENVIRONMENT** · **TEST** · **NEEDS INVESTIGATION**.

### 2.1 From the frontend report (`fe-report.txt`)

| ID | Finding | Classification | Disposition |
|---|---|---|---|
| AUR-QA-01 | Fixed-size `Artwork` rendered 44×25 instead of 44×44 (Tailwind `img{height:auto}` beat the height attribute) on `/search` and any square artwork | **REAL BUG** | **FIXED** — `aspect-square` added in `src/components/ui/artwork.tsx`. Re-verified through the production build, unit suite, and E2E. |
| AUR-QA-02 | Header language menu at 320–360px overflowed the **left** edge by up to 52px (right-aligned to a left-side trigger) | **REAL BUG** | **FIXED** — `right-0` → `left-0` in `src/components/i18n/locale-switcher.tsx`. |
| AUR-QA-03 | Row "Add to playlist" picker opened 138–162px off-screen at all widths (the no-`placement` fallback had lost `right-0`) | **REAL BUG** | **FIXED** — `right-0` restored in `src/components/tracks/add-to-playlist-menu.tsx`; now covered by E2E (GAP-01). |
| OBS-01 | `Artwork` has no `onError` fallback for a broken non-null `src` | **EXPECTED / DEFERRED** | Adding `onError` forces the primitive to become a client component; only reachable from QA seed URLs, not real provider data. Recorded, not fixed. |
| OBS-02 | `Seek`/`Volume` sliders are 16px tall, plus one 22px text link | **FALSE POSITIVE** | Controls are wide; accepted by the FE report itself. No change. |
| GAP-01 | No E2E coverage for the **row-level** "Add to playlist" path (the exact path AUR-QA-03 lived in) | **TEST GAP** | **FIXED** — two Playwright tests added to `e2e/menu-clipping.spec.ts` (desktop + phone). |

### 2.2 From the backend report (`be-report.txt`)

| ID | Finding | Classification | Disposition |
|---|---|---|---|
| BUG-1 | `removeTrackFromPlaylist` deleted an **unrelated** track when the submitted `TrackRef` named no catalog row (`trackId ?? undefined` dropped the Prisma predicate) | **REAL BUG** — P2 data loss | **FIXED** — null-guard + strict `where: { playlistId, trackId }` in `src/lib/dal/playlist.ts`; DB regression test passes. |
| BUG-2 | `bun run lint` failed after an OpenNext build (ESLint 9 flat config does not read `.gitignore`) | **REAL BUG** — tooling/CI | **FIXED** — `.open-next/**`, `.wrangler/**` (plus local QA scratch, `.kilo/**`) added to `globalIgnores` in `eslint.config.mjs`. |
| BUG-3 | Playlist interactive transactions used Prisma's 5s default; a 3-track reorder intermittently timed out over the high-latency Aiven link | **REAL BUG** — latent, environment-dependent | **FIXED** — explicit `{ timeout: 20_000, maxWait: 15_000 }` at all three `$transaction` sites; semantics unchanged. DB suite 28/28. |
| BUG-4 | OpenNext Worker could not reach Postgres in preview | **PARTIAL / ENVIRONMENT** | Cause (a) fixed (compiled test-flag acknowledgement). Cause (b) — the CA — **cannot be fixed in-app** (see §3). The report's recommendation to "inject the CA as a Worker secret" was **disproved** on workerd. |
| BUG-5 | `opennextjs-cloudflare build` bakes **all** `.env` values (DB password, `CLOUDFLARED_TOKEN`, `AUTH_SECRET`, OAuth secrets) into the generated `.open-next/cloudflare/next-env.mjs` | **REAL BUG** — secret hygiene | **OPERATIONAL / DOC ONLY** — no `node_modules` patch. Documented in `docs/deployment.md` (keep infra secrets out of `.env` for Cloudflare builds; prefer `wrangler secret put`). File is gitignored. |

### 2.3 Carried forward from `QA_REPORT.md` / `AUDIT_REPORT.md`

These items were already classified/deferred in earlier passes (including the
deploy-the-pre-fix-bundle P0 and the AUR-010…AUR-021 cluster). Deployment is not
possible from this machine, so they were not re-opened; no new evidence
contradicts their prior dispositions. Actual production code outranks the
historical phase reports per the source-of-truth policy.

### 2.4 New findings this session

| ID | Finding | Classification | Disposition |
|---|---|---|---|
| RH-01 | The AUR-QA-02 fix's code comment contained the literal word "scrollbar", which failed `src/app/__tests__/scrollbar.test.ts` ("no page-specific scrollbar variants") | **TEST** (regression introduced by a QA fix) | **FIXED** — comment reworded. Unit suite green. |
| RH-02 | `e2e/menu-clipping.spec.ts`'s `enqueueFixtureTracks`/row-picker locators matched two elements once a track was playing (the list row **and** the player bar both expose "Actions for <title>"), causing strict-mode failures | **TEST** | **FIXED** — locators scoped to the library list region (`getByRole("main")`). |
| RH-03 | `docs/scope-boundaries.md` and `docs/deployment.md` claimed the Workers private-CA problem was **resolved** by `AURORA_DATABASE_CA_CERT`. It is not: `pg-cloudflare` forwards pg's TLS options to `cloudflare:sockets`, which accepts only `expectedServerHostname`, so the CA is dropped | **NEEDS INVESTIGATION → FALSE FIX / DOC CORRECTION** | **FIXED (docs)** — both documents corrected to state the limitation and the supported path (Hyperdrive or a publicly-trusted certificate). |

---

## 3. Root cause of BUG-4 (Cloudflare Workers ↔ Aiven TLS)

This is the reason the release decision is NOT READY. It was reproduced and
narrowed to a single, externally-blocking fact.

**What works:** from local workerd, plain TCP to
`aurora-…aivencloud.com:13135` succeeds; the Postgres `SSLRequest` is answered
with `S`; and a TLS upgrade to a **publicly-trusted** host (`example.com:443`)
succeeds via `startTls()` and via one-shot `secureTransport:"on"`.

**What fails:** every `pg` attempt (and an explicit `CloudflareSocket`) closes
during the Postgres StartTLS upgrade with `Network connection lost`.

**Why:**

1. `pg` on Workers selects `pg-cloudflare`'s `CloudflareSocket`.
2. Its `startTls(options)` forwards the caller's options to
   `cloudflare:sockets`' `Socket.startTls`, whose `TlsOptions` type exposes
   **only** `expectedServerHostname`. pg's `ca` and `rejectUnauthorized` are
   silently dropped, and the `servername` pg supplies is not the property
   Cloudflare's API reads. (Source: `pg-cloudflare/dist/index.js`,
   `pg-cloudflare/src/types.d.ts`.)
3. Aiven signs with a **per-project CA**. Proven in Node:
   `buildDatabaseAdapterConfig({ url })` (system trust store) fails with
   `self signed certificate in certificate chain`; the same config with the CA
   succeeds. Cloudflare's trust store therefore cannot contain it, and
   `cloudflare:sockets` offers no way to add it.
4. Verification must stay ON (`sslmode=disable`/`no-verify`, `ssl=false`,
   `NODE_TLS_REJECT_UNAUTHORIZED=0` remain refused), so "make it connect"
   cannot mean "drop verification".

**Conclusion:** no application-code change can connect a Cloudflare Worker to
this private-CA database. The supported path is **Hyperdrive** (Cloudflare's
Postgres connector, which owns the origin TLS/CA and is the vendor's documented
recommendation) or a **publicly-trusted database certificate**.

The inline-CA mechanism (`AURORA_DATABASE_CA_CERT`) is still correct and
valuable: it is the trust anchor for a **filesystem-less Node** runtime and is
proven to connect with verification ON. It is not a Workers fix and is no
longer documented as one.

---

## 4. Fixes applied

| File | Change |
|---|---|
| `src/lib/dal/playlist.ts` | BUG-1 null-guard + strict predicate; BUG-3 `PLAYLIST_TRANSACTION_OPTIONS` at all three `$transaction` sites. |
| `src/lib/dal/__tests__/playlist.db.test.ts` | BUG-1 regression test (asserts rejection **and** survival of the original item). |
| `src/lib/db-tls.ts` | `AURORA_DATABASE_CA_CERT` inline PEM (takes precedence over the path, fails closed on non-PEM, verification ON). |
| `src/lib/db.ts`, `src/lib/config/env.ts` | Wire the inline CA through; declare the optional env var. |
| `src/lib/db-tls.test.ts` | 4 new unit tests for the inline-CA path. |
| `src/components/i18n/locale-switcher.tsx` | AUR-QA-02 `left-0` fix; comment reworded for RH-01. |
| `e2e/menu-clipping.spec.ts` | GAP-01 row-level picker tests (desktop + phone); RH-02 locator scoping. |
| `eslint.config.mjs` | BUG-2 ignores (`.open-next/**`, `.wrangler/**`, `.qa/**`, `.qa-*.mts`, `.kilo/**`). |
| `.env.example` | Document `AURORA_DATABASE_CA_CERT` (marks it as the filesystem-less **Node** mechanism). |
| `docs/deployment.md` | Corrected the Workers DB-TLS section (Hyperdrive / public cert); BUG-5 hygiene note. |
| `docs/scope-boundaries.md` | Corrected the private-CA section with the measured workerd evidence. |

Pre-existing uncommitted work (not authored by this pass) remained untouched:
the YouTube MWEB/IOS provider WIP, `ARCHITECTURE.md`, `next.config.ts`,
`package.json`, `bun.lock`, `open-next.config.ts`, `wrangler.jsonc`,
`hero-section.tsx`, `artwork.tsx`, `add-to-playlist-menu.tsx`.

---

## 5. Regression results (all gates)

| Gate | Command | Result |
|---|---|---|
| Frozen install | `bun install --frozen-lockfile` | **PASS** — 870 installs, no changes, exit 0 |
| Lint | `bun run lint` | **PASS** — 0 errors, 2 pre-existing warnings |
| Types | `bun run typecheck` | **PASS** — exit 0 |
| Unit | `bun run test` | **PASS** — **200 files / 2915 tests** (baseline 2911 + 4 new) |
| Integration (DB) | `vitest --config vitest.db.config.mts src/lib/dal/__tests__/playlist.db.test.ts` | **PASS** — **28/28** against remote Aiven (≈299s; confirms BUG-3 is latency, not logic) |
| E2E | `bunx playwright test e2e/menu-clipping.spec.ts --project=chromium` | **PASS** — 13 passed, 1 intentional skip, exit 0 |
| Build | `bun run build` | **PASS** — fresh `BUILD_ID FTQeYzZc22maIsC6YDdX6` |
| OpenNext build | `bunx opennextjs-cloudflare build` | **PASS** — "OpenNext build complete", exit 0, **no `pg-cloudflare` error** |
| OpenNext preview | `bunx opennextjs-cloudflare preview` | **PARTIAL** — app serves; DB degraded (see §6) |
| Prod smoke (Node) | `bun run smoke:prod -- --spawn --port 3210` | **PASS** — 23/23, `health: ready (env valid, database up)` |

Notes:
- `bun run build` was run with `AURORA_E2E_ALLOW_TEST_FLAGS=1` because
  `.env.local` sets `AURORA_E2E_AUTH=1`; without the acknowledgement the
  production guard deliberately fails closed.
- The full OpenNext build is required. `--skipNextBuild` fails with a missing
  `.next/standalone/.../pages-manifest.json`; it cannot be used as the gate.
- E2E server-log noise (`JWTSessionError`, "destination stream closed early")
  is expected: a stale cookie and client-side aborts, not test failures.

---

## 6. Cloudflare preview evidence

| Route | Status | Body / note |
|---|---|---|
| `/` | **200** | HTML rendered |
| `/api/app-config` | **200** | valid JSON metadata |
| `/api/auth/session` | **200** | `null` (unauthenticated) |
| `/settings` | **200** | HTML rendered |
| `/api/health` | **503** | `{"status":"degraded","checks":{"environment":"valid","database":"down"}}` |

`environment: valid` proves the inline-CA binding is read; `database: down` is
the §3 trust failure. The Worker also logged a post-run crash/restart and
OpenNext warned it is not fully compatible with Windows — local workerd
instability, consistent with `startTls` being the failing operation.

---

## 7. Security posture

- **No DB TLS weakening.** `rejectUnauthorized: true` everywhere; the
  production guard still refuses `sslmode=disable`, `sslmode=no-verify`,
  `ssl=false`, and `uselibpqcompat=true` with a downgraded `sslmode`.
  `NODE_TLS_REJECT_UNAUTHORIZED=0` was never used.
- **Inline CA fails closed** on a value that is not PEM, and never echoes the
  value or path in an error.
- **BUG-4 keeps verification ON** — the Worker fails because verification
  cannot be satisfied, not because it was disabled.
- **No real secrets in tracked files.** `.env`, `.env.local`, `.dev.vars` are
  gitignored; the temporary `.dev.vars`, `.qa-inline-ca.mts`,
  `.qa-trust-probe.mts`, and `.qa-workerd/` were deleted. A scan for
  `BEGIN CERTIFICATE` finds only `.env.example` and test fixtures; no Aiven
  host appears in any tracked file.
- **BUG-5 remains an operational risk:** secrets present in `.env` at build
  time are compiled into the (gitignored) `.open-next/cloudflare/next-env.mjs`.
  Mitigation is process, not code: build with infra secrets removed and use
  `wrangler secret put`.

---

## 8. Remaining issues / follow-ups (priority order)

1. **Cloudflare Workers DB connectivity (release blocker).** Provision
   **Hyperdrive** for the Aiven database, or switch the service to a
   publicly-trusted certificate. Until then the Workers target cannot serve
   DB-backed routes. (External configuration.)
2. **BUG-5 secret hygiene.** Keep `CLOUDFLARED_TOKEN` and other infra secrets
   out of `.env`/`.env.local` for Cloudflare builds; use `wrangler secret put`.
3. **OBS-01** `Artwork` `onError` fallback — deferred (client-component cost;
   not reachable from real provider data).
4. **Commit the Cloudflare config.** `open-next.config.ts` and `wrangler.jsonc`
   are referenced by `docs/deployment.md` as committed, but are currently
   **untracked**. They must be committed for the documented deployment to be
   reproducible. (`RESPONSIVE-QA-REPORT.md` is likewise untracked.)
5. **OpenNext on Windows** is warned as not fully compatible (WSL recommended);
   the preview crash shows the local runtime is not a faithful production
   surrogate. Production verification of the Worker should happen from WSL/CI.

---

## 9. Files changed (this session)

New/modified by this pass:
`src/lib/dal/playlist.ts`, `src/lib/dal/__tests__/playlist.db.test.ts`,
`src/lib/db-tls.ts`, `src/lib/db-tls.test.ts`, `src/lib/db.ts`,
`src/lib/config/env.ts`, `src/components/i18n/locale-switcher.tsx`,
`e2e/menu-clipping.spec.ts`, `eslint.config.mjs`, `.env.example`,
`docs/deployment.md`, `docs/scope-boundaries.md`, `FINAL-HARDENING-REPORT.md`.

Left intact (pre-existing uncommitted work): `ARCHITECTURE.md`,
`next.config.ts`, `package.json`, `bun.lock`, `open-next.config.ts`,
`wrangler.jsonc`, `.gitignore`, `src/components/ui/artwork.tsx`,
`src/components/tracks/add-to-playlist-menu.tsx`,
`src/components/home/hero-section.tsx`, and the YouTube MWEB/IOS WIP under
`src/lib/providers/youtube/**`.

---

## 10. One-line summary

The application is hardened and every code gate is green on Node (install,
lint, typecheck, 2915 unit tests, 28/28 DB integration, E2E, build, 23/23
production smoke). The Cloudflare Workers target is **NOT READY** because
`cloudflare:sockets` cannot trust Aiven's private CA — an external Hyperdrive /
certificate decision, correctly documented rather than papered over.
