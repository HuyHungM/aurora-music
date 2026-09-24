# Phase 3 Report — Persistence & Authentication

Goal: add reliable persistence (Prisma + SQLite) and authentication (Auth.js / NextAuth v5) to Aurora Music, layer by layer, without destroying the dev database.

## DATABASE STATUS

- Migration `20260919171510_auth_and_catalog` created and applied via `npx prisma migrate dev`. `dev.db` created at project root (matches `DATABASE_URL="file:./dev.db"` — the exact pre-existing config, database was **not** reset).
- 13 tables live: Auth contract tables (`_prisma_migrations` ignores) — `User` (+ `emailVerified`, `image`), `Account`, `Session`, `VerificationToken`; catalog — `Artist`, `Album`, `Track`; user data — `Like`, `Follow`, `RecentlyPlayed`, `SearchHistory`, `Playlist`, `PlaylistTrack`.
- Catalog rows keyed by `@@unique(provider, providerExternalId)`; user tables hold real FKs to catalog rows. `Like.userId+trackId`, `Follow.userId+artistId`, `PlaylistTrack.playlistId+trackId`, and `PlaylistTrack.playlistId+position` all unique. All FKs on delete cascade.
- Track extends the earlier schema: `Genres`/`Metadata` as `Json` fields; points to Artist (cascade) and Album (set null). Schema is PG-friendly (Json fields, `String` provider ids) while remaining SQLite-compatible.
- Prisma 7 conventions: `prisma.config.ts` supplies `datasource.url`; client generated to `src/generated/prisma` (gitignored); runtime uses `PrismaBetterSqlite3` driver adapter singleton in `src/lib/db.ts`.
- Migration tracking: `prisma/migrations/` + `migrate deploy` supports any environment. `npm run db:verify` smoke-tests connectivity and tables; `npm run db:studio` opens Prisma Studio.

## AUTH STATUS

- Auth.js v5 (`next-auth@5.0.0-beta.32`) wired: `src/lib/auth/options.ts` (pure `buildProviders(env)` — Google/GitHub providers added only when both corresponding credentials exist, so provider-less environments still boot), `src/lib/auth.ts` (`NextAuth(config)` exported as `{ handlers, auth, signIn, signOut }`), route handler at `src/app/api/auth/[...nextauth]/route.ts`, and type augmentation in `src/types/next-auth.d.ts` (adds `Session.user.id`).
- Sessions are **JWT** (`strategy: "jwt"`); `trustHost: true`; `secret` from `AUTH_SECRET` env; `callbacks.session` maps `token.sub` → `session.user.id`.
- Prisma adapter (`@auth/prisma-adapter`) attached; `Account`/`Session`/`VerificationToken` tables satisfy the adapter contract even with JWT sessions.
- `.env`: `DATABASE_URL`, dev `AUTH_SECRET` (auto-generated), `AUTH_TRUST_HOST=true`. Optional Google/GitHub credentials kept empty — app runs with no providers configured.

## DAL

- `src/lib/dal/` modules with a shared barrel (`index.ts`):
  - `catalog.ts` — `upsertArtist/upsertAlbum/upsertTrack` (idempotent by `provider + externalId`, resolving FKs), `findTrackInternalId`/`findArtistInternalId`, JSON-safe writes for `genres`/`metadata`.
  - `session.ts` — `getCurrentUser()` / `requireUser()` (throws `AuthenticationError`) / `getSessionUserId()`.
  - `like.ts`, `follow.ts` — idempotent add (P2002 treated as no-op), remove, list (newest-first), state checks.
  - `recently-played.ts` — records plays, caps at 50. `search-history.ts` — records trimmed queries, caps at 50, clear.
  - `playlist.ts` — CRUD with server-side ownership checks (`requirePlaylistOwner` → `AuthorizationError` / `ResourceNotFoundError`), deterministic position ordering (`@@unique(playlistId, position)`), transaction-safe add (duplicate → `ConflictError`), removal with position compaction, and two-phase reorder (all rows shifted out of the target slot before applying the new order, avoiding unique-constraint collisions).
- New error types in `src/lib/errors`: `AuthenticationError`, `AuthorizationError`, `ResourceNotFoundError`, `ConflictError`.

## TEST RESULTS

- **Unit (hermetic, `npm test`): 92/92 passed** — 11 files (auth options, DAL mappers, api/query+response, config/env, validation schemas, jamendo + mock providers).
- **DB integration (`npm run test:db`, real `dev.db`): 42/42 passed** — 4 suites (`catalog`, `like-follow`, `recently-search`, `playlist`). Self-contained fixtures: unique provider namespaces + user-scoped data, cleaned after each run; `fileParallelism: false`.
- `npm run typecheck` ✓ · `npm run lint` ✓ · `npm run build` ✓ (auth route reported as dynamic `ƒ /api/auth/[...nextauth]`).
- `npm run db:verify` ✓ — connects, reports all table counts, upserts + removes a smoke row.

## Known Limitations

- Personalization (likes/follows/etc.) works only for **signed-in** users; session/JWT is implemented but no UI exists yet to sign in.
- Arguable duplication: `User`/`Playlist` metadata columns are plain columns; we chose the "richer tracking data" branch.
- `@auth/prisma-adapter@2.11.3` peer range excludes `@prisma/client@^7` (reported `ERESOLVE` may appear on a strict fresh `npm ci`, not fatal).
- Playlist song existence at add-time is enforced; deletions of catalog entries cascade from `Playlist`/`Like`/`RecentlyPlayed`.

## NEXT PHASE: PHASE 4 — APPLICATION SHELL

- Global app shell: header nav (Home / Search / Library / Radio), responsive layout, routing skeleton.
- Authenticated areas behind `auth()` + `requireUser()`; wire DAL into page/route loaders.
- Wire first user-data surfaces (likes, playlists, recently played) to the DAL.
- Do NOT build player or advanced playlist UX yet — that is a later phase.