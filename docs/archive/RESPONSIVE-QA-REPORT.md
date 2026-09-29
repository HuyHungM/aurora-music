# Aurora Music — Responsive / Frontend QA Report

Date: 2026-09-28
Environment: local Next.js dev server `http://127.0.0.1:3000`
(local HTTP auth enabled via gitignored `.env.local`)
Tooling: Playwright (Chromium), driven by throwaway scripts under `.qa/`.

## Overall result

**READY** — with 2 low-severity touch-target observations and 1 test-coverage
gap carried forward. No blocking responsive, layout, interaction or
accessibility defect remains open. Every route rendered at every tested
viewport without horizontal overflow once the three fixes below were applied.

| Count | |
| --- | --- |
| Routes tested | 16 |
| Viewports tested (full matrix) | 12 |
| Between-breakpoint widths swept | 8 |
| Confirmed bugs fixed | 3 |
| Open defects (blocking) | 0 |
| Open observations (non-blocking) | 2 |
| Test gaps | 1 |
| False positives dismissed | 2 |

## Bugs fixed

### AUR-QA-01 — Fixed-size artwork rendered at the source aspect ratio

- **Severity:** High (visual)
- **Route:** `/search` (track/album/artist rows), any `Artwork` with a fixed
  `size` and a non-square source.
- **Viewport:** all (measured 44×25 instead of 44×44, 88×49 instead of 88×88).
- **Root cause:** Tailwind preflight sets `img { height: auto }`, which beats
  the `height` attribute, so the browser derived height from the source
  thumbnail's intrinsic aspect ratio. next/image also warned about a
  single-axis-modified image.
- **Fix:** add `aspect-square` to the fixed-size `Image` branch in
  `src/components/ui/artwork.tsx` (plus a `fill` escape hatch for callers that
  size the box with CSS).
- **Regression:** search row thumbnails now 88×88 / 44×44; no next/image
  warning; verified across 320/360/390/768/1280/3440.

### AUR-QA-02 — Compact language menu overflowed the left viewport edge

- **Severity:** Medium (visual / interaction)
- **Route:** header language switcher (`compact` variant) on every authenticated
  and anonymous route.
- **Viewport:** 320–360px phones (overflow grew as the viewport shrank:
  −52px @320, −36px @344, −20px @360).
- **Root cause:** compact trigger sits near the **left** edge of the mobile
  header but the menu was right-aligned (`right-0`), so a 192px panel extended
  past `x = 0`.
- **Fix:** `right-0` → `left-0` in the compact branch of
  `src/components/i18n/locale-switcher.tsx`.
- **Regression:** `clipL = clipR = clipB = 0` at 320/344/360/390/414/568/640/
  768/900/1023; screenshot confirms; switching to `vi` and back still works.

### AUR-QA-03 — Row-level “Add to playlist” picker opened off-screen

- **Severity:** High (interaction)
- **Route:** track/album row action menu → “Add to playlist”, and the
  row-level triggers on `/library`, playlists and artist pages.
- **Viewport:** all widths (overflowed right by 138px @1280 and 162px @360).
- **Root cause:** the no-`placement` branch of the picker class list had lost
  `right-0`. The 240px picker then used static positioning from the trigger’s
  left edge; every row trigger sits at the right edge of its row, pushing the
  panel past the viewport. The component docstring already declared
  `absolute right-0 top-full` as the contract.
- **Fix:** restore `right-0` in the fallback branch of
  `src/components/tracks/add-to-playlist-menu.tsx`. The queue passes explicit
  `placement`, so it is unaffected.
- **Regression:** `clipL/clipR/clipB = 0` and 0 hit-test failures across
  320/360/390/768/1280/3440; queue path unchanged.

## Open observations (non-blocking, not fixed)

- **OBS-01 — `Artwork` has no `onError` fallback for a non-null broken `src`.**
  A track whose stored artwork URL 404s or fails DNS shows a blank/broken image
  rather than the placeholder. Only triggered here by QA seed data
  (`https://example.invalid/...`), so it is not user-reachable in production
  data, but a real provider can return a stale URL. Low.
- **OBS-02 — Sub-24px interactive targets.** The only controls under 24px tall
  are the `Seek` and `Volume` range inputs (16px tall but 96–192px wide, so the
  effective horizontal target is large) and one 22px-tall text link in search
  results (multi-word, ~116–926px wide). No sub-24px square icon buttons were
  found. Accepted.

## Test gap

- **GAP-01 — Row-level “Add to playlist” picker is untested.** The existing
  `e2e/menu-clipping.spec.ts` only exercises the queue path (which passes an
  explicit `placement`). AUR-QA-03 lived entirely in the uncovered branch.
  Recommend adding a spec that opens the picker from a row action menu at a
  phone width and at ≥1280.

## False positives dismissed

- **MENU_CLIPPED_BY_CHROME** (`{area:"menu"}` @1280x800 in `.qa/interact.json`):
  the geometry check compared the menu’s bottom against the player bar’s top,
  but the dropdown paints at `z-dropdown` (60) above the player (`z=40`). Not a
  defect.
- **QUEUE_OPEN_FAIL** @1024/1280: the harness locator picked the hidden
  mini-player “Up next” button. Opening the queue via the visible selector
  succeeds (dialog “Queue” 384×239 at both widths).

## Console & network findings

All messages observed are expected and **not** app defects:

- `net::ERR_NAME_NOT_RESOLVED` for `https://example.invalid/does-not-exist.jpg`
  on `home-auth`, `library`, `playlist-many` — QA seed artwork URLs.
- `404 (Not Found)` on the `not-found` route — the deliberate not-found page.
- next/image missing-`width` warnings and React DevTools / preload hints are
  filtered as dev noise.

No hydration errors, uncaught exceptions, React key warnings, or failed
same-origin requests were observed.

## Route × viewport matrix

Legend: **P** = pass (rendered, no overflow, no nav error, no console error
beyond the noted expected ones); **·** = not in this route set.
Every cell was actually exercised by `.qa/responsive.mts`.

Viewports: 320×568, 375×812, 390×844, 414×896, 568×320 (landscape),
768×1024, 1024×768, 1280×720, 1440×900, 1920×1080, 2560×1440, 3440×1440.

| Route | 320 | 375 | 390 | 414 | 568L | 768 | 1024 | 1280 | 1440 | 1920 | 2560 | 3440 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` (anon) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/` (auth) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/search?q=…` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/search` (idle) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/track/[id]` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/artist/[id]` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/artist/qa-artist-long` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/album/qa-album-1` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/library` (auth) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/library` (anon) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/library/playlists/[many]` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/library/playlists/[one]` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/radio` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/settings` | P | P | P | P | P | P | P | P | P | P | P | P |
| `/_not-found` (bogus path) | P | P | P | P | P | P | P | P | P | P | P | P |
| `/playlist/share/[bad token]` | P | P | P | P | P | P | P | P | P | P | P | P |

**Between-breakpoint sweep** (widths 639/640/767/768/1023/1024/1279/1280
across `/`, `/search`, `/track`, `/artist`, `/library`, `/playlist`,
`/radio`, `/settings`, `/_not-found`): no overflow, no nav error
(`.qa/transitions.json` = `[]`).

**Interaction / state coverage** (not part of the grid above):

- Playback starts from a real track; mini player and full player verified at
  320/360/390/414 and landscape 568/812 — controls reachable, no overflow,
  `Escape` closes the full player.
- Queue dialog opens and fits at 1024 and 1280.
- Dialogs (create playlist, share, change artwork, rename) open and fit at 360
  and 1280.
- Keyboard: focus ring present on every tabbed control; tab order from the home
  logo through header nav, language and account is logical.
- State coverage: normal, long-text (`artist-long`, playlist long name),
  minimal (1-track playlist), empty (`/search` idle, `/library` anon redirect),
  error (`/playlist/share/bad-token`, `_not-found`), logged-in and logged-out.

## Not tested / blocked

- Real authenticated OAuth sign-in flow (local HTTP auth used a minted
  session cookie instead).
- Audio output fidelity / cross-browser rendering (Chromium only).
- Backend/infra beyond what a frontend test needed (out of scope).
- Alternative browsers (Firefox, WebKit) and real devices.

## Documentation obligation (not applied)

`AGENTS.md` requires behaviour changes to update `PRODUCT_SPEC.md` and/or
`ARCHITECTURE.md`. The three fixes are CSS/class-only presentation corrections
with no product-surface change, but the rule is broad. **Not applied** here
because `ARCHITECTURE.md` and `docs/*` contain the user's in-progress
uncommitted work; leaving that decision to the author avoids clobbering it.

## Verification gates

Run after the fixes, against the running dev server:

- Full matrix regression (`.qa/responsive.mts`, 16 routes × 12 viewports):
  zero findings; console/network noise limited to the expected QA-seed
  `example.invalid` failures and the not-found 404.
- Between-breakpoint sweep (`.qa/transitions.mts`, 8 widths × 9 routes):
  no findings.
- Targeted locale-menu harness: `clipL = clipR = 0` at 320/344/360/390/414/
  568/640/768/900/1023 — all clear.
- Targeted add-to-playlist harness: `clipL = clipR = clipB = 0`,
  0 hit-test failures at 320/360/390/768/1280/3440 — BAD = 0.
- `bunx eslint` on the three changed files: exit 0.
- `bun run typecheck`: exit 0.

## Artifacts

- QA scaffolding (screenshots, JSON, harnesses) was removed at the end of the
  run; this report is standalone.
- A gitignored `.env.local` enabling local HTTP auth is intentionally left in
  place (it is the only remaining copy of that config).
