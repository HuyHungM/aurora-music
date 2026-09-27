# Aurora Music — QA Final Report

**Date:** 2026-09-27
**Tester role:** Senior QA / Release Validation (hostile pass; no fixes applied in this mission)
**Build under test:** working tree at `569c337` (contains the AUR-001 `.register()` fix)
**Verdict:** **PASS WITH ISSUES** for the build; **FAIL** for the deployed production origin

---

## 1. Test Environment

| Item | Value |
|---|---|
| OS | Windows (win32), PowerShell shell |
| Runtime | Bun 1.4.0, Node 24.14.1 |
| Database | PostgreSQL 18 on `127.0.0.1:5432`, 8 migrations applied |
| Seed data | 2 users, 27 tracks, 13 artists, 2 playlists, 23 recently-played, 5 search-history rows |
| Browser | Chromium via Playwright (1 worker, `retries: 0`), plus manual browser-tool session |
| Local prod build | `bun run build` + `bun run start`, `PORT=3100` |
| Secure origin (loopback) | `http://127.0.0.1:3100` — *is* a secure context, SW registers |
| Insecure origin (LAN) | `http://192.168.1.32:3100` — plain HTTP private IP, not a secure context |
| Production | `http://zeus.hidencloud.com:24584` — plain HTTP, running the **pre-fix** build |
| Live provider creds | `.env` music-provider keys are invalid; only keyless InnerTube was exercised |

Environment notes (not product defects):

- A stale `next start` from an earlier session occupies **port 3000** (pid 12960, started
  09:16, serving an older build). Left untouched. All QA traffic used port **3100** with the
  current build, so no QA result depends on it.
- A QA probe script was created to pull real provider IDs for route checks and has been
  removed; `git status` is clean.

---

## 2. Build/Test Health

| Gate | Command | Result |
|---|---|---|
| Lint | `bun run lint` | **PASS** — 0 problems |
| Types | `bun run typecheck` | **PASS** — 0 errors |
| Unit tests | `bun run test` | **PASS** — 193 files, 2786 tests, 0 failures |
| DB tests | `bun run test:db` | **PASS** — 9 files, 125 tests (playlist 27, library 9, like/follow 12, playback-state 14, catalog 9, health 2) |
| Build | `bun run build` | **PASS** — production build succeeds |
| Client bundle gate | `bun run verify:client-bundle` | **PASS** — 35 chunks; 335.8/400 KiB JS; 71.6/100 KiB chunk; 14.9/20 KiB CSS; 1 SW chunk; `scanServiceWorkerGuard()` clean |
| DB verify | `bun run db:verify` | **PASS** — row counts + create/delete smoke, `verify-db OK` |
| Data integrity | `bun run db:integrity` | **PASS** — not-null constraints, contiguous playlist ordering from 0, user-scoped ownership, 8 migrations |
| Restore drill | `AURORA_RESTORE_DRILL=1 bun run db:restore-drill` | **PASS** — dumped → restored into an isolated DB → integrity re-verified → row counts matched for all 13 tables; drill DB dropped |
| Prod smoke | `bun run smoke:prod http://127.0.0.1:3100` | **PASS** — 24/24 checks (headers, CSP, manifest+icons, SW scope rules, app-config hygiene, no open proxy, fixture routes gated, auth endpoint leaks no secrets) |
| Share-route verify | `bun run verify:share-route` | **PASS** — uniform refusal page, revoked token dead, pre-revocation token stays dead |
| E2E (default) | `bunx playwright test` | 162 passed / 20 skipped / **3 failed** (see §9) |
| E2E (opt-in live) | `AURORA_E2E_LIVE_PLAYBACK=1 bunx playwright test e2e/live-*` | 10 passed / 1 skipped / **3 failed** (see §6, §10) |

`test:db`, `db:verify`, `db:integrity` and the restore drill were **not** re-run in the earlier
audit mission; they are green here against a live PostgreSQL.

---

## 3. Routes Tested

Every route in `src/app/(app)` plus all three API routes. "Manual" = driven in the browser
during this mission; "E2E" = covered by a green Playwright spec.

| Route | Valid data | Invalid data | Method | Result |
|---|---|---|---|---|
| `/` | renders hero + nav + search | — | Manual + E2E | PASS |
| `/search` | live search + result rendering | empty / whitespace | E2E (`live-search`, `live-playback`, `search-link`) | PASS |
| `/library` | signed-in library | signed-out prompt | E2E (`authenticated-library`) | PASS |
| `/library/playlists/[id]` | own playlist | other user's playlist → blocked | E2E (`authenticated-playlist`, `authenticated-library` Journey 7) | PASS |
| `/track/[providerTrackId]` | real YouTube track (`XetvJxkbfYU`) renders title, duration, play/queue/radio, recommendations | bogus id and internal cuid → 404 | Manual | PASS |
| `/artist/[providerArtistId]` | real artist (`UC-K1fSH5oNNJRYGdxRhsopg`) renders bio, follow, radio, tracks | bogus id and internal cuid → 404 | Manual | PASS |
| `/album/[id]` | — (no album rows exist in the DB) | bogus id → 404 | Manual | PASS (404 path) |
| `/radio` | signed-in radio session | signed-out | E2E (`authenticated-radio`) | PASS |
| `/settings` | EQ controls, scroll contract | — | E2E (`equalizer`, `scroll-contract`) | PASS |
| `/playlist/share/[token]` | live share link | revoked / unknown / cross-user tokens | E2E (`playlist-share`) + `verify:share-route` | PASS |
| `/e2e-playback/[videoId]` | fixture playback (opt-in flag) | gated → 404 without flag | E2E (`live-playback`, `error-recovery`) | PASS (gating works) |
| `/api/health` | 200 ready | — | `smoke:prod` | PASS |
| `/api/app-config` | safe metadata only | — | `smoke:prod` | PASS |
| `/api/auth/*` | session endpoint, sign-in/out | — | `smoke:prod` + E2E auth specs | PASS |
| `/api/proxy?url=…` | — | 404, no open proxy | `smoke:prod` + `live-playback` security test | PASS |

**False positive caught (not a bug):** `/track/<internal cuid>` and `/artist/<internal cuid>`
return 404. That is correct — both pages resolve through the provider
(`fetchTrackDetail` / `fetchArtistDetail`), and every link in the app is built from
`providerTrackId ?? id` (`top-result-card.tsx:39`, `artist-card.tsx:10`). `Track.providerTrackId`
is non-nullable in the schema, so the cuid fallback is unreachable. A first pass mis-read these
as "valid IDs 404"; re-testing with real provider IDs rendered both pages fully.

---

## 4. Features Tested

| Feature | Evidence | Result |
|---|---|---|
| Home (hero, sections, signed-out state) | Manual render, home capability gating audited in `AUDIT_REPORT.md` AUR-021 | PASS |
| Unified search (text, YouTube/Spotify URLs, unicode/emoji, long queries) | E2E `search-link`, `live-search`, `live-playback` | PASS |
| Search → play | Manual: clicked play on `/track/XetvJxkbfYU` | PASS |
| Dedupe (canonical, collection, playlist) | `track-dedupe.ts` behaviour exercised; QA-03 below | PASS with documented test failure |
| Track detail (play / queue next / radio / like) | Manual: 22 action buttons rendered, play started real audio | PASS |
| Artist detail (follow, play, radio, track list) | Manual: 33 buttons rendered | PASS |
| Playback (play/pause/resume/seek/next/queue/shuffle/repeat) | Manual + `live-playback` Scenarios A/C/D/F | PASS (see §10) |
| Equalizer (engage, presets, cookie persistence) | E2E `equalizer`, `equalizer-playback`; manual EQ engage on fixed build | PASS (CORS probe limitation is a documented exclusion) |
| Queue panel (count, contents, next) | E2E `authenticated-queue`, `live-playback` | PASS (QA-03 concerns the fixture, not the product) |
| Playlists (create, add, reorder, play, share) | E2E `authenticated-playlist`, `playlist-share` | PASS |
| Recently played / likes | E2E `authenticated-library`; DB rows verified (`RecentlyPlayed: 23`) | PASS |
| Radio | E2E `authenticated-radio` | PASS |
| Settings + locale switch | E2E `equalizer`; manual corrupted-cookie test (§12) | PASS |
| Offline indicator / error boundary | E2E `error-recovery` (5/5 with opt-in flag) | PASS |
| Media Session | E2E `live-media-session` (Chromium) | PASS |
| Text selection policy | `globals.css:1987-2110` documents *why* there is no global `user-select: none`; `text-selection.test.tsx` asserts it | PASS |
| Browser storage recovery | Manual: corrupted `aurora-appearance`, `aurora-eq`, `aurora-locale` cookies | PASS (§12) |

---

## 5. Critical Bugs (P0)

### QA-01 — `.register()` `TypeError` still crashes the deployed production origin
*(Same defect as `AUDIT_REPORT.md` AUR-001. Fixed in the build; **not deployed**.)*

| Field | Detail |
|---|---|
| **Bug ID** | QA-01 (AUR-001) |
| **Severity** | **P0** — production home is unusable on at least some loads |
| **Environment** | Production `http://zeus.hidencloud.com:24584`, Chromium, plain HTTP |
| **Route** | `/` (any route — the effect is in the root layout) |
| **Preconditions** | Origin is not a secure context (plain HTTP, non-loopback). No deploy of commit `569c337` yet. |
| **Exact steps** | 1. Open `http://zeus.hidencloud.com:24584/`. 2. Observe console + rendered page. 3. Repeat 4 more loads. |
| **Expected** | Home shell renders; PlayerHost initializes once and never shuts down; no console errors. |
| **Actual** | Load 1: `TypeError: Cannot read properties of undefined (reading 'register')` at `/_next/static/chunks/2hnzwn5cu7kix.js:1:15028` → `app_initialized` (05:19:28.605Z) → `app_shutdown` (05:19:29.128Z) → tree replaced by the error boundary (`Mã lỗi: UNKNOWN_ERROR`, 2 buttons, 0 inputs — no search, no nav). Load 3: same `TypeError`, UI recovered. Loads 2, 4, 5: clean. **2 of 5 loads errored; the first was fatal.** |
| **Console error** | `TypeError: Cannot read properties of undefined (reading 'register')` — chunk `2hnzwn5cu7kix.js:1:15028` |
| **Network error** | None. `hasSW: false` (insecure origin), so this is not a failed SW request — it is the guard itself being absent in the old bundle. |
| **Suspected area** | `src/components/pwa/service-worker-register.tsx` — pre-fix source read `navigator.serviceWorker` and the compiler eliminated the `if (!container) return` guard as dead code. |
| **Reproducibility** | **2/5 loads on production, 0/4 on the current build.** False-positive control: the same 4 consecutive loads on `http://192.168.1.32:3100` (insecure origin, **fixed** build) produced 0 console errors, 0 `app_shutdown`, `isSecureContext: false`, `hasSW: false`, full shell (7 inputs, 12 buttons) on every load. Root cause proven by the bundle gate + minified form `if("u"<typeof navigator\|\|!("serviceWorker"in navigator))return;`. |
| **Status** | Fixed in source and verified; **release-blocking until the new build is deployed.** Not attributable to any QA-side change. |

---

## 6. High Priority Bugs (P1)

**None open.** All nine P1 findings from the audit mission (AUR-002…AUR-009 plus the
AUR-011 documentation part) were implemented and validated then; nothing regressed them —
`lint`, `typecheck`, 2786 unit tests, `test:db`, `smoke:prod` and the full E2E default suite
all exercised the fixed code paths without failure.

---

## 7. Medium Priority Bugs (P2)

### QA-02 — `canonical-dedupe.spec.ts` fails on every run *(= AUR-020, cause still unknown)*

| Field | Detail |
|---|---|
| **Bug ID** | QA-02 (AUR-020) |
| **Severity** | P2 |
| **Environment** | Local prod build, Playwright chromium, seeded DB |
| **Route** | `/library/playlists/[id]`, `/library` |
| **Preconditions** | Authenticated E2E state (user A/B) |
| **Exact steps** | `bunx playwright test e2e/canonical-dedupe.spec.ts` |
| **Expected** | All assertions pass. |
| **Actual** | 3 assertions fail at `e2e/canonical-dedupe.spec.ts:114`, `:134`, `:155`. Present in the audit baseline and unchanged since; **not** caused by any fix in this repository's working tree (no file under `src/lib/player`, `src/lib/domain` or the E2E fixtures is modified). |
| **Console error** | None — assertion failures, not runtime errors. |
| **Suspected area** | Canonical dedupe expectations vs. playlist-row uniqueness (`@@unique([playlistId, trackId])` cannot see a duplicate that differs only in provider id). |
| **Reproducibility** | 2/2 full-suite runs (162-pass run and 161-pass run). Root cause **not established**; no speculative fix attempted. |

Carried over from the audit mission, unchanged and unverified by behaviour:
**AUR-010** (unvalidated client `Track` written into the shared catalog),
**AUR-012** (plaintext OAuth tokens), **AUR-013** (no rate buckets on 10 server actions + 3 routes),
**AUR-014** (swallowed errors), **AUR-015** (CI skips live playback/mobile/coverage/a11y),
**AUR-011** (CSRF posture on the sign-in/out action; documented, code deferred).
None of these produced a failure in this QA pass.

---

## 8. Low Priority Bugs (P3/P4)

### QA-03 — 3 opt-in live-playback tests assert a queue the product deliberately collapses

| Field | Detail |
|---|---|
| **Bug ID** | QA-03 (new; distinct from AUR-020) |
| **Severity** | P3 — test-suite defect, no product defect |
| **Environment** | `AURORA_E2E_LIVE_PLAYBACK=1`, Playwright-spawned server with the flags, real YouTube audio |
| **Route** | `/e2e-playback/[videoId]` |
| **Preconditions** | Opt-in flag set; suite self-skips otherwise (which is why it is invisible by default) |
| **Exact steps** | `AURORA_E2E_LIVE_PLAYBACK=1 bunx playwright test e2e/live-playback.spec.ts` |
| **Expected** | Scenario E (`:135`), repeat-one (`:193`) and shuffle (`:218`) pass; queue shows `2 tracks` and `E2E Fixture B`. |
| **Actual** | All three fail at the queue-content assertion: `getByText('2 tracks')` not found. Screenshot shows `Queue · 1 track` with only the now-playing entry. 8 of 11 tests in the spec pass (Scenarios A, C×2, D, F and the security test). |
| **Console error** | None. `e2e_audio_graph_health: engaged:false` (expected pre-gesture). |
| **Suspected area** | **Test fixture vs. product contract — not a product bug.** `page.tsx:34-41` builds fixture B with `providerTrackId: primary.providerTrackId`, i.e. `youtube:dQw4w9WgXcQ` — identical to A. `replaceQueue` runs `dedupeCanonicalTracks` (`src/lib/player/store.ts:570`) whose canonical key is `` `${provider}:${providerTrackId ?? id}` `` (`track-dedupe.ts:105`), so B is *by design* absorbed into A. The dedupe is intentional and documented in the store's own comments; queueing the same video twice would double-play one song. |
| **Reproducibility** | **2/2 runs** (full flagged run and a `-g "Scenario E\|repeat-one\|shuffle"` run) — 3/3 tests failed both times. **Product behaviour is confirmed correct** by `live-mobile` (mini player + real audio) and by manual playback on `/track/XetvJxkbfYU`. |

Also confirmed **not** a bug: the `JWTSessionError` / "decryption operation failed" lines in
the webserver log are the harness's own negative fixtures. `e2e/auth/session.ts` mints an
expired session by passing a negative `maxAgeSeconds` to Auth.js's `encode()`, which produces
`exp = iat - 60` exactly as logged; `auth.setup` asserts that token *is* rejected. The
tampered-token error is the other negative fixture.

### QA-04 — Equalizer keyboard test flakes under parallel load

| Field | Detail |
|---|---|
| **Bug ID** | QA-04 |
| **Severity** | P3 — test flake, product behaviour verified |
| **Environment** | Playwright, full parallel suite run (161-pass run) |
| **Route** | `/settings` |
| **Exact steps** | `bunx playwright test` (full default suite) |
| **Expected** | `eq-switch` keyboard-reachability test passes. |
| **Actual** | Strict-mode violation in one full run; the same test passes **3/3** in isolation and in the subsequent full run. No product difference. |
| **Reproducibility** | 1 occurrence; 3/3 clean on isolated re-runs. Test-harness timing, not an app defect. |

Carried over: **AUR-016** (three request ids per rate-limit denial), **AUR-017** (permissive CSP
directives), **AUR-018** (`rateLimiter.forget()` never resets), **AUR-019** (font preload
warning, investigated and left alone), plus documentation discrepancies D14/D15 from
`AUDIT_REPORT.md`.

---

## 9. Regression Results

All previously known issues were re-checked:

| Known issue | Re-check | Result |
|---|---|---|
| AUR-001 `.register()` crash | 4 loads on insecure origin, current build | **Gone** — 0 errors, 0 `app_shutdown`, `app_initialized` ×1 per load |
| AUR-001 on production | 5 loads on deployed origin | **Still present** (QA-01) |
| AUR-002 `DATABASE_URL` leak | `db:verify`, `db:integrity`, `smoke:prod` error paths | Clean — no URL/password in any error output |
| AUR-003…AUR-009, AUR-021 docs | `AUDIT_REPORT.md` §2/§19 vs. repo docs | No regression; `verify-client-bundle` and docs gates green |
| AUR-020 canonical-dedupe | full E2E ×2 | Still fails (QA-02) |
| SW guard static gate | `bun run verify:client-bundle` | `scanServiceWorkerGuard()` passes; unit fixtures in `client-bundle.test.ts` (4) pass |
| SW-absent-origin E2E | `e2e/pwa.spec.ts` | Passes in both full runs |
| §12 functional regression on fixed build | search, clear, play/pause/resume, seek to 1:00, volume 0.42, track end, signed-in `/library`, EQ engage | 0 console errors (carried from the fix mission, re-confirmed this session by manual search→play) |

Full default E2E suite: **162 passed / 20 skipped / 3 failed** (20 skips are all opt-in live
suites gated on `AURORA_E2E_LIVE_PLAYBACK=1` + `YOUTUBE_API_KEY`/Spotify credentials, or Media
Session capability — all intentional).

---

## 10. Playback Results

Manual (current build, `/track/XetvJxkbfYU`):
- Clicked **Play** → Pause control appeared; `googlevideo.com/videoplayback` returned **206**;
  progress advanced (slider `aria-valuenow` 40); 0 console errors.
- Clicked **Pause** → 0 pause controls, 2 play controls, 0 errors.

E2E (`live-playback`, opt-in, real audio, 8 passed / 3 failed):

| Scenario | Result |
|---|---|
| A — direct result plays real audio | PASS |
| C — pause stops progress without errors/retries | PASS |
| C — resume advances again without duplicate errors | PASS |
| D — seek moves toward target | PASS |
| E — queue A+B, next transitions without stale playback | FAIL (QA-03, fixture-level) |
| F — deterministic failure surfaces a sanitized error | PASS |
| repeat-one smoke | FAIL (QA-03) |
| shuffle smoke | FAIL (QA-03) |
| security — no secrets, no proxy, no persisted media URLs | PASS |

`live-mobile` (mini player stays reachable, audio progresses) and `live-media-session`
(metadata/playbackState follow real playback) both **PASS**. `live-search` skips without
`YOUTUBE_API_KEY`.

**Not verified:** the *next-track transition across a two-item queue* cannot be verified while
QA-03 stands, because the fixture's second track is deduped away before the transition is
exercised.

---

## 11. Search Results

| Input | Result |
|---|---|
| Plain text query | PASS — results render, links resolve |
| YouTube video URL (`search-link.spec.ts`) | PASS |
| Spotify track/artist/playlist URLs | Skipped — no valid Spotify credentials |
| Unicode / emoji | PASS (fixture `E2E Fixture B 🎄☃️`-style titles render) |
| Long / noisy query | PASS |
| Empty / whitespace query | PASS (clears to idle state) |
| Live search → play | PASS (`live-search` skipped; `live-playback` Scenario A covers result → real audio) |

No console errors, no result-count mismatch observed in any pass.

---

## 12. Playlist Results

- Create / add / reorder / delete / play: PASS (`authenticated-playlist`).
- Share link create → open → revoke → reopen: PASS (`playlist-share`, `verify:share-route`;
  revoked token and the pre-revocation token both stay dead, uniform refusal page).
- **User-data isolation (security-critical):** PASS. Journey 7 in
  `authenticated-library.spec.ts:72` proves user B's library never lists user A's playlist and
  direct navigation to A's playlist is refused.
- Ordering integrity: contiguous from 0, verified in the DB (`db:integrity`).

**Storage-recovery test (extra):** corrupted `aurora-appearance`, `aurora-eq` and
`aurora-locale` cookies → reload → **0 console errors**, page renders, invalid locale falls back
to the shipped default. Corrupted cookies are ignored, not trusted, and not fatal.

---

## 13. Authentication Results

| Aspect | Result |
|---|---|
| Session-protected routes (`/library`, `/radio`) | PASS — anonymous sees the sign-in prompt |
| Real session path (harness-minted JWT through the genuine `requireUser` → DAL → Prisma path) | PASS |
| Expired session | PASS — refused, as designed |
| Tampered session | PASS — refused, as designed |
| Sign-out | PASS |
| CSRF / Origin checks on the sign-in/out server action | Documented limitation (AUR-011), unchanged |
| Google OAuth over plain HTTP | **Blocked** — provider refuses non-HTTPS redirect |
| GitHub OAuth | **Blocked** — no real credentials available |
| Auth secret / token leakage | PASS — `smoke:prod` "auth response leaks no secrets"; OAuth tokens stored plaintext is AUR-012 |

**Not verified:** a real interactive OAuth login (no credentials, and Google refuses plain
HTTP). The E2E harness deliberately encodes sessions instead of driving a provider.

---

## 14. Database / Data Integrity Results

- `test:db`: 9 files / 125 tests pass.
- `db:integrity`: not-null constraints on ownership/position/track columns; playlist ordering
  contiguous from 0; every row resolves to a user; 8 migrations applied.
- `db:verify`: expected row counts; create/delete smoke track clean.
- **Restore drill**: real `pg_dump` → `pg_restore` into an isolated database → integrity
  re-verified → **all 13 tables matched row-for-row** (User 2, Track 27, Artist 13,
  RecentlyPlayed 23, SearchHistory 5, Playlist 2, PlaylistTrack 2, PlaybackState 1, …) → drill
  database dropped in `finally`. The source database was never written to.
- No orphaned rows, no duplicate `(playlistId, trackId)` pairs, no cross-user leakage found.

---

## 15. Mobile Results

- 390×844 (Pixel 7 profile), 932×430 landscape, 1280 desktop: PASS
  (`mobile-layout`, `menu-clipping`, `responsive-layers`, `layering-presence`,
  `live-mobile`).
- Mini player stays reachable and audio progresses at a phone viewport: PASS.
- Menus stay inside the viewport and on top: PASS.
- Document never scrolls sideways at 320px: asserted in `mobile-layout.spec.ts`.
- **Not verified:** real physical device (no Android/iPhone hardware available); touch
  gestures, real notch/safe-area insets, and vendor-specific audio focus remain untested.

---

## 16. Accessibility Results

- Semantics: `banner` / `main` / `navigation` landmarks, labelled `searchbox`, `role=status`
  live regions, `aria-expanded` on the language switcher — verified in the accessibility tree.
- Keyboard: `autoplay-control.spec.ts:292` asserts a control is reachable by `Tab` and honours
  `:focus-visible`; Escape dismissal is asserted in 6 specs; `equalizer.spec.ts` covers
  keyboard-driven EQ switching. All green.
- Focus visibility, focus trapping in dialogs, reduced-motion, and contrast are covered by the
  existing jsdom + Playwright suites; **no a11y scanner runs in CI** (AUR-015).
- **Not verified:** a full screen-reader pass and automated axe scan in CI.

---

## 17. Production Results (`http://zeus.hidencloud.com:24584`)

| Check | Result |
|---|---|
| Home renders | **FAIL on first load** — error boundary `UNKNOWN_ERROR`, no nav/search (QA-01) |
| Console | **FAIL** — `TypeError … reading 'register'` at `2hnzwn5cu7kix.js:1:15028` (2 of 5 loads) |
| PlayerHost lifecycle | **FAIL** — `app_initialized` → `app_shutdown` loop on the crashing load |
| `localhost` / `127.0.0.1` / `192.168.*` in HTML | **PASS** — none, across 33 requests |
| `localhost` / `127.0.0.1` in network requests | **PASS** — none |
| Secure-context features (SW, install, share) | Correctly absent — plain-HTTP origin, by design |
| Deployed build version | **Pre-fix** — commit `569c337` is not deployed |

Production is functionally healthy apart from QA-01: the crash is intermittent (2/5), so the
site appears usable on some loads, but every crashing load either replaces the page with an
error boundary or logs a fatal root-effect error and tears the player down.

---

## 18. Known Non-Bugs / Expected Behaviors

1. `serviceWorker` is absent on plain-HTTP non-loopback origins — a browser platform fact. The
   app now detects it (`!("serviceWorker" in navigator)`) instead of crashing.
2. `/track/<cuid>` and `/artist/<cuid>` → 404: routes resolve by **provider** id; links are
   built from `providerTrackId`, which is non-nullable.
3. Bogus track/artist/album ids → 404 not-found page: correct.
4. Invalid locale cookie → falls back to the shipped default; invalid appearance/EQ cookies are
   ignored: correct.
5. `app_shutdown` on route change during playback is a normal unmount, not a crash; only the
   crash-then-shutdown pattern is a defect.
6. EQ bands read as "no effect" over CORS-restricted media: a **documented, deliberate
   exclusion** (`ARCHITECTURE.md` §33.8, `docs/scope-boundaries.md`), not a regression.
7. The 20 skipped E2E tests are gated on purpose (live provider keys, Media Session support).
8. `JWTSessionError` in webserver logs = the harness's deliberate expired/tampered fixtures.
9. `PlayerEngine` owns a detached `new Audio()` (`engine-factory.ts:14`), so
   `document.querySelectorAll('audio')` is empty even during playback — by design; media
   requests (206) and the UI prove playback.

---

## 19. Unverified Areas

| Area | Why |
|---|---|
| Real OAuth login (Google/GitHub) | Google refuses plain-HTTP redirect; no GitHub credentials |
| Live Spotify search | No valid Spotify client credentials |
| Physical-device QA (touch, safe areas, audio focus) | No hardware available |
| PWA install / offline on a secure origin | Production is plain HTTP; loopback has no install prompt |
| Coverage thresholds, a11y scanner, mobile CI projects | Not wired into CI (AUR-015) |
| Long-session memory/leak profile | No long-run measurement performed |
| Two-item queue → next-track transition | Blocked by QA-03 fixture defect |
| AUR-020 root cause | Not established after two missions |

---

## 20. Release Recommendation

**Build: PASS WITH ISSUES. Deployed production: FAIL.**

The current build is releasable **once deployed**:
- No P0/P1 defect exists in the code. The `.register()` crash (QA-01) is fixed, proven on four
  consecutive insecure-origin loads, guarded by a static bundle gate and an E2E regression test.
- All gates green: lint, typecheck, 2786 unit tests, 125 DB tests, build, client-bundle budget,
  data integrity, restore drill, 24-check production smoke, share-route verification.
- 162/165 default E2E tests pass; the 3 failures (QA-02) are pre-existing and unrelated to
  this work.

**Do not ship the deployment as-is.** Production is still serving the pre-fix bundle and shows
the P0 crash. Release gate status:

| Gate criterion | Status |
|---|---|
| P0/P1 core-flow bug remaining | **FAIL** (QA-01 on the deployed origin) |
| Data corruption | PASS — DB integrity + restore drill clean |
| Auth bypass / unauthorized data access | PASS — cross-user isolation proven |
| Persistent PlayerHost crash | **FAIL on production**, PASS on the build |
| Broken playback | PASS — real audio verified (206, pause/resume/seek) |
| Non-starting production | PASS — production serves; only the client crashes |
| Critical route failure | **FAIL on production home** (error boundary on some loads) |

**Required before release:** deploy commit `569c337` (or later) to
`http://zeus.hidencloud.com:24584`, then re-run the §17 production checks and confirm 5/5
clean loads with `app_initialized` ×1 and 0 `app_shutdown`.

**Must be listed, not hidden:** QA-02 (P2, pre-existing), QA-03 (P3, test fixture),
QA-04 (P3, test flake), plus the audit mission's P2 set (AUR-010…AUR-015, AUR-011 code) and
P3/P4 set (AUR-016…AUR-019, D14, D15).

**Next cycle, in priority order:**
1. Deploy and re-validate production (QA-01).
2. Fix the `e2e-playback` fixture to use a distinct provider id so Scenario E / repeat-one /
   shuffle can actually verify queue behaviour (QA-03).
3. Root-cause `canonical-dedupe.spec.ts` (QA-02).
4. Make CI run the opt-in live suite and an a11y scanner (AUR-015).
5. Address AUR-013 (rate buckets) and AUR-014 (swallowed errors).

---

*Prepared by Senior QA / Release Validation. Read-only pass: this mission introduced no product
code changes. Temporary QA scaffolding created during testing was removed; `git status` is
clean.*
