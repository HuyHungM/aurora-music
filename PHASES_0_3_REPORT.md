# Aurora Music — Phases 0→3 Report

Consolidated status of the Aurora Music project through Phase 3 (2026-09-19/20).
Root: `D:\Code\nodejs\aurora-music` · Windows · Node v24.14.1 · npm.

---

## Phase 0 — Baseline Audit (BLOCKED → cleared)

Repo started **completely empty**: 0 files/dirs (hidden included), no `.git`, no
`package.json`, no lockfile, no Prisma schema, no `.env`, no source. Verdict in
`AURORA_PROJECT_AUDIT.md`: nothing to map, nothing to inventory, feature absence
"not present in the repository" by policy (no fabrication). Explicit blockers:
no code to audit + no scaffolding authorization, then **cleared** when
scaffolding was authorized for Phase 1.

---

## Phase 1 — Foundation Scaffold

- **Stack installed**: Next.js `16.3.5` (App Router, Turbopack, Tailwind v4),
  React `19.2.8`, TypeScript `^5`, zod `^4.6.5`, Vitest `^4.1.11`, ESLint `^9`,
  `dotenv`.
- **Config/env**: `src/lib/config/env.ts` — zod-parsed `EnvConfig`
  (`DATABASE_URL` required, `NODE_ENV` defaulted, `AUTH_SECRET` production-only,
  OAuth + `JAMENDO_CLIENT_ID` optional), `getEnv()` cached, phase-1 audit of env
  expectations. `parseEnv` tests.
- **Errors**: `src/lib/errors/index.ts` — `AuroraError` base + `ConfigError`,
  `ApiError`, `ProviderError` family (`ProviderNotFoundError`,
  `ProviderDataError`, `ProviderRateLimitError`,
  `InvalidProviderCredentialsError`, `UnsupportedProviderCapabilityError`),
  `MissingResultsError`, guards, `toLogSafeError`.
- **API helpers**: `src/lib/api/` — `query.ts` (pagination/parse), `response.ts`
  (JsonResponse), `client.ts` (+barrel).
- **Validation**: `src/lib/validation/schemas.ts` — shared zod schemas
  (`providerIdSchema = z.enum(["jamendo","mock"])`, ID/pagination schemas).
- **App shell**: `src/app/` layout + home page + `globals.css`.
- **Scripts**: `typecheck` / `lint` / `test` / `build` / `dev` — all green.

## Phase 2 — Provider Layer

- **Jamendo provider**: `src/lib/providers/jamendo/` — typed DTOs (`schemas.ts`
  with `parseJamendoTrackListLike`, `parseJamendoArtistList`,
  `parseJamendoAlbumList`, `discover`, `search`, `albums`, `playlists`,
  `stream`/`lyrics` fields), `normalize.ts` (DTO→domain `Track`/`Artist`/`Album`),
  `request.ts` (fetch + auth header + errors), `provider.ts` (implements
  `MusicProvider` interface: search get/popular/featured/recommendations/stream).
- **Mock provider**: `src/lib/providers/mock/` — offline provider for dev/tests
  (isMock flag), implements the same `MusicProvider` interface.
- **Registry & DTO contract**: `src/lib/providers/` — `types.ts`
  (`MusicProvider`, `ProviderSearchQuery`, `ProviderListResult`, pagination),
  `dto.ts`, `normalize.ts`, `index.ts` (barrel +
  `registerJamendoProvider()`), `registry.ts`.
- **Import-cycle fix**: `provider.ts` / mock import from `@/lib/providers/normalize`
  and `@/lib/providers/types` leaf modules (not the barrel) — resolves the cycle.
- **Tests**: jamendo schemas/normalize/provider-stub suites + mock suite +
  providers suite — **72/72 passing**.

## Phase 3 — Persistence & Authentication

See `PHASE_3_REPORT.md` for the full detail; highlights:
- **DB** (`DATABASE_URL="file:./dev.db"`, kept as-was, DB never reset):
  migration `20260919171510_auth_and_catalog` applied to fresh `dev.db`; 13
  tables (auth contract `User/Account/Session/VerificationToken`, catalog
  `Artist/Album/Track` keyed by `provider + externalId`, user data
  `Like/Follow/RecentlyPlayed/SearchHistory/Playlist/PlaylistTrack`). All FKs
  cascade; `PlaylistTrack(playlistId,position)` unique → deterministic ordering.
  Prisma 7 conventions (`prisma.config.ts`, driver adapter
  `PrismaBetterSqlite3`, generated client in `src/generated/prisma`, singleton in
  `src/lib/db.ts`).
- **Auth**: Auth.js v5 JWT sessions, conditional Google/GitHub providers
  (boots with none configured), Prisma adapter, `Session.user.id` augmentation,
  route handler `src/app/api/auth/[...nextauth]/route.ts`.
- **DAL**: `catalog/session/like/follow/recently-played/search-history/playlist/mappers`
  (+ barrel); server-side ownership checks; new errors
  (`AuthenticationError`, `AuthorizationError`, `ResourceNotFoundError`,
  `ConflictError`).
- **Tooling**: `npm run test:db` (real dev.db, serial), `npm run db:verify`
  (smoke script), `npm run db:studio`; `tsx` dev dep; `.env` with generated
  dev `AUTH_SECRET` + `AUTH_TRUST_HOST`; `.gitignore` for `*.db*`.

---

## Validation Matrix (current, all green)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✓ |
| Lint | `npm run lint` | ✓ |
| Build | `npm run build` | ✓ (auth route dynamic `ƒ /api/auth/[...nextauth]`) |
| Unit tests | `npm test` | **92/92** (11 files) |
| DB tests | `npm run test:db` | **42/42** (4 suites) |
| DB smoke | `npm run db:verify` | ✓ |

Unit suites: api/query (5), api/response (5), config/env (12), validation (9),
jamendo normalize (6) / schemas (10) / provider (13), mock provider (7),
providers (5), auth options (11), DAL mappers (9). DB suites: catalog (8),
like-follow (11), recently-search (6), playlist (17).

---

## Domain Map

- `src/lib/domain/` — `Track`, `Artist`, `Album`, `Playlist`/`PlaylistItem`,
  `User`, `Like`, `Follow`, `RecentlyPlayed`, `SearchHistory`, `ProviderId`.
- `src/lib/providers/` — provider interface + Jamendo/Mock implementations.
- `src/lib/dal/` — Prisma persistence layer (catalog upserts, user data,
  ownership-guarded playlist ops).
- `src/lib/auth/` + `src/lib/auth.ts` — Auth.js wiring.
- `prisma/schema.prisma` — 13-model data model, migration managed.
- `scripts/` — `verify-db.mts`, `db-test-env.ts`.

## Known Limitations

- No UI yet (shell only): signing in, likes/playlists/follows are
  DAL-backed but not surfaced in the app.
- Optional OAuth providers remain unconfigured in `.env`;
  `@auth/prisma-adapter@2.11.3` peer range excludes `@prisma/client@^7`
  (non-fatal, may surface on fresh `npm ci` as a warning).
- Player, queue, shuffle/repeat, and advanced playlist UX intentionally not built.

## Next Phase — Phase 4: Application Shell

- Global app shell: header nav (Home / Search / Library / Radio), responsive
  layout, routing skeleton.
- Auth-gated pages behind `auth()` + `requireUser()`; wire DAL into loaders.
- First user-data surfaces (likes, playlists, recently played).
- Player/advanced UX remain out of scope until a later phase.