# PHASE 4 — APPLICATION SHELL

## PHASE 4 STATUS
COMPLETE. All spec acceptance criteria met; full validation suite green (typecheck, lint, 114 unit tests, 51 DB tests, production build, DB verify). No regressions to Phase 1–3 surfaces. Phase 5 (player/playback/queue) NOT started, per scope.

## ROUTES
Production build route tree:

```
┌ ƒ /                                  (app) Home — provider sections + authenticated library previews
├ ○ /_not-found                        root not-found
├ ƒ /api/auth/[...nextauth]            Auth.js handlers (Phase 3)
├ ƒ /library                           signed-out explainer OR playlists / liked / recently played
├ ƒ /library/playlists/[id]            read-only playlist detail (owner-only; else 404)
├ ƒ /radio                             mood stations (static, labeled "coming later") + provider preview
└ ƒ /search                            GET ?q= — server-side provider search + loading/empty/error states
```

- Home moved from `src/app/page.tsx` into the `(app)` route group.
- `loading.tsx` skeletons for `/`, `/search`, `/library`, `/radio`; client `src/app/error.tsx`; `(app)/not-found.tsx`.
- All dynamic pages are `ƒ` server-rendered on demand (session-bound); no static data fetches.
- Next 16 convention honored: `searchParams` / `params` are awaited Promises.

## SHELL
- **Desktop (lg+):** fixed left sidebar (brand, 4-item nav, user chip / sign-in control). **Mobile (<lg):** sticky header (brand, search entry, auth) + fixed bottom nav with safe-area padding; min 44px touch targets.
- Global layout: sticky translucent header, centered `max-w-6xl` main column, `pb` reserved for the mobile nav, no horizontal overflow.
- Dark-first token system in `globals.css` (background `#08070d`, surfaces 1–3, subtle/strong borders, text tiers, accent `#8b5cf6`, aurora gradient) mapped through Tailwind v4 `@theme inline`; `color-scheme: dark`; visible focus rings.
- Active nav state via `usePathname` with `aria-current="page"` (exact root match, prefix match for nested).
- Layout renders the shell in `(app)/layout.tsx` only; API/auth routes remain unwrapped.

## AUTH
- Header shows user chip (avatar + name + sign-out) when signed in; otherwise a sign-in form for the first configured provider.
- No OAuth credentials configured → muted, non-interactive **"Sign-in unavailable"** chip (never a broken button/dead loop).
- Server actions `signInWith(formData)` / `signOutUser()` in `src/app/actions/auth.ts` validate the provider against `getAuthAvailability(getEnv())` before calling Auth.js; unknown providers no-op.
- `/library` and `/library/playlists/[id]` are protected server-side: signed-out users see an explainer CTA (Library) or 404 (playlist route). Ownership enforced in the DAL, never client-supplied.
- No session data or env secrets leak to client bundles (see client-boundary test).

## DATA
- Additive DAL gap-fill (existing mappers/signatures untouched — regression-guarded by the preserved asserting test suites):
  - `mapTrackRow(row)` in `dal/mappers.ts` — included track row (artist+album) → displayable domain `Track` (title/artist/album/artwork/duration/genres).
  - `dal/library.ts` — `getLibraryOverview(userId, { likedLimit, recentLimit })` combining playlists (createdAt desc), likes (createdAt desc) and recently played (playedAt desc) with full track display metadata; `getOwnedPlaylist(userId, id)` (owner check → null); `getPlaylistDetail(userId, id)` → `{ playlist, tracks: Track[] }`.
- Home/Library surfaces only claim real data: "Recently played / Liked music / Your playlists" are personalized and labeled as such; "Popular/Featured" are explicitly labelled "from catalog provider", never "for you".

## PROVIDER
- New `providers/server.ts`: `getShellProviders(env)` registers the Mock provider always and Jamendo only when `JAMENDO_CLIENT_ID` is set (idempotent against the global registry); `getPreferredProvider` picks the first non-mock provider; `fetchHomeSections`/`fetchHomeSection` are failure-tolerant (`Promise.allSettled` → empty lists, no unhandled rejections).
- With no client id, / and /search degrade to the always-working mock provider; adding `JAMENDO_CLIENT_ID` to `.env` switches them to Jamendo with no code changes.
- Search runs server-side only (`GET /search?q=`); query text is rendered with escaping; provider errors map to a generic, secret-free message.

## TESTS
- **Unit (114, up from 92):** `mappers` (+3 incl. `mapTrackRow`, null-album, JSON metadata), `auth/availability` (5), `shell/nav-config` (3), `providers/server` (10, env-injected — no `.env` needed since unit runs use a mock/fake registry), static `client-boundary` scan (no `"use client"` file imports `@/lib/db|dal|auth|config/env|providers/server`). Existing options/api/env/validation/normalize/provider suites unchanged and green.
- **DB (51, up from 42):** new `library.db.test.ts` (9) — user scoping, ordering, `recentLimit`/`likedLimit`, display metadata on mapped tracks, `getOwnedPlaylist` stranger→null / missing→null, ordered playlist items.
- **Full gate:** `npm run typecheck` ✓ · `npm run lint` ✓ (0 problems) · `npm test` ✓ (114/114) · `npm run test:db` ✓ (51/51) · `npm run build` ✓ · `npm run db:verify` ✓.

## FILES CHANGED
Added:
- `src/lib/auth/availability.ts` + `__tests__/availability.test.ts`
- `src/lib/dal/library.ts` + `__tests__/library.db.test.ts`
- `src/lib/providers/server.ts` + `__tests__/server.test.ts`
- `src/app/actions/auth.ts`
- `src/app/(app)/layout.tsx`, `loading.tsx`, `page.tsx`, `not-found.tsx`
- `src/app/(app)/search/{page,loading,search-form}.tsx`
- `src/app/(app)/library/{page,loading}.tsx`, `src/app/(app)/library/playlists/[id]/page.tsx`
- `src/app/(app)/radio/{page,loading}.tsx`
- `src/app/error.tsx`
- `src/components/ui/{icons,button,skeleton,empty-state,avatar,skeletons}.tsx`
- `src/components/auth/controls.tsx`
- `src/components/shell/{nav-config,nav-item,brand,header,sidebar,app-shell}.tsx` + `__tests__/nav-config.test.ts`
- `src/components/tracks/{track-art,track-row,track-list}.tsx`
- `src/components/library/playlist-card.tsx`, `src/components/home/section-header.tsx`
- `src/components/__tests__/client-boundary.test.ts`

Modified:
- `src/app/globals.css` (dark-first tokens), `src/app/layout.tsx` (base colors), `src/lib/dal/mappers.ts` (`mapTrackRow`), `src/lib/dal/index.ts` (export `./library`), `src/lib/dal/__tests__/mappers.test.ts` (restored + new suite), `src/lib/auth/availability.ts` (loose env typing)

Removed: `src/app/page.tsx` (home moved into `(app)` group)

## KNOWN LIMITATIONS
- No real OAuth **or** Jamendo credentials in `.env`: sign-in is unavailable and catalog data is the mock provider until configured.
- Playlist detail is read-only; no create/edit/reorder UI (spec: later phase). No artwork rendering for playlists (card uses gradient placeholders).
- `next/image` uses `unoptimized` (per-image) so any provider-hosted artwork renders without `remotePatterns` config; optimization is deferred.
- Search has no provider selection, paging, or saved-history chips; `SearchHistory` DAL exists but is not surfaced in the shell (later phase).
- Radio is a static/discovery surface; no streaming, no queue, no audio element anywhere.
- No error/loading boundary at the `(app)` segment root other than home `loading.tsx`; root `error.tsx` is global. No `server-only` dependency (client boundaries enforced by the static test instead).
- Auth actions return early (no error surfacing) when the provider is unsupported — intentional non-informative security posture.

## PHASE 5 READINESS
- **Ready to build on:** global player + persistent queue slots cleanly into the flex layout (the bottom nav is the only fixed-`bottom` element; add the player above it on mobile / above nothing on desktop). Track rows already carry `streamUrl`/`previewUrl` and domain `Track` shapes end-to-end (`providers/server.getPreferredProvider().getStreamUrl`), so playback wiring is a pure front-end addition. `RecordPlayed` DAL is ready for the "on play" hook; "likes" already stream to the Library.
- **Watch items:** player needs a dedicated context/provider (client) without crossing the client-boundary guard; the `(app)` layout currently holds no state, so a player host component will render at `(app)/layout` (marked `"use client"` boundary, importing only the player store) while DAL/auth calls stay in server components; `/search` will need `addSearch` calls only from an authenticated server action.