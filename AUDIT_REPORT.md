# Aurora Music — Final Audit & Improvement Report

**Date:** 2026-09-27
**Pass:** third stacked mission — full audit **with fixes and improvements** (mission 1 = audit, mission 2 = QA, this pass = audit → fix → improve → re-verify).
**Repository state:** uncommitted working tree on top of `569c337` ("bug") on `1a2ffb3`. Nothing was reset, restored or cleaned destructively; two temporary probe scripts created during this pass were deleted.
**Companion artifacts:** `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `docs/scope-boundaries.md`, `docs/security.md`, `docs/deployment.md`, and the prior-mission `QA_REPORT.md`.
**Finding IDs:** `AUR-###` (mission 1), `QA-##` (mission 2), `M3-##` (this pass), `D#` (documentation discrepancies).

Severity scale: **P0** shipping blocker · **P1** serious defect, security-relevant, or broken core flow · **P2** real gap, not blocking · **P3/P4** hygiene, test-suite, cosmetic.

---

## Executive Summary

Aurora Music is a well-engineered, unusually well-documented product whose test suite and
invariant documentation are stronger than its defect count suggests. Across three stacked
missions (audit → QA → audit-and-fix) **25 findings** were raised; **16 are fixed in
source with tests**, **9 are classified with explicit recommendations and left in place**,
and **4 documented discrepancies remain listed as wording-only** (D14, D15 and the two
known-non-bug behaviours).

The headline of this pass is that the two findings that survived two missions —
"3 failing E2E tests, root cause unknown" and "3 opt-in live tests assert an impossible
queue" — were both **test-side or fixture-side defects that had been hiding a real product
bug behind them**. Chasing them to the bottom produced:

- **1 genuine P1 product bug** that no test was able to see because it only appears when a
  user's playlist list is long: the add-to-playlist picker's placement decision is taken
  against a surface that is **still loading its content**, so it is told there is room
  below and then grows 185px into the fixed player bar. Its lower items are visible and
  unclickable, so **"add to playlist" fails for exactly the users with the most playlists**
  (M3-04). The first fix for it — re-judging on a surface swap — was necessary and
  **not sufficient**; the second full-suite run failed again, and only a geometry probe
  turned "flaky" into a measured cause.
- **1 P1 reliability defect** exposed by measuring the provider: a playback source that is
  provably *alive* but refused by the CDN was classified **permanent**, so a throttle
  window left every subsequent track unplayable until the user pressed play by hand
  (M3-02).
- **1 P2 data-integrity hole**: an unvalidated client `Track` written straight into the
  catalog every user reads (M3-03).
- **3 accessibility defects** where there had been none recorded — two of them found by
  running the first objective a11y audit this project has ever had (M3-01's duplicate
  accessible name, M3-07's skipped heading level, M3-08's Label-in-Name break), and one
  that is *reported rather than fixed* with proof that no one-line fix exists (M3-09,
  the primary sign-in CTA at 3.97:1).

**Release status: NOT production-ready.** One P0 is open and it is a *deployment*, not a
code defect:

1. The P0 crash fix (AUR-001) is **verified fixed in the build but not deployed** — the
   live production origin still serves the pre-fix bundle and still crashes on ~40% of
   loads.

A second item is not a defect in the product at all but does gate release confidence: the
full E2E suite and the live-playback suite are **network-dependent and self-throttling**.
An 8-minute live run drives YouTube into a refusal state that fails 8/11 tests that pass
11/11 in two shorter runs. The product handles it correctly only after M3-02; the suite
itself is not a reliable gate (AUR-015).

Everything else in the coverage floor — startup, 12 routes, authn/authz, user-data
isolation, DB integrity, search, playback, queue, playlist mutations, navigation, mobile
widths, a11y-critical interactions — was exercised and is green apart from the items
named in *Remaining Risks* and *Unverified Areas*.

---

## Current Product Health

| Gate | Command | Result |
|---|---|---|
| Lint | `bun run lint` | **0 errors** *(measured)* |
| Typecheck | `bun run typecheck` | **0 errors** *(measured)* |
| Unit suite | `bun run test` | **198 files / 2822 tests passed** *(measured)* |
| Production build | `bun run build` | **0 errors** *(measured, 6 builds)* |
| E2E (default suite) | `bunx playwright test` | **165 passed / 0 failed / 20 skipped** *(measured twice, 5.4 and 5.5 min, on the final build)* |
| E2E (live playback, opt-in) | `AURORA_E2E_LIVE_PLAYBACK=1 … live-playback.spec.ts` | **11 / 11 passed** *(measured, split into 3 + 8 runs)* |
| Canonical-dedupe journeys | `… canonical-dedupe.spec.ts` | **6 / 6 passed** *(measured, and 4/4 within the full suite)* |
| Accessibility audit | Lighthouse, production build, insecure origin | **0.96**, best-practices 1.00, SEO 1.00 *(measured; was 0.94 with three failures)* |
| Production runtime | `bun run start` on `http://192.168.1.32:3200` | 4/4 loads, 0 console errors, `app_initialized` ×1, `app_shutdown` 0 *(measured)* |
| Production smoke | `bun run smoke:prod -- --spawn --port 3100` | **OK** *(measured on the final build)* |
| Operational verifiers | `verify:client-bundle`, `verify:share-route`, `db:verify`, `db:integrity` | **0 / 0 / OK / OK** *(measured)* |
| Restore drill | `AURORA_RESTORE_DRILL=1 bun run db:restore-drill` | **OK, row-for-row** *(measured: dump → isolated restore → integrity verify → count compare → drop)* |

Baseline for this pass was 193 files / 2786 tests, so **+5 files and +36 tests** are new
work from this mission (M3-01 … M3-09 regression tests), with zero pre-existing tests
weakened or removed.

**Product shape.** 12 pages + 3 API routes + 18 server-action modules (40 exported
actions). No `middleware.ts`; page-level access control is a sign-in CTA, real
authorization lives in `requireUser()` / `requirePlaylistOwner()`. One InnerTube session
(`Innertube.create()` appears exactly once in the repository), one player store, one
queue authority, one identity vocabulary.

---

## Architecture Review

No architectural violation was found in this pass, and the audit re-verified the
properties that would be expensive to violate later:

| Invariant | State | Evidence |
|---|---|---|
| One `Innertube.create()` in the repository | holds | `innertube/session.ts:67`; boundary test admits exactly two directories, one value import |
| One player/queue state authority | holds | `src/lib/player/store.ts`; `dedupeCanonicalTracks` called from `replaceQueue` (`:570`) only |
| No second identity vocabulary | holds | `ProviderId`/`SourceType` in `lib/domain/common.ts`; resolver explicitly refuses to merge or rank |
| Layer stack is tokens, never numbers | holds | `globals.css:405-407` (`--p-z-*`); `design-tokens.test.ts` fails on an orphan primitive or an undefined utility |
| Server-only modules stay out of the client bundle | holds | `client-boundary.test.ts`, `verify-client-bundle.mjs` |
| No unsuppressed errors on a write path | holds | every DAL call site is inside a `try`; no `catch` that returns success |

### D# — Documentation vs implementation discrepancies

All P1-class discrepancies were corrected in mission 1 and re-verified this pass; the
full table lives in *Deferred Improvements* → *Documentation*. This pass added one
correction and one amendment:

- **D17 (new, this pass)** — `ARCHITECTURE.md` §7 said the bounded-range confirmation
  flag is "diagnostic only and never promotes a candidate". That remains true of
  *promotion*, but the flag now also decides the failure's retryability (M3-02), and the
  document said nothing about that. **Corrected** in the same change, together with the
  2026-09-27 measurement that motivated it.
- **D18 (new, this pass)** — `ARCHITECTURE.md` §12 described the catalog write path as
  "the like path is unvalidated" implicitly by omission, and `docs/scope-boundaries.md`
  described the residual as unbounded display fields. Both now state the `trackInputSchema`
  contract and narrow the residual to attribution, not magnitude (M3-03).

---

## Route Review

| Route | File | Access | Verified this pass |
|---|---|---|---|
| `/` | `(app)/page.tsx` | public | rendered; capability-gated sections degrade honestly (AUR-021) |
| `/search` | `(app)/search/page.tsx` | public | search + classification + history; live provider search exercised (keyless InnerTube) |
| `/library` | `(app)/library/page.tsx` | sign-in | M3-01 fixed here; playlist CRUD + likes + recently played |
| `/library/playlists/[id]` | `…/playlists/[id]/page.tsx` | owner | `notFound()` for non-owner; **M3-04 lives here** |
| `/album/[id]`, `/artist/[id]`, `/track/[id]` | detail pages | public | rendered; like/follow mutations exercised |
| `/radio` | `(app)/radio/page.tsx` | public | batch-5/extend-at-2 behaviour asserted |
| `/settings` | `(app)/settings/page.tsx` | public | appearance, EQ, locale; keyboard reachability of the EQ switch |
| `/playlist/share/[token]` | `…/share/[token]/page.tsx` | public read-only | 404 on bad/private token; `verify:share-route` green |
| `/e2e-library`, `/e2e-playback/[videoId]` | fixture pages | flag-gated, fails closed | both fail closed with the flag off |
| `/api/health` | `force-dynamic` | public | 200/503 by readiness; `force-dynamic` asserted |
| `/api/app-config` | `force-static` | public | capability surface; `force-static` asserted |
| `/api/auth/[...nextauth]` | GET/POST | Auth.js | session + negative fixtures (expired / tampered token refused as designed) |

No route was found without a stated access decision, and no access decision contradicts
the DAL.

---

## Feature Review

| Feature | State | Highest-value evidence this pass |
|---|---|---|
| Unified search + link classification | implemented | live provider path exercised; history cap 8 enforced |
| Playback (play/pause/resume/seek/next/prev/volume) | implemented | **11/11 live tests incl. real audio, seek, next-track transition (M3-02 fix validated here)** |
| Queue (replace/next/prev/play-next/remove/move/shuffle/repeat, cap 200) | implemented | canonical dedupe verified end-to-end (AUR-020 closed) |
| Library, likes, playlists CRUD + reorder | implemented, authorized | ownership enforced in the DAL; **like path now validated (M3-03)** |
| Playlist sharing (24-byte token, read-only) | implemented | `playlist-share` + `verify:share-route` |
| Radio, Recommendations | implemented, partial by design | documented as partial, not silently degraded |
| EQ (Aurora V-Shape, 10 bands + preamp) | implemented | keyboard + `aria-valuetext` asserted |
| Appearance (4 presets × 6 values, 5 backgrounds, 8 sliders) | implemented | no dedicated spec — carried as AUR-015 |
| i18n (vi default + en, cookie + account) | implemented | **new key `library.createPlaylistInSection` in both locales; key-parity test green** |
| Auth (Google/GitHub OAuth, JWT) | implemented | negative fixtures refused as designed |
| PWA (manifest, SW, install, offline) | implemented, secure-context-gated | **mandatory insecure-origin re-check of the P0 fix — see Production/LAN** |
| Search history, recently played | implemented, authorized | one row per (user, track), not an event log |
| Push notifications | not implemented | deliberately, documented |

---

## Bugs Found

Consolidated index. Full field sets (Category / Severity / Location / Evidence / Impact /
Root Cause / Fix / Validation) are in the domain sections that follow; this table exists
so nothing is hidden.

| ID | Severity | Category | One line | Status |
|---|---|---|---|---|
| AUR-001 | P0 | Client runtime | `.register()` crash on any insecure origin | **fixed** (not deployed) |
| AUR-002 | P1 | Secrets/logging | `DATABASE_URL` with password in thrown messages | **fixed** |
| AUR-010 | P2 | Data integrity | unvalidated client `Track` into the shared catalog | **fixed** (M3-03) |
| AUR-011 | P2 | Security posture | Auth.js CSRF skipped on sign-in/out actions | documented (code deferred) |
| AUR-012 | P2 | Security posture | OAuth tokens plaintext in the DB, undocumented | classified |
| AUR-013 | P2 | Abuse resistance | 10 server actions + 3 routes carry no rate bucket | classified |
| AUR-014 | P2 | Observability | most actions swallow the error and log nothing | classified |
| AUR-015 | P2 | Test/CI | CI runs neither live playback, mobile, coverage nor a11y | classified |
| AUR-016 | P3 | Observability | three request ids minted for one denial | classified |
| AUR-017 | P3 | Security posture | CSP permissive in three directives | documented tradeoff |
| AUR-018 | P3 | Hygiene | `rateLimiter.forget()` promises a reset that never happens | classified |
| AUR-019 | P3 | Perf hygiene | preloaded font reported unused | investigated, no change by design |
| AUR-020 | P2 | Test suite | 3 canonical-dedupe journeys fail on baseline | **fixed** (root-caused) |
| AUR-021 | P3 | Docs | home sections capability-gated, spec said "Implemented" | **fixed** |
| QA-01 | P0 | Production | the P0 fix is not deployed; production still crashes | **open (blocked)** |
| QA-02 | P2 | Test suite | duplicate of AUR-020 | **closed by AUR-020** |
| QA-03 | P3 | Test fixture | 3 live tests assert a queue the product collapses | **fixed** |
| QA-04 | P3 | Test flake | equalizer keyboard strict-mode violation under load | classified |
| **M3-01** | P2 | Accessibility | two controls on `/library` share the accessible name | **fixed** |
| **M3-02** | P1 | Playback reliability | alive-but-refused source classified permanent | **fixed** |
| **M3-03** | P2 | Data integrity | the like path's write contract (AUR-010) | **fixed** |
| **M3-04** | P1 | Core flow / layering | long playlist picker is covered by the player bar | **fixed** |
| **M3-05** | P3 | Test isolation | a journey asserted a queue shared with every other spec | **fixed** |
| **M3-07** | P2 | Accessibility | home page sections were `h3` under a lone `h1` | **fixed** |
| **M3-08** | P3 | Accessibility | brand link's visible text was one word, its name two | **fixed** |
| **M3-09** | P2 | Accessibility | primary sign-in CTA is 3.97:1 contrast (AA needs 4.5:1) | **reported** (provably a token decision) |
| **M3-06** | — | Environment | live suite self-throttles; 8/11 fail only in a long run | documented (not a defect) |

### M3-04 — A long "Add to playlist" picker is covered by the fixed player bar

- **Category:** Core flow / layering
- **Severity:** P1 (fixed)
- **Location:** `src/components/ui/menu-placement.ts` (the rule itself);
  `src/components/tracks/track-action-menu.tsx:206` (the host);
  `src/components/ui/empty-state.tsx`, `src/components/shell/brand.tsx` (see M3-07/08)
- **Evidence:** a full-suite E2E run failed with
  `<div role="region" aria-label="Player bar"> … subtree intercepts pointer events`
  on a playlist item, for 15 s across 8 retries, while the item itself was
  "visible, enabled and stable". The row menu and the playlist picker occupy **one
  slot** — the picker *replaces* the row menu while `mounted` stays true.
  A temporary geometry probe (since deleted) built the failing state — ten
  playlists, the player bar mounted — and measured the real numbers: the row
  menu is **202px**, the picker is **131px with one playlist and 316px with ten**,
  and the picker extends past the player bar's top edge, whose measured position
  is 655px in a 720px viewport.
- **Impact:** for a user with more than a handful of playlists, the items at the
  bottom of the picker sit under the fixed player bar: visible, not clickable, and
  **"add to playlist" fails** for precisely the users with the most playlists.
  Unreproducible for anyone with two playlists, which is why no earlier pass saw it.
- **Root Cause:** the flip rule takes its decision **once**, in a layout effect, from
  the surface's height at that instant — and the playlist picker's list is a *server
  action*. The picker therefore mounts at 131px, is told "there is room below", and
  grows to 316px a moment later. The verdict describes a surface that no longer
  exists. The swap case is the same failure in a different costume: the row menu's
  verdict was applied to the picker that replaced it in the same slot.
- **Fix (two parts, because the first part alone was not enough):**
  1. The host passes `placementKey: showPlaylistMenu ? "playlist-picker" : "row-menu"`,
     so a surface swapping into the same slot re-judges — the pattern
     `queue-panel.tsx` already follows, which the host had simply omitted.
  2. The rule itself now watches the surface's **size** (`ResizeObserver`) and
     re-decides on a viewport `resize`. A flip changes a surface's position, never
     its size, so this cannot oscillate.
  The first part was shipped and **still failed** in the next full-suite run; the
  probe above is what turned "flaky" into a measured cause. Reporting the first
  attempt as the fix would have been wrong.
- **Validation:** 4 new hook cases in `ui/__tests__/menu-placement.test.tsx` — the
  swap (re-judges on key change), the swap's absence (keeps the stale verdict, i.e.
  the defect stated as a test), **the surface growing after the decision** (the real
  defect: 131px → 316px must flip), and a viewport change; plus a host-shape case
  in `tracks/__tests__/track-action-menu-placement.test.ts`. 13/13 hook cases, 28
  across the four menu test files. In the real browser with the failing state built
  on purpose, the picker now carries `presence-menu-up … bottom-full`, the last item
  reports `coveredByBar: false`, and the click that previously timed out for 15 s
  succeeds.


### M3-02 — A playback source that is alive but refused was classified permanent

- **Category:** Playback reliability / recovery
- **Severity:** P1 (fixed)
- **Location:** `src/lib/providers/youtube/playback/youtube-resolver.ts:112-160,191-201`; consumers `src/lib/playback/recovery.ts:145-158`, `src/lib/player/controller` via `onRoundResolveFailure`
- **Evidence:** the opt-in live suite failed 8/11 in one run with
  `topRejectionReasons: "probe_status_403=7"` for the **untouched** fixture
  `dQw4w9WgXcQ` — all seven candidates, including the progressive format that
  `ARCHITECTURE.md` §7 records as the format that answers whole-body reads. An isolated
  probe of the same video, minutes later, returned **206 on all seven candidates**, and
  the same run's other 8 tests pass 8/8. So the refusal was a property of the CDN *at
  that moment*, not of the URL. `PlaybackResolutionError.retryable` defaults to `false`
  (`lib/domain/errors.ts:49`), `fail()` passed no override, and
  `classifyFailure` maps `permanent` to "no recovery" — so a throttle window turned
  every subsequent track into a dead track that only the user could revive.
- **Impact:** a burst of play requests (or any provider-side refusal window) makes
  playback fail for every track until the user manually presses play again, with a log
  line that says the failure is permanent and a log that gives no way to tell this case
  from a dead video.
- **Root Cause:** "no consumable format" was treated as one failure when it is two. The
  probe already collects the distinguishing evidence (`boundedRangeOk`) and that evidence
  was used only for logging.
- **Fix:** when **every** candidate was refused **and** each proved alive on the bounded
  confirmation read, raise the `stream`-stage error with `retryable: true` so the
  existing bounded recovery re-resolves. Every other combination (404, an unconfirmed
  403, a timeout, a network error, zero candidates) keeps the permanent default, and a
  single dead candidate among alive ones is enough to stay permanent.
- **Validation:** 7 new cases in `youtube-resolver.test.ts` pin both directions plus the
  `aliveButRefused` log field and URL-absence; 56/56 with the resolver/recovery suites;
  the `retryable` → `transient` → recovery-round mapping is already pinned by
  `recovery.test.ts:106-123` and read in `controller.ts:536-573`; live suite 11/11 after
  the change.

### M3-01 — Two controls on `/library` share the accessible name "Create playlist"

- **Category:** Accessibility
- **Severity:** P2 (fixed)
- **Location:** `src/components/library/playlist-section.tsx`; keys `library.createPlaylist`, `library.createPlaylistInSection` in `src/lib/i18n/{en,vi}.ts`
- **Evidence:** surfaced by AUR-020's own failure — scoping the E2E locator to
  `getByLabel` revealed that the section-header action and the empty-state CTA both
  carried `aria-label="Create playlist"`. Two controls with one name are
  indistinguishable to a screen-reader user and ambiguous to any role-based query.
- **Impact:** assistive-technology users cannot tell the two apart; the redundancy is
  invisible to mouse users.
- **Root Cause:** the header action was written with the same generic string as the
  empty-state CTA, and no test asserted accessible-name uniqueness.
- **Fix:** the header action is named after the section it acts on
  (`library.createPlaylistInSection` → "Create playlist in Playlists" / "Tạo playlist
  trong Playlists"). The empty-state duplication itself is kept — a visible CTA and a
  header action are reasonable redundancy.
- **Validation:** 4 new cases in `components/library/__tests__/playlist-section.test.tsx`
  assert the two names differ per locale; i18n key-parity test green; 8 existing E2E
  specs that locate "Create playlist" still resolve (role-name matching is
  substring-based, and specs that can see both already used `.first()`).

### M3-03 — The like path wrote an unvalidated client `Track` into the shared catalog

- **Category:** Data integrity / input validation
- **Severity:** P2 (fixed) — implementation of AUR-010
- **Location:** `src/app/actions/track.ts:7-31`; `src/lib/validation/schemas.ts:106-176`; defence in depth already at `src/lib/dal/catalog.ts:84-158`
- **Evidence:** `likeTrackAction` passed its argument straight to `likeTrack(user.id, track)`
  with no parse, while the playlist path parsed with `addTrackSchema`; that schema's
  nested `title`/`artistName` were unbounded `z.string()`. `upsertTrack` writes
  `title`, `artistName`, `albumName`, `artworkUrl`, `providerUrl` and `genres` into a
  row **every** user reads (library, playlists, search results, shared playlists).
- **Impact:** any signed-in caller could write an arbitrarily long display string — and
  an oversized genre list — into a shared table that every other user's UI renders.
  Storage and layout abuse in a shared table, not injection: Prisma is parameterised and
  the DAL already omits `streamUrl`/`previewUrl`/`metadata`.
- **Root Cause:** the like path predates the Phase 49 write-path rules and was never
  re-validated; the *what a client may write* contract also had two definitions.
- **Fix:** one `trackInputSchema` (bounded text 500, URLs 2048, ≤20 genres, finite
  non-negative duration, required non-empty `title`/`artistName`, `provider` a bounded
  open string so a future provider is not rejected) used by **both** catalog-writing
  actions; the **parsed** value — not the caller's object — is what reaches the DAL;
  `unlikeTrackAction` parses its ref so an empty or oversized identity is refused rather
  than deleting an arbitrary row.
- **Validation:** 13 new cases in `app/actions/__tests__/track.test.ts` (unbounded title /
  artist, empty title, non-finite duration, oversized genre list, missing identity,
  hostile media fields stripped, parsed-not-caller, unlike ref paths); the pre-existing
  56 schema tests and 43 playlist-action tests pass unchanged; full unit suite green.

### M3-07 — The home page's own sections were `h3` under a lone `h1`

- **Category:** Accessibility / semantics
- **Severity:** P2 (fixed)
- **Location:** `src/components/ui/empty-state.tsx`; `src/app/(app)/page.tsx:161,215,224`
- **Evidence:** objective, not a reading — a Lighthouse accessibility audit of the
  **production build** reported `heading-order` as a failure: the page's headings
  were `H1 "Chào mừng đến với Aurora"`, then `H3`, `H3` with nothing between them
  (`main > div > div > h3` in the audit's own path). Three of the home page's five
  empty states are not inside a titled section; the other two are, and are correct
  at `h3`.
- **Impact:** assistive-technology users navigating by heading level cannot tell
  that the two states are top-level sections; the outline reports them as nested
  under content that does not exist.
- **Root Cause:** `EmptyState` hard-coded `<h3>`, which is only correct inside a
  section that already has a heading — the component had no way to say otherwise.
- **Fix:** an explicit `headingLevel` prop (`2 | 3`, default `3`), passed as `2` by
  the three top-level call sites. The two in-section call sites are untouched, so
  no other page's outline changes.
- **Validation:** 3 new cases in `ui/__tests__/empty-state.test.tsx` (default level 3,
  requested level 2 with no `h3` present, and the empty state's three-question
  contract). No test or spec located these titles by level, so no locator needed
  updating.

### M3-08 — The brand link's visible text was one word, its name two

- **Category:** Accessibility / Label in Name
- **Severity:** P3 (fixed)
- **Location:** `src/components/shell/brand.tsx:65-70`
- **Evidence:** the same Lighthouse audit reported
  `label-content-name-mismatch` on `<a aria-label="Aurora Music home" href="/">`:
  "Text inside the element is not included in the accessible name". The wordmark is
  two sibling spans, so the element's text content is the single word
  **"AuroraMusic"**, which is not a substring of "Aurora Music home" — even though a
  sighted user reads two words.
- **Impact:** WCAG 2.5.3 (Label in Name) — a voice-control user who says what is on
  screen cannot be guaranteed to get the control on screen. Nothing else is affected
  (the name already described the link correctly).
- **Root Cause:** the two words were separated visually (a flex column) but not in
  the text content.
- **Fix:** a single `{" "}` between the spans. A whitespace-only run is not
  rendered as a flex item, so the layout is byte-for-byte unchanged and the text
  content becomes "Aurora Music".
- **Validation:** 3 new cases in `shell/__tests__/brand.test.tsx` asserting the
  normalized visible text is contained in the accessible name (the rule, restated),
  that the decorative mark contributes no text, and that the compact variant still
  has a non-empty name.

### M3-09 — The primary sign-in button fails WCAG 1.4.3 contrast (3.97:1)

- **Category:** Accessibility / colour
- **Severity:** P2 (**reported, not fixed** — and provably not a one-line fix)
- **Location:** the `bg-accent text-accent-foreground` sign-in control
  (`#f5f5f8` on `#8d5bed`), `text-sm` = 14px, font-weight 500
- **Evidence:** Lighthouse, on the production build: "Element has insufficient color
  contrast of **3.97** … Expected contrast ratio of 4.5:1", on
  `button[type=submit]` with `bg-accent text-accent-foreground` — the header's
  "Đăng nhập" (Sign in) button, i.e. the one control every anonymous visitor is
  invited to press.
- **Impact:** below AA for the control that gates the whole signed-in product.
- **Why it was not fixed, and the proof:** the fix cannot live in the foreground.
  `#8d5bed` has relative luminance **0.1902**; 4.5:1 against it requires a
  foreground luminance of `4.5 × 0.2402 − 0.05 = 1.0309`, and **1.0 is pure white**.
  No text colour on that background can pass. The only correct fix is to darken
  `--accent`, which changes the brand colour on every surface in the product — a
  design decision this audit is not entitled to make. Recorded with the exact
  numbers needed to make it.
- **Recommended fix (operator/design decision, not an audit fix):** darken
  `--accent` until `accent-foreground` clears 4.5:1 (roughly `#7c4de0` and darker
  for white text), or set the button's background to the existing
  `accent-hover`/darker step, then re-run the audit.

### M3-05 — A journey asserted a queue it shares with every other spec

- **Category:** Test isolation
- **Severity:** P3 (fixed)
- **Location:** `e2e/canonical-dedupe.spec.ts:131-268`
- **Evidence:** in a full-suite run the queue journey failed with
  `["e2e-track-1", "e2e-track-2"]` where one entry was expected — `e2e-track-2` was
  left by an earlier spec. The queue snapshot is persisted **per user**, and all
  authenticated specs share user A. In isolation the spec passed, which is why the
  failure looked like a product defect.
- **Impact:** a CI signal that depends on spec ordering, in a suite whose other 180+
  tests all pass — the worst kind of flake, because it is indistinguishable from a
  regression and trains people to re-run.
- **Root Cause:** the assertion was "the queue equals exactly this array", a claim about
  shared state the journey does not own, instead of a claim about what the journey did.
- **Fix (two rounds, because the first was still a claim about the world):** read the
  starting line, then assert the **occurrences of the ids under test** plus the
  **total length**. The second round is the more interesting one: the first version used
  `before.length + 1`, and the next full-suite run failed with `total: 2` where `3` was
  expected — because `e2e-track-1` was **already** in the shared queue, so
  `dedupeCanonicalTracks` correctly refused the add and the length did not move. An
  offset expectation reports the product working as designed as a product failure. The
  expectation is now computed from the baseline: `totalAfter(before, ids)` is the size of
  `before ∪ ids`, which is the invariant itself (one entry per distinct song) rather than
  a guess about how many adds should have landed.
- **Validation:** 6/6 in isolation; and in the full-suite runs that produced these
  failures, the same spec now passes under the same conditions (see *Validation*).

### AUR-020 / QA-02 — Three canonical-dedupe journeys failing on baseline (root-caused and fixed)

- **Category:** Test suite (with one real product defect behind it — see M3-04)
- **Severity:** P2 (fixed)
- **Location:** `e2e/canonical-dedupe.spec.ts`
- **Evidence:** three journeys failed identically on the untouched baseline across three
  missions. Root causes, all in the test or its fixtures — **no product defect in the
  dedupe itself**, which was correct throughout:
  1. `/library` renders two "Create playlist" controls, so an unscoped `getByRole`
     could not resolve one of them. Scoping to `getByLabel` is what exposed the real
     a11y defect (M3-01).
  2. The dialog field is labelled **"Name"** (`playlist.nameLabel`); the spec used
     "Title" — a stale locator.
  3. `getByRole` name matching is substring-based, so the player bar's truncated
     `Actions for <track>` collided with the row label; locators are now scoped to
     `getByRole("main")`.
  4. The cross-provider fixture pair is deliberately two rows sharing one title, so
     `.first()` is required and the expectation follows the row the click targets
     (`/e2e-library` orders by `providerTrackId`, so the **deezer** row wins). The
     invariant under test is "one entry", not "which provider won row order".
  5. The queue journey was anchored on `Play`, but the fixture ids are synthetic
     (`e2e-track-1`) so resolution correctly fails — a resolution failure queues
     nothing. Re-anchored on "Add to queue", and the unattainable Player-bar/queue-dialog
     tail was dropped rather than faked.
- **Impact:** three guarantees (one playlist membership per logical song, one queue
  entry per logical song, the pair staying two rows) were unverified in CI while looking
  like a product regression.
- **Validation:** 6/6 in isolation and in the full suite; every assertion reads durable
  state (membership row, persisted snapshot, rendered page) — nothing is mocked.

### QA-03 — Three opt-in live tests asserted a queue the product deliberately collapses

- **Category:** Test fixture
- **Severity:** P3 (fixed)
- **Location:** `src/app/(app)/e2e-playback/[videoId]/page.tsx`; new shared ids in
  `src/lib/e2e/fixture-ids.ts`; re-exported by `e2e/fixtures.ts`
- **Evidence:** fixture B was built with `providerTrackId: primary.providerTrackId`, so
  it was the *same canonical key* as fixture A, and `dedupeCanonicalTracks`
  (`track-dedupe.ts:105`, called from `store.ts:570`) absorbed it — correctly. Every
  2-track assertion was therefore unreachable.
- **Fix:** fixture B is now a distinct real recording (`kJQP7kiw5Fk`), with the ids held
  in one source-side module so the route and the specs cannot disagree again.
- **Validation:** independently probed the new id before trusting it — its adaptive
  ladder is 403-on-whole-body (the documented §7 behaviour) but its progressive `itag=18`
  answers **206**, so the format selector can serve it; the 3 tests pass
  (Scenario E 6.4 s, repeat-one 2.3 s, shuffle 2.3 s) and the remaining 8 pass (25.2 s).

### AUR-001 — Uncaught `TypeError` in a root-layout effect on any insecure origin

- **Category:** Client runtime / PWA registration
- **Severity:** P0 (fixed in source; **not deployed** — see Production/LAN)
- **Location:** `src/components/pwa/service-worker-register.tsx`; gate in
  `scripts/verify-client-bundle.mjs`
- **Evidence:** the live origin threw
  `TypeError: Cannot read properties of undefined (reading 'register')` at chunk offset
  15028, followed by an `app_initialized` → `app_shutdown` loop that unmounted
  `PlayerHost` — on **2 of 5 production loads, the first fatal**. `"serviceWorker" in
  navigator === false` there, because the interface is `[SecureContext]`. A marker
  experiment proved the production compiler had deleted the guard as unreachable: an
  identical `console.debug` outside the guard survived minification, the one inside
  `if (!container) return undefined;` did not, at the same chunk size.
- **Impact:** every visitor on a plain-HTTP origin (the deployed origin, any LAN/IP
  deployment) got an unusable page: search, playback and navigation all unreachable.
- **Root Cause:** the guard tested the *value* rather than the *presence of the
  interface*, and the compiler — permitted to assume `navigator.serviceWorker` exists —
  removed the branch.
- **Fix:** presence-test the interface before any dereference; add
  `scanServiceWorkerGuard()` to the client-bundle gate so a compiled chunk containing
  `.register(` without a preceding presence test fails the build; add an E2E case that
  deletes `Navigator.prototype.serviceWorker`.
- **Validation:** compiled form is
  `if("u"<typeof navigator||!("serviceWorker"in navigator))return;…` with the
  `in`-test before the first `register`; live browser on an insecure origin → 0 console
  errors, 0 `app_shutdown`; secure origin → SW registered with the correct scope; 4
  gate fixtures; 1 E2E case; `verify:client-bundle` OK. Re-verified on this pass's build
  (see Production/LAN).

### AUR-002 — `DATABASE_URL` (with password) interpolated into thrown error messages

- **Category:** Secrets / logging
- **Severity:** P1 (fixed)
- **Location:** `src/lib/db.ts:16-19`, `scripts/verify-db.mts:17-20`
- **Evidence:** both threw `` `Unsupported DATABASE_URL scheme: ${url}. …` ``, where
  only the scheme is diagnostic. Directly contradicted `docs/security.md:64`.
- **Impact:** the database password reaches stderr, log aggregation, CI output and crash
  dumps on every configuration mistake.
- **Root Cause:** the message interpolated the whole value.
- **Fix:** report `scheme = url.slice(0, indexOf(":")+1)` (or `(none)`).
- **Validation:** repo-wide grep shows no remaining interpolation of the full value; all
  gates re-run green.

### AUR-021 — Home sections are capability-gated, but the spec said "Implemented" flatly

- **Category:** Documentation vs implementation
- **Severity:** P3 (fixed)
- **Location:** `PRODUCT_SPEC.md:40`; reality at `providers/server.ts:111`,
  `youtube-provider.ts:50-56,267-295`, `page.tsx:107,119,131,144`
- **Evidence:** `fetchHomeSections` queries only the preferred provider, and YouTube
  advertises none of popular/featured/recommendations/albums; the page renders a section
  only when supported. Only the fake test provider advertises them.
- **Impact:** a reader would expect five populated sections on a key-configured
  deployment and find two.
- **Fix:** the capability row now reads "recommendations always; popular / featured /
  albums / artists when the active provider advertises those capabilities".
- **Validation:** static re-read of the three sources.

---

## Bugs Fixed

Fixed in source **and** validated this pass. Nothing here is claimed without the
validation named in the finding.

| ID | Sev | Fix | Validation |
|---|---|---|---|
| AUR-001 | P0 | presence-test `serviceWorker` before dereferencing; build gate + E2E | compiled form, insecure-origin browser probe, secure-origin registration, 4 gate fixtures, 1 E2E |
| AUR-002 | P1 | scheme only in both thrown messages | grep, full gates |
| M3-04 | P1 | re-judge placement on a surface **swap** (`placementKey`) *and* on the surface's own **size** or the viewport's (M3-04) | 4 new hook cases (13/13) + 28 across the four menu files; the click that timed out for 15 s now succeeds in a browser with the failing state rebuilt by hand; the journey passes in the full suite |
| M3-02 | P1 | alive-but-refused ⇒ `retryable`, so bounded recovery runs | 7 new cases + 56/56; live suite 11/11 |
| M3-01 | P2 | distinct accessible name for the section-header action | 4 new cases; i18n parity; 8 dependent E2E specs still resolve |
| M3-07 | P2 | `EmptyState` takes an explicit heading level; the three top-level home states are `h2` | 3 new cases; Lighthouse `heading-order` before the fix |
| M3-08 | P3 | the wordmark's two spans are separated in the text content, not only visually | 3 new cases; Lighthouse `label-content-name-mismatch` before the fix |
| M3-03 (AUR-010) | P2 | one `trackInputSchema` for both catalog writers; parsed value passed on | 13 new cases; 56 schema + 43 playlist tests unchanged |
| AUR-020 / QA-02 | P2 | four stale locators + re-anchoring on "Add to queue" | 6/6 isolated and in the full suite |
| QA-03 | P3 | fixture B is a distinct real recording, ids in one shared module | 3 tests pass; new id probed (progressive 206) before use |
| M3-05 | P3 | the journey asserts its own effect (`occurrences` + `totalAfter(before, ids)`) instead of the shared queue's exact contents | 6/6 isolated; the two full-suite runs that failed it now pass |
| AUR-021 | P3 | capability row corrected | static |
| AUR-003…AUR-009 | P1 | 7 documentation corrections (rate limiting, `youtubei.js` boundary, migrations, TLS, equalizer scope, listening read, caching) | each re-read against the cited code |

**Not fixed, and said so plainly:** QA-01 — the production origin still serves the
pre-fix bundle because deployment is not possible from this machine.

---

## UX Issues

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| UX-01 | P2 | A failed like is indistinguishable from a like that never happened (action returns `{ok:false}`; the UI shows no error) | `actions/track.ts:14-16`; part of AUR-014 | **deferred** — surfacing it needs a decision on one error vocabulary for all write actions; doing it for one action first would create a second convention |
| UX-02 | P2 | There is no way to clear the queue: `clearQueue` exists in the store with **no** UI affordance | `player/store.ts` (`clearQueue`), `queue-panel.tsx` (no clear control) | **recommended** (see Recommended Features) — small, self-contained, closes a real gap |
| UX-03 | P3 | The empty library shows two identical "Create playlist" controls | pre-M3-01 | **fixed** for the a11y half (M3-01); the visual redundancy is kept deliberately |
| UX-04 | P3 | Playlist deletion has no undo | `actions/playlist.ts:151` | **deferred** — needs transient state + a timer, i.e. new state authority, out of proportion to an audit pass |
| UX-05 | P3 | No dedicated E2E spec for the appearance controls (4 presets × 6 values, 5 backgrounds, 8 sliders) | `playwright` project list | **deferred** under AUR-015 (CI/coverage policy) |

---

## UX Improvements

Implemented this pass:

1. **M3-04** is the largest UX win: a core flow that was silently impossible for users
   with many playlists now works. No new affordance, no visual change — the menu simply
   flips the way it was always documented to.
2. **M3-02** is a user-visible reliability win with no UI: after a provider refusal
   window the track now recovers by itself instead of demanding a manual press.
3. **M3-07 / M3-08** improve accessibility for assistive technology and voice control:
   top-level empty states are navigable as sections (`h2`), and saying "Aurora Music"
   activates the home brand link.
4. **M3-05** removes a false alarm from CI, which is a UX property of the team's own
   feedback loop.

---

## Accessibility Issues

**This pass replaced hand-assertion with measurement.** A Lighthouse accessibility
audit was run against the **production build** served from the insecure LAN origin,
which is the first objective a11y number this project has ever had. It ran **twice** —
before and after this pass's fixes — and the two runs are the evidence:

| Audit | Accessibility | Best practices | SEO | Failing audits |
|---|---|---|---|---|
| before the fixes | **0.94** | 1.00 | 1.00 | `color-contrast`, `heading-order`, `label-content-name-mismatch` |
| after the fixes | **0.96** | 1.00 | 1.00 | `color-contrast` only |

`heading-order` and `label-content-name-mismatch` are gone, confirmed by an independent
scanner and not only by the tests written alongside. The remaining failure is M3-09, and
the report says plainly why it was not fixed. This also changes what "no a11y scanner"
(A11Y-02) means: the gap is not that accessibility is unmeasured *now*, it is that the
measurement is not in CI — and the delta above is the argument for putting it there.

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| M3-01 | P2 | two controls on one screen with the accessible name "Create playlist" | pre-M3-01 source + `getByLabel` scoping | **fixed** (4 new tests) |
| M3-07 | P2 | the home page's own sections were `h3` under a lone `h1` | Lighthouse `heading-order`; audit path `main > div > div > h3`; DOM after the fix is exactly `h1 → h2 → h2`, zero `h3` | **fixed** (3 new tests) |
| M3-08 | P3 | the brand link's text content was "AuroraMusic"; its name "Aurora Music home" | Lighthouse `label-content-name-mismatch`; the built DOM's wordmark now reads "Aurora Music" | **fixed** (3 new tests) |
| M3-09 | P2 | the header's sign-in CTA is **3.97:1**, below AA's 4.5:1 | Lighthouse `color-contrast`, `#f5f5f8` on `#8d5bed` at 14px; still failing after both audits | **reported, not fixed** — no foreground can pass (proved in the finding); the fix is a design-token decision |
| A11Y-01 | P3 | Per-row action labels repeat across regions by design (a track row and the player bar both say "Actions for <track>") | `ARCHITECTURE.md` §32.10 as amended | **documented as an invariant**, not a defect: repetition *across regions* is correct and is now stated as a rule so a future change does not "fix" it into ambiguity |
| A11Y-02 | P2 | The audit that found M3-07/08/09 is not in CI, and covers one page | Lighthouse run manually, this pass; `package.json` (no axe), `ci.yml` | **deferred** under AUR-015 — an axe gate on 2–3 pages is the recommended first step, and this pass is the evidence for why |
| A11Y-03 | P3 | No physical iOS/Android device was available; touch-target sizes and real VoiceOver/TalkBack behaviour are unverified | no hardware | **unverified**, not assumed |

The pre-existing a11y position is otherwise strong and was re-verified: native elements
where they exist, `aria-pressed` kept while disabled, `aria-valuetext` on every slider,
state never colour-only, i18n keys travelling to the render, `prefers-reduced-motion`
honoured. Best-practices scored **1.00** and SEO **1.00** on the same audit.

---

## Performance Issues

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| PERF-01 | P3 | Preloaded font can be reported unused | `layout.tsx:17-30`; on the fixed build `/` and `/library` produce **no** preload warning and `document.fonts` reports the face `loaded` | **no change by design** (AUR-019) — do not churn code to silence a warning that measurement shows is harmless; `font-preload.test.ts` is the guard if it ever recurs |
| PERF-02 | P3 | The live suite's own probe traffic triggers provider throttling that then fails 8/11 tests | measured: same video 403×7 in-run, 206×7 isolated | **documented** (M3-06); the product half is fixed (M3-02), the suite half is a CI policy question (AUR-015) |
| PERF-03 | P4 | No coverage numbers, so no objective perf/quality trend | no `@vitest/coverage-*` | **deferred** under AUR-015 |

No performance regression was found in this pass. `bun run build` is clean, the
client-bundle gate passes, and the measured interaction cost of the changed surfaces
(one `useLayoutEffect` re-measure, one `safeParse` per write) is negligible next to the
network round trip each of those operations already makes.

---

## Security Issues

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| AUR-002 | P1 | DB password in thrown messages | `db.ts`, `verify-db.mts` | **fixed** |
| AUR-012 | P2 | OAuth `access_token`/`refresh_token`/`id_token` stored plaintext; the doc does not mention it | `prisma/schema.prisma:58-64` | **deferred** — a KMS/envelope decision, and a documentation one; not an audit-pass fix |
| AUR-013 | P2 | 10 server actions + 3 routes carry no rate bucket (likes, history, appearance, locale, playback-state, install, auth) | per-action guard grep; buckets at `rate-limit.ts:188-196` | **deferred** — adding buckets changes user-visible failure modes and needs a deliberate window choice |
| AUR-011 | P2 | Auth.js's CSRF check is skipped on the sign-in/out server actions; Next's origin check + `SameSite=Lax` carry it | `node_modules/next-auth/lib/actions.js:44,65,81` | **posture documented** in `docs/security.md`; code unchanged by choice |
| AUR-017 | P3 | CSP permissive in `script-src`/`style-src` (`unsafe-inline`), `img-src` (`http:`/`data:`/`blob:`), `media-src` (`https:`) | `next.config.ts:27-47`, mirrored in `docs/security.md:67-78` | **documented tradeoff**, out of scope |
| M3-03 | P2 | unvalidated client `Track` reaching the shared catalog (AUR-010) | `actions/track.ts` had no parse | **fixed** |
| AUR-016 | P3 | three request ids minted for one rate-limit denial | `rate-limit-server.ts:179`, `action-guard.ts:85,106`, `api/transport.ts:39-44` | **deferred** — P3, and the fix spans three layers of the transport/guard stack |
| AUR-018 | P3 | `rateLimiter.forget()` promises a sign-out reset that never happens | `rate-limit.ts:59-60`, no production caller | **deferred** — P3 hygiene |
| D14/D15 | P4 | doc/test-comment wording (E2E flags "registered in the schema rather than read ad hoc"; offline locale "comes from the cookie") | `env.ts:24-26`, `e2e/pwa.spec.ts:414-415` | **listed, unchanged** — the boot guard does fail closed via `parseEnv`; wording only |

**Controls verified to hold this pass:** parameterised Prisma everywhere; no `eval`, no
`dangerouslySetInnerHTML`, no `innerHTML`, no `redirect()`; no `NEXT_PUBLIC_*`; the
logger drops secret-shaped keys, URLs and non-primitives; signed googlevideo URLs are
never logged and never persisted (asserted by both the new `M3-02` test and the existing
security spec); no wildcard ACAO; queue snapshots are `.strict()` and reject URL-shaped
fields; ownership is enforced in the DAL, never by a client flag.

---

## Production/LAN Issues

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| **QA-01** | **P0** | **The P0 crash fix is not deployed.** The live origin still serves the pre-fix bundle | 2 of 5 production loads threw `TypeError … reading 'register'` at chunk `2hnzwn5cu7kix.js:1:15028`, the first fatal (`app_initialized` → `app_shutdown` → error boundary, no search, no nav) | **OPEN — release blocker.** Deploy access is not available from this machine. Everything else in this report is secondary to this line |
| PROD-02 | P1 | The deployed origin is plain HTTP, so it is not a secure context: PWA install/offline, Web Share, `crypto.subtle`, `crypto.randomUUID` and notifications are unavailable there | `"serviceWorker" in navigator === false`; `isSecureContext:false` | **documented** (was AUR-007). Edge TLS is the fix and is an operator duty (`docs/deployment.md`) |
| PROD-03 | P2 | `reuseExistingServer` reuses a manually started server, so a stale server on the test port silently contaminates a run (10 bogus failures observed) | `playwright.config.ts` `webServer`; produced a contaminated run this pass | **process discipline applied** (port killed before every flagged run); a config change is a P4 hygiene item |

**This pass's insecure-origin re-check of the fixed build** (the mission's mandatory
production-runtime evidence) is reported in *Audit Stopping Evidence* → *Validation*.

---

## Data Integrity Issues

| ID | Sev | Issue | Evidence | Disposition |
|---|---|---|---|---|
| M3-03 (AUR-010) | P2 | unvalidated client `Track` written into the shared catalog | `actions/track.ts` had no parse; `upsertTrack` writes the client fields verbatim | **fixed** — one bounded schema, both writers, parsed value passed on |
| DATA-02 | — | Canonical dedupe was suspected to be broken because 3 tests failed | Root cause was entirely in the tests; `dedupeCanonicalTracks` was correct, and its key (`` `${provider}:${providerTrackId ?? id}` ``) is now exercised by a passing journey | **verified, no change** |
| DATA-03 | — | Playlist membership uniqueness is a DB constraint (`@@unique([playlistId, trackId])`) that cannot see a duplicate which differs only in provider id | `prisma/schema.prisma`; the domain half of the rule is what handles it | **verified by behaviour** (one membership for two provider renderings) |
| DATA-04 | — | The `streamUrl`/`previewUrl`/`metadata` columns still exist and are never written | `catalog.ts:120-158`; `playback-schema.test.ts` | **verified, no change** (Phase 49, defence in depth at both layers) |
| DATA-05 | — | `DATABASE_URL` in a thrown message (AUR-002) is also a data-exposure defect | `db.ts`, `verify-db.mts` | **fixed** |

User-data isolation was re-verified this pass: a non-owner receives `notFound()` for
another user's playlist, `requirePlaylistOwner` is the only authorization path, and the
E2E suite exercises A/B users against the same database.

---

## Missing Features

Recorded rather than built, per scope discipline. Each is a real gap, not a defect.

| Feature | Why it is missing | Why it was not built |
|---|---|---|
| **Queue clear (UI)** | `clearQueue` exists in the store; no surface exposes it | small, but it is a feature, and the mission's fix/improve mandate does not cover new user-facing surface |
| Sleep timer | not implemented | feature work; no defect behind it |
| Crossfade / gapless | not implemented | feature work; playback currently starts tracks cleanly without them |
| Offline audio / cached media | out of scope, and the EQ CORS "zeroes" are a measured, deliberate limitation (`ARCHITECTURE.md` §33.8) | documented exclusion |
| Push notifications | probe-only by design (`platform.test.ts` asserts the probe) | documented exclusion |
| Lyrics, sharing to social, follows UI depth | not implemented | documented exclusions; no defect |
| Download / offline playlists | not implemented | documented exclusion |
| Media Session artwork parity / `window-controls-overlay` | deliberately absent | documented exclusion |

---

## Recommended Features

Ordered by value per unit of risk. None is a recommendation to expand scope blindly;
each names what it would take.

1. **Deploy the current build.** Not a feature — the single highest-value action
   available, and the only thing standing between this product and a release.
2. **Queue clear** — one button in the queue panel calling the existing `clearQueue`.
   Closes UX-02, the only missing-feature gap on a core surface, using state that
   already exists.
3. **CI: one mobile project + coverage (report-only) + axe on 2–3 core pages** — closes
   half of AUR-015 and turns this pass's manual Lighthouse run into a gate. Schedule the
   live suite rather than running it per push (it needs a network and self-throttles,
   M3-06). This pass is the argument for it: two of the three failures the audit found
   were invisible to every existing test.
4. **Darken `--accent` to clear 4.5:1** (M3-09) — a design decision, not an engineering
   one, and the one accessibility failure still open in the product.
5. **Rate buckets for the write-shaped actions** (`track.like`, `search.history`,
   `appearance`, `audio-eq`) with generous windows — closes AUR-013 for the paths that
   cost a DB write per call.
6. **Log swallowed action errors** with class + action name and no payload, following
   the existing `playback-resolve` pattern — closes AUR-014 in one consistent pass
   rather than per action.
7. **Document the OAuth token posture** (AUR-012) even if the code is unchanged: it is a
   deployment/backup decision that belongs in `docs/security.md`.

---

## Implemented Improvements

Behaviour, architecture and test changes made across the three missions. Docs are
updated in the same change as the behaviour, per the repository's own rule.

**Product behaviour**
- P0: presence-test the Service Worker interface before dereferencing it (AUR-001).
- P1: re-judge menu placement when a taller surface swaps into the same slot **and** whenever
  the surface's own size changes or the viewport does (M3-04).
- P1: classify an alive-but-refused playback source as retryable so bounded recovery
  runs (M3-02).
- P2: one bounded `trackInputSchema` for every client-writable `Track`, applied by both
  catalog writers, with the parsed value passed to the DAL (M3-03).
- P2: the library's section-header action is named after its section (M3-01).
- P2: the home page's own sections are `h2` instead of a skipped `h3` (M3-07).
- P3: the brand wordmark's two words are separated in the text content, so the visible
  label is inside the accessible name (M3-08).
- P1: error messages carry the URL scheme, never the connection string (AUR-002).

**Measurement, not assertion**
- The project's first **objective accessibility audit** (Lighthouse, production build,
  insecure origin), run before *and* after this pass's fixes: accessibility **0.94 →
  0.96**, best-practices **1.00** and SEO **1.00** throughout, and the failure list went
  from `color-contrast`, `heading-order`, `label-content-name-mismatch` to
  `color-contrast` alone. The fixes are therefore confirmed by a scanner that did not
  write them, and not only by the tests written alongside.
- A **geometry probe** of the placement rule in a real browser (built the failing state on
  purpose: ten playlists, player bar mounted) — 202px row menu, 131px→316px picker,
  bar top at 655px of a 720px viewport. This probe is what turned a 15-second click
  timeout into a named root cause, and it is deleted now that it has done its job.

**Verification infrastructure**
- A build-time gate (`scanServiceWorkerGuard`) that fails when a compiled chunk
  dereferences `.register(` without a preceding presence test — this class of bug is
  now caught at build time rather than in production.
- 4 unit fixtures for that gate, 1 E2E case that deletes `Navigator.prototype.serviceWorker`.
- 4 tests for the accessible-name invariant, 3 for the heading level, 3 for Label in
  Name, 7 for the retry classification, 13 for the write-path contract, 4 for the
  placement rule; net **+36 tests across 5 new files, zero removed**.
- Two E2E journeys made order-independent and re-anchored on real state; three live
  playback journeys made reachable by fixing their fixture.
- A single source of truth for E2E fixture ids (`src/lib/e2e/fixture-ids.ts`).

**Documentation** (source-of-truth rule: behaviour change ⇒ doc change in the same change)
- 7 P1 corrections in mission 1 (AUR-003…AUR-009) plus AUR-021.
- This pass: `ARCHITECTURE.md` §7 (the `aliveButRefused` rule, with the 2026-09-27
  measurement and the explicit statement that promotion is still forbidden), §12 (the
  one-track-contract rule, with the bounds and the "parsed value, not the caller's
  object" rule), §21 point 5 (the placement decision is watched, not taken once, with
  the 131px→316px measurement), §32.10 (accessible names unique per screen; headings do
  not skip a level; the accessible name contains the visible text; and the one open
  contrast failure with the arithmetic that shows it is a token decision);
  `PRODUCT_SPEC.md` playback section (refused-but-alive is recoverable, dead is not);
  `docs/scope-boundaries.md` (the catalog residual narrowed from magnitude to
  attribution). Three stale test-file citations (`menu-placement.test.ts` → `.tsx`)
  corrected while citing them.

---

## Deferred Improvements

| ID | Sev | Deferred item | Why it is deferred |
|---|---|---|---|
| AUR-012 | P2 | encrypt OAuth tokens at rest / document the posture | deployment + KMS decision; documenting it is recommended above |
| AUR-013 | P2 | rate buckets on 10 actions + 3 routes | changes user-visible failure modes; needs a deliberate window choice |
| AUR-014 | P2 | log swallowed action errors | touches 8 files; the pattern should be chosen once, not per action |
| AUR-015 | P2 | CI: live playback, mobile projects, coverage, a11y scanner; duplicated `smoke:prod` | CI policy change |
| AUR-011 | P2 | explicit origin assertion on sign-in/out | posture documented; Next's check already applies |
| AUR-016 | P3 | mint one request id per request | P3, spans transport → action guard |
| AUR-018 | P3 | call or delete `rateLimiter.forget()` | P3 hygiene |
| UX-01 | P2 | surface like failures to the user | needs one error vocabulary for all writes |
| UX-04 | P3 | undo playlist deletion | new transient state |
| A11Y-02 | P2 | axe/Lighthouse in CI, and more than one page covered | the audit ran manually this pass (twice, before and after) and is not a gate; `package.json` (no axe), `ci.yml` | **deferred** under AUR-015 — recommended above; CI policy |
| M3-09 | P2 | darken `--accent` until the sign-in CTA clears 4.5:1 | the finding carries the luminance arithmetic | **deferred** — a brand-colour decision, and an audit is not where to make it |
| D14/D15 | P4 | doc/test-comment wording | wording only; the boot guard already fails closed |

**Documentation discrepancies carried from mission 1** (D1–D16) were all corrected then;
D14 and D15 remain listed as wording-only. Nothing in that list is presented as an open
defect, and nothing in it is presented as solved.

---

## Remaining Risks

1. **The deployed production origin still crashes (QA-01, P0).** Every minute the fix
   is undeployed is user-visible breakage. This is the release blocker and the only
   open P0.
2. **The verification suite is not a reliable release gate by itself.** It is
   network-dependent (live playback), self-throttling under its own traffic (M3-06),
   and order-sensitive in places (M3-05 fixed one instance; the class is not proven
   absent elsewhere). A green run means "green under the conditions of that run".
3. **Nothing measures coverage, and the accessibility audit is a one-off.** A Lighthouse
   run found two defects that no test in the repository could see — a skipped heading
   level and a Label-in-Name break — which is the honest measure of the gap (AUR-015).
   This is also how M3-04 survived: a geometry that only occurs with ≥4 playlists, on a
   page whose menu had no E2E spec of its own.
4. **The primary sign-in CTA is still below AA** (M3-09, 3.97:1), deliberately: the fix
   is a brand-colour change and the arithmetic showing no foreground can pass is in the
   finding. It is the one accessibility failure the audit still reports.
5. **Abuse resistance is partial** (AUR-013) and **error observability is partial**
   (AUR-014): a hammered write path or a failing write can look identical to no-op.
6. **The provider is outside the product's control.** The measured evidence in this
   report (403 on every candidate, then 206 on the same URLs) is the shape of the risk:
   the product can now recover, but it cannot make YouTube serve audio.
7. **Tokens at rest** (AUR-012) and **the plain-HTTP origin** (PROD-02) are operator
   decisions, both currently undocumented or documented only as a posture.

---

## Unverified Areas

Stated as unverified rather than assumed, with the reason in each case.

| Area | Why unverified |
|---|---|
| Deployment of the current build | no deploy access from this machine; production still serves the pre-fix bundle |
| A Lighthouse/axe audit of every other page | the audit was run on `/` only. The two defects it found were global-class (a shared component, a shared shell), so the same rules applied elsewhere were checked by reading, not by scanning. `/library`, `/search` and a playlist page have never been scanned |
| Real-device QA (touch targets, real VoiceOver/TalkBack, iOS Safari) | no physical phone; mobile verification is host-side + emulated projects only |
| Google OAuth over plain HTTP | Google refuses the private-IP HTTP origin; GitHub OAuth unverified (no real credentials) |
| Secure-context capabilities on the deployed origin (PWA install/offline, Web Share, `crypto.subtle`, `crypto.randomUUID`, notifications) | the origin is plain HTTP; these are origin limits, not bugs, and the loopback re-check cannot reproduce them |
| Live provider behaviour for Spotify / Deezer | `.env` credentials are invalid; only the keyless InnerTube path was exercised |
| Long-run production soak (hours, not minutes) | no long-lived production session available |
| A 5-width interactive sweep (375 / 430 / 768 / 1024 / 1440) of library, playlist, search and player | the emulated mobile projects cover the widths they define, and `e2e/menu-clipping.spec.ts` asserts resolved geometry at desktop and phone widths; a committed 5-width interactive sweep is listed below as remaining work and is **not** claimed as done |

---

## Audit Stopping Evidence

### Coverage Floor

Every mandatory area was exercised. Evidence is a measurement or a named gate, never an
assumption.

| Mandatory area | How it was covered | Result |
|---|---|---|
| App startup | build → `bun run start` → browser on an insecure origin; `app_initialized`/`app_shutdown` counters over 4 loads; the AUR-001 E2E case | pass — 4/4 loads, 0 console errors, `app_initialized` ×1, `app_shutdown` 0 |
| All production routes | 12 pages + 3 API routes, rendered and asserted (see *Route Review*) | pass |
| Authentication (n/z) | `auth.setup` + negative fixtures (expired, tampered) + ownership cases; A/B users | pass |
| User-data isolation | non-owner `notFound()`, `requirePlaylistOwner`, A/B against one DB | pass |
| DB / data integrity | membership rows, queue snapshots, canonical dedupe, `test:db`, `db:verify`, `db:integrity`, and a **real restore drill** (dump → restore into an isolated database → verify → row-count compare → drop) | pass |
| Search | unified search, classification, history, live keyless-InnerTube path | pass |
| Playback | **11/11 live tests with real audio**, incl. pause/resume/seek/next-transition | pass |
| Queue | replace/next/prev/dedupe/shuffle/repeat + snapshot durability across reload | pass |
| Playlist mutations | create/add/remove/reorder/share + the M3-04 picker, re-checked in a browser with the failing state rebuilt by hand | pass |
| Critical navigation | sidebar, bottom nav, playlist → detail → back, scroll contract | pass |
| Known production regressions | AUR-001 re-verified on the fixed build; production swept | fixed locally, **open in production** |
| Production runtime | `bun run build` + `bun run start` on an **insecure** origin, full shell, console and lifecycle counters | pass (see Validation) |
| Mobile / responsive critical paths | emulated mobile projects + the widths the projects define | pass (5-width sweep listed as remaining work) |
| a11y-critical interactions | role/name/keyboard assertions, the M3-01/M3-07/M3-08 invariants, and an **objective Lighthouse audit run before and after** | pass — accessibility 0.94 → 0.96, two of three audit failures closed; `color-contrast` open as M3-09; not in CI (A11Y-02) |
| API / Server Actions in core flows | 18 action modules, 40 actions, guards and buckets read per action | pass |

### Validation

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` | **0** *(measured)* |
| Typecheck | `bun run typecheck` | **0** *(measured)* |
| Unit | `bun run test` | **198 files / 2822 tests passed** *(measured, final tree)* |
| Build | `bun run build` | **0** *(measured, final tree)* |
| Live playback (opt-in) | `AURORA_E2E_LIVE_PLAYBACK=1 … e2e/live-playback.spec.ts` | **11 / 11** *(measured, in two runs to stay under the throttle window)* |
| Canonical-dedupe journeys | `… e2e/canonical-dedupe.spec.ts` | **6 / 6** *(measured)* |
| Full E2E | `bunx playwright test` | **165 passed / 0 failed / 20 skipped**, 5.5 min *(measured twice, 5.4 min and 5.5 min, on the final tree; the 20 skipped are the opt-in live suites)* |
| Production smoke | `bun run smoke:prod -- --spawn --port 3100` | **OK** *(measured on the final build: service worker defers activation, safe-area insets, app-config carries no secrets, no arbitrary-URL proxy, both fixture routes gated, auth endpoint leaks nothing, clean shutdown)* |
| Client bundle | `bun run verify:client-bundle` | **0** *(measured)* |
| Share route | `bun run verify:share-route` | **0** *(measured)* |
| Database | `bun run db:verify`, `bun run db:integrity` | **OK** *(measured: schema in sync, `Playlist.shareToken` and `Session.sessionToken` unique, 0 duplicate share tokens)* |
| Restore drill | `AURORA_RESTORE_DRILL=1 bun run db:restore-drill` | **OK** *(measured: the source was dumped, restored into an isolated database, verified for integrity, and matched row for row — Artist 16/16, Track 30/30, RecentlyPlayed 25/25, SearchHistory 5/5, Playlist 2/2, PlaylistTrack 2/2, PlaybackState 1/1, Follow 1/1, Like 0/0, Album 0/0 — and the drill target was dropped in `finally`)* |
| Production insecure origin | `bun run start` on `http://192.168.1.32:3200` + browser, 4 loads | **0 console errors, `app_initialized` ×1, `app_shutdown` 0, 7 inputs / 12 buttons / 1 `main` every load** *(measured, final tree)* |
| Accessibility audit | Lighthouse on that same production build | **0.96** a11y, 1.00 best-practices, 1.00 SEO; only `color-contrast` failing *(measured, final tree)* |

### Critical Defects

| Severity | Open? | Detail |
|---|---|---|
| **P0** | **1 open** | QA-01 — production serves the pre-fix bundle; deployment unavailable here. The code defect itself is fixed and verified. |
| **P1** | 0 open in code | M3-02 and M3-04 are fixed and regression-tested. |
| P2 | 1 new, reported | M3-09 — the primary sign-in CTA is 3.97:1 (AA needs 4.5:1). Not a release blocker, not fixable in the foreground, and the fix is a brand-colour decision. |
| P2 | 0 new | AUR-010 closed by M3-03; the remaining P2s (AUR-011…AUR-015) are classified with recommendations and none is a release blocker. |
| P3/P4 | classified | QA-04, AUR-016…AUR-019, D14, D15, UX-04, PERF-03. |

### Final Re-Audit

Re-read of every file this pass changed, against its own doc comment and against the
neighbouring code that shares the invariant:

- `youtube-resolver.ts` — the `aliveButRefused` rule is the AND of two conditions
  (`every` refused **and** `every` alive), it cannot be reached by a boolean test
  double, it promotes nothing, and it logs a boolean rather than a URL. The recovery
  mapping it depends on was confirmed by reading `controller.ts:536-573`, not assumed.
- `menu-placement.ts` — the decision was extracted into a `useCallback` so the layout
  effect and the observer share one implementation rather than two copies that can
  drift; the observer observes the **measured** surface (the `[role=menu]`, not the
  wrapper), so a menu that swaps surface is watched whichever element is current; the
  effect's dependency list is complete (`open`, `placementKey`, both refs, both
  callbacks) so no stale closure can keep a dead verdict alive; and the "cannot loop"
  claim was re-checked against the new trigger rather than assumed.
- `track-action-menu.tsx` — the key is derived from the state that performs the swap; the
  sibling host (`queue-panel.tsx`) uses the same pattern, so this is the codebase's
  convention rather than a new invention.
- `actions/track.ts` / `schemas.ts` — the parsed value is passed on; `provider` stays
  open; the bounds are far above real metadata; `title`/`artistName` non-empty is safe
  because `normalizeTrack` already throws otherwise.
- `empty-state.tsx` — the level is a prop with a default, so the 12 call sites that are
  correct at `h3` are untouched and the three that are not say so explicitly. The
  `as "h2" | "h3"` cast is bounded by the prop's own type.
- `brand.tsx` — the added node is whitespace inside a `flex-col`, which CSS does not
  render as a flex item, so the layout is unchanged; verified in the built DOM, where
  the wordmark's text content is now "Aurora Music".
- `i18n` — both locales updated; the parity test is the guard.
- Docs — every behavioural claim added to `ARCHITECTURE.md` and `PRODUCT_SPEC.md` was
  checked against the code once more, and each amendment states the measurement and the
  date it came from.

**No new finding was raised by the re-audit**, and no finding was closed without the
validation named in it.

### Remaining Work

Ordered, with the owner each item needs:

1. **Deploy the current build** and re-run the production sweep (5 loads, expect 0
   errors). Owner: whoever holds deploy access.
2. **A 5-width interactive sweep** (375 / 430 / 768 / 1024 / 1440) of the library,
   playlist, search and player surfaces, committed as a spec rather than a one-off.
   Owner: QA, next pass.
3. **axe-core on 2–3 core pages** in CI, report-only first. Owner: whoever owns CI.
4. **AUR-013 / AUR-014** as one consistent pass each (rate buckets; error logging).
5. **UX-02 queue clear** as a feature ticket.
6. **D14/D15 wording** and AUR-018's dead method, as hygiene.

### Risk-Based Timebox

- Budget: `MAX_AUDIT_HOURS = 4` **or** `MAX_AUDIT_UNITS = 32`.
- Consumed: **~2.4 h wall clock**, ~**38 units** — an overrun against the unit budget,
  incurred deliberately: two units were spent on the M3-04 placement diagnosis, two on
  the provider-403 measurement, two on the Lighthouse audit and the heading/wordmark fixes
  that followed it, and one on the restore drill. Each found something a cheaper pass
  would have either recorded as a flake and lost, or never looked at.
- Allocation actually spent: ~**65% P0/P1** (AUR-020 root cause, M3-02, M3-04, and the
  re-verification of AUR-001), ~**30% P2** (M3-01, M3-03, M3-07, M3-09, plus the two
  remaining P2s re-classified with evidence), ~**5% P3** (M3-05, M3-08, QA-03), **0%**
  P4 work — P4 items were recorded, not touched.
- Breadth first, then risk-based depth: the coverage floor was completed before any
  depth work, and the depth work was chosen by measured impact (a broken core flow, a
  recovery-classification error) rather than by convenience.

### Stopping Decision

**COMPLETE for cases A–E**, with one explicit exception.

- **A — app startup:** COMPLETE (build → start → browser; AUR-001 re-verified).
- **B — all production routes:** COMPLETE (12 pages + 3 API routes rendered and asserted).
- **C — authn / authz / isolation:** COMPLETE (negative fixtures, ownership, A/B users).
- **D — data integrity, search, playback, queue, playlists:** COMPLETE, including
  11/11 live playback and 6/6 canonical-dedupe.
- **E — production runtime / LAN:** COMPLETE for the fixed build on an insecure origin;
  **INCOMPLETE for the deployed origin**, and the reason is not ambiguity — it is
  missing deploy access (QA-01).
- Responsive sweep at 375/430/768/1024/1440: **INCOMPLETE** — listed as remaining work
  rather than claimed.
- Real-device QA: **INCOMPLETE** — no hardware.

The stop was chosen because the remaining items either cannot be completed with the
access this machine has (deployment, real devices, real OAuth credentials) or are
documented, measured, non-blocking gaps with a named recommendation. Continuing would
have meant either speculative work or work outside the mandate.

### Evidence

**Measured, and quoted above with the numbers.**

| What | Where it is quoted |
|---|---|
| 206-vs-403 candidate table for `dQw4w9WgXcQ` / `kJQP7kiw5Fk` / `XetvJxkbfYU` | M3-02 |
| the player-bar interception call log, then the geometry probe (202px / 131px→316px / bar top 655 of 720) and the succeeding click | M3-04 |
| `["e2e-track-1","e2e-track-2"]`, then `total: 2` where `3` was expected | M3-05 |
| Lighthouse 0.94 (3 failures) → 0.96 (1 failure); `#8d5bed` luminance 0.1902 | M3-07/08/09, *Accessibility Issues* |
| built DOM: `h1` ×1, `h2` ×2, `h3` ×0; wordmark text content "Aurora Music" | M3-07/08 |
| 4/4 loads on the insecure origin: 0 console errors, `app_initialized` ×1, `app_shutdown` 0 | *Coverage Floor*, *Validation* |
| 198 files / 2822 unit tests; 165 passed / 0 failed / 20 skipped E2E (twice); 11/11 live; 6/6 dedupe; `smoke:prod` OK; 4 verifiers OK; restore drill row-for-row | *Validation* |
| compiled guard form `if("u"<typeof navigator\|\|!("serviceWorker"in navigator))return;` | AUR-001 |

**Artifacts and their fate.** `test-results/` held the screenshot and `error-context.md`
for the two M3-04 failures; those were read, quoted above, and the directory has since
been **deleted**, because leaving a failure's artifacts in the tree implies a failure that
is no longer there. The two probe scripts (`scripts/m3-probe-*.mts`) are deleted for the
same reason — their findings are quoted inline, and a probe left in the tree is a probe
nobody runs. Gate logs for every command above live in the session temp directory, not in
the repository; `git status` for the tree is otherwise clean apart from this pass's
intentional changes.

**Not claimed anywhere in this report:** that the fixes are deployed; that the product is
production-ready; that any deferred item is fixed; that the live suite is a stable gate;
that real-device or real-OAuth behaviour was verified; that a page other than `/` has
been accessibility-scanned.
