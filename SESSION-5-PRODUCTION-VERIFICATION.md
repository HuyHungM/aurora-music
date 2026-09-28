# Aurora Music — Session 5 Production Smoke Test

## Release Candidate
- **Commit:** `3fd3d43` "Add Aiven per-project CA guidance" (HEAD; unchanged this session)
- **Working tree:** dirty, **nothing committed this session** — 23 modified/unstaged, 0 staged
  (`git diff --name-only`); 4 untracked non-ignored files (below). No code was changed during
  Session 5; the only file written was a temporary resolver probe, deleted afterwards.
- **Build:** Session-4 production build (`BUILD_ID FTQeYzZc22maIsC6YDdX6`); since the tree is
  byte-identical for the RC, the verified RC is the same build.
- **Runtime:** Next.js (Node) origin behind a **Cloudflare tunnel**, serving
  `https://auroramuzik.dpdns.org`. The origin host is **remote** (no `cloudflared` process or
  Next server on this machine), so its process logs/startup are not directly inspectable.

## Production Target
- **Node/cloudflared: NOT READY** — application code passes every gate, the deployment is healthy
  for HTTP/DB/TLS/auth-init, but **production YouTube playback resolution failed for 7 of 8
  required videos at test time**. Root cause is external (see YouTube section), not application
  code; see FINAL STATUS for the precise rationale.
- **Cloudflare Workers: BLOCKED (external infrastructure limitation)** — unchanged from Session 4.
  Aiven's private per-project CA cannot be supplied to `cloudflare:sockets`; no application fix.
  `opennextjs-cloudflare build` succeeding is build-compatibility only and must **not** be read as
  "Cloudflare deployment works".

## Deployment Integrity
- **Startup:** NOT VERIFIED — the origin runs on a remote host; this box has no `cloudflared`
  binary/service and no Aurora Node process, so the documented launcher could not be exercised
  here. (Public probes show the running deployment is up.)
- **Recovery:** NOT VERIFIED (same reason — remote origin, no restart control).
- **Origin:** `GET /` → `200 text/html`; `x-powered-by: Next.js`; `Server: cloudflare`.
- **Tunnel:** Cloudflare edge in front (`cf-ray`, `alt-svc h3`); HTTPS reachable; API and auth
  callback work through the public route. Tunnel process itself not inspectable.
- **HTTPS:** valid; no `localhost`, `127.0.0.1`, or `:24584` leakage in any browser-visible URL or
  response header. No mixed content. `NEXTAUTH/AUTH` callback origin is canonical HTTPS.

## Database
- **PostgreSQL:** up — `GET /api/health` → `{"status":"ok","checks":{"environment":"valid","database":"up"}}`
- **TLS:** enforced; connection is `sslmode=require` → upgraded to `verify-full` semantics by
  `src/lib/db-tls.ts` (downgrade attempts are rejected).
- **Aiven CA:** trusted via `AURORA_DATABASE_CA_CERT_PATH` (exists, readable) / inline
  `AURORA_DATABASE_CA_CERT`; both handled in `db-tls.ts`.
- **rejectUnauthorized:** `true` — hard-coded at `src/lib/db-tls.ts:229` (`ssl: { ca, rejectUnauthorized: true }`). No weakening present.
- **Migrations:** `bunx prisma migrate status` → 8 migrations found, **"Database schema is up to date!"** (exit 0). No `db push` used.
- **Path proof:** `bun run db:check` → `SELECT 1: ok`; Auth.js `account.findUnique: ok (no row)` (exit 0).

## Authentication
- **Google OAuth:** initiation verified. `POST /api/auth/signin/google` (with CSRF) → `302` to
  `accounts.google.com/...client_id=<google-client>.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fauroramuzik.dpdns.org%2Fapi%2Fauth%2Fcallback%2Fgoogle&code_challenge_method=S256&scope=openid+profile+email`
  — canonical origin, no port, PKCE, Secure/HttpOnly `__Secure-authjs.*` cookies.
- **Callback:** `GET /api/auth/providers` reports `callbackUrl: https://auroramuzik.dpdns.org/api/auth/callback/google`. No mismatch possible from config.
- **Session:** `GET /api/auth/session` → `null` (anonymous, correct); no secret leakage.
- **Logout / login-again:** NOT VERIFIED — completing the real Google consent requires interactive
  credentials/2FA not available in this environment, so no authenticated session could be created.

## Core Application
- **Home:** PASS — renders in default Vietnamese locale; nav, search box, player bar present; no
  blocking console errors.
- **Search:** PASS — `rick astley` → `/search?q=rick%20astley` renders top result and a tracks list
  with **real YouTube titles** (server-side unified search worked).
- **Library / Playlist:** NOT EXECUTED — require authentication (no live account available).
  Server-side data path is covered by the DB/Auth checks above.
- **Queue:** PARTIALLY VERIFIED — player bar, next/previous/mute/repeat controls present and enabled
  during playback; anonymous queue writes are covered by unit tests (2915 pass).
- **Player:** PASS — play advanced playback to `0:05 / 3:33`; pause froze the position and swapped
  the control to "Phát" (play). Mute/repeat controls present.

## YouTube Playback
Production (`https://auroramuzik.dpdns.org`) vs. the **same resolver code run locally from a
residential IP** (`createInnertubePlaybackClient()` from `src/lib/.../innertube-client.ts`):

| Video ID | Production resolver | Production audio URL | Production playback | Local (same code) |
|---|---|---|---|---|
| `dQw4w9WgXcQ` | resolved (Rick Astley – 3:33) | yes | **PLAYED** (0:49→0:05→0:06, pause OK) | OK, 1 format |
| `yuuWdm5tBD0` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "SON TUNG M-TP … COME MY WAY" |
| `jNQXAC9IVRw` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 1 format, "Me at the zoo" |
| `kJQP7kiw5Fk` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "Despacito" |
| `9bZkp7q19f0` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "Gangnam Style" |
| `JGwWNGJdvx8` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "Shape of You" |
| `OPf0YbXqDm0` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "Uptown Funk" |
| `fJ9rUzIMcZQ` | fallback metadata (title=id) | no | `No playable audio format available` | OK, 7 formats, "Bohemian Rhapsody" |

- **Architecture unchanged:** `PRIMARY_PLAYER_CLIENT = "MWEB"` with one explicit `IOS` fallback
  (`src/lib/providers/youtube/playback/innertube-client.ts:110,126`). Not reverted to WEB.
- **Differential conclusion:** the *identical* code resolves **8/8** videos from a residential IP
  and **1/8** from the production origin. The differentiator is the origin's egress network
  (YouTube anti-bot / datacenter-IP throttling of the player endpoint), **not** application code.
  Fresh metadata also fell back to `title = providerTrackId`, and search (a less-protected
  endpoint) still worked — both consistent with YouTube-side challenge of the origin's player
  requests. Only the first-resolved video played, consistent with burst-rate limiting during
  testing.
- **Not a resolved Session-4 bug reopened:** this is a new, production-only, environment-level
  observation; the resolver/regression set itself is proven correct locally.

## Browser / Network
- **Console:** only two benign messages — a CSP violation for
  `static.cloudflareinsights.com/beacon.min.js` (Cloudflare **auto-injects** the Insights beacon;
  the app's CSP correctly blocks it) and a font `link rel=preload` "not used" advisory.
- **API:** `/api/health` 200 (ok), `/api/auth/providers` 200, `/api/auth/csrf` 200,
  `/api/auth/session` 200 `null`, `/api/app-config` 200, `/api/proxy?url=…` **404** (no open proxy).
- **Assets:** `/_next/static/**` JS/CSS/font, `/manifest.webmanifest`, `/sw.js`, `/icons/*` all 200
  with correct content-types.
- **Hydration:** no hydration errors observed.
- **Server Actions:** no `Failed to find Server Action` anywhere. One search Server-Action `POST`
  returned `200` but ended `net::ERR_ABORTED` — a client router transition replacing the request,
  not a version-skew error. No multiple-build evidence.

## Security
- **Auth boundary:** E2E fixture routes (`/e2e-library`, `/e2e-playback/*`) are **gated in
  production** (`"Page not found"` present; no fixture content). `AURORA_E2E_AUTH` is therefore
  not enabled in production.
- **IDOR:** NOT TESTABLE (no authenticated session available).
- **Error leakage:** `/api/health` exposes only `environment/database` status; no stack traces,
  `PrismaClient`, or `node_modules` strings in HTML; fixtures/secrets absent.
- **Unauthorized mutation:** POST of a bogus Server Action id to `/library` → **404** (not executed).
- **TLS:** certificate verification is on (`rejectUnauthorized: true`); no `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere.

## Repository
- **Untracked files:** `FINAL-HARDENING-REPORT.md`, `RESPONSIVE-QA-REPORT.md`,
  `open-next.config.ts`, `wrangler.jsonc`.
- **Secrets:** none tracked. No `.env`, no `.env.local`, no `.dev.vars` in git; no `BEGIN
  CERTIFICATE` / `aivencloud` / private-key material committed. `.env*` remains ignored.
- **Temporary artifacts:** none — the resolver probe `scripts/_tmp_resolve.mts` was deleted after
  use; no workerd/`.qa-*`/generated junk present.
- **Deployment config decision (`open-next.config.ts`, `wrangler.jsonc`):**
  - They are **Workers/OpenNext-only**; the Node/cloudflared target does **not** need them.
  - They contain **no secrets**, are self-documented as "committed on purpose", and pin the
    Cloudflare build so `wrangler deploy` cannot auto-migrate the tree.
  - **Recommendation: commit them** (together with the two report `.md` files) rather than ignore
    or delete — deleting would make the optional Workers build non-reproducible; ignoring would
    contradict the in-file intent. Not committed here, per the "do not `git add .`" instruction.

## Remaining Issues
| Severity | Issue | Scope | Classification | Status |
|---|---|---|---|---|
| **High** | Production resolves only 1/8 test videos (`No playable audio format available`; fallback metadata) while identical code resolves 8/8 locally | Node/cloudflared production | **ENVIRONMENTAL / UPSTREAM** (YouTube anti-bot on origin egress IP) | Open — release-affecting |
| Medium | Origin startup/recovery and process logs not inspectable (remote host, no local cloudflared) | Verification | **ENVIRONMENTAL** | Open — unverified, not a defect |
| Medium | Full Google OAuth login/logout could not be completed | Verification | **ENVIRONMENTAL** (no interactive credentials) | Open — unverified, not a defect |
| Low | Cloudflare auto-injected Insights beacon blocked by CSP | Browser | **BENIGN WARNING** | Acceptable |
| Info | Cloudflare Workers DB TLS | Workers target | **EXTERNAL BLOCKER** (unchanged) | Blocked |
| Info | 2 pre-existing lint warnings | Build | **FALSE POSITIVE / pre-existing** | Acceptable |

## FINAL STATUS
**NOT READY** — for the Node/cloudflared production target, on the evidence observed.

Rationale, stated precisely:
- Every **code-level** gate passes and the application payload is healthy: frozen install, lint
  (0 errors / 2 pre-existing warnings), typecheck, **2915/2915 unit tests**, DB `SELECT 1` +
  Auth.js path, 8 migrations up to date, canonical OAuth initiation, CSP/security headers, gated
  fixtures, no secret leakage, and a working play/pause player.
- However, the READY bar explicitly requires **YouTube playback to work**. At verification time it
  worked for **1 of 8** required videos from the production origin. A differential run of the
  *same resolver code* resolved **8 of 8** from a residential IP, isolating the cause to the
  origin's egress network (external), **not** a defect fixable in this release.
- Because a core user-facing feature is not reliably functional in the deployed environment, and
  two production-path items (origin startup/recovery) could not be verified, this cannot be signed
  READY. If the reviewer scopes the origin's YouTube IP reputation and the remote-host access
  limits as out-of-band infrastructure, the **application code itself meets all READY criteria**;
  a retest after the origin's upstream cooldown, or moving the origin behind a trusted egress /
  PO-token-capable resolver, is the deciding next step.
- Cloudflare Workers remains **BLOCKED** by the pre-existing external Aiven-private-CA constraint
  and does not, by itself, affect the Node verdict.

## Evidence
**Commands run**
- `git rev-parse HEAD` → `3fd3d43…`; `git diff --name-only` (23 modified); `git diff --cached` (empty);
  `git ls-files --others --exclude-standard` (4 files).
- `bun install --frozen-lockfile` → 0 changes, exit 0.
- `bun run lint` → 0 errors, 2 warnings, exit 0.
- `bun run typecheck` → exit 0.
- `bun run test` → **200 files / 2915 tests passed**, exit 0.
- `bun run db:check` → `SELECT 1: ok` / `account.findUnique: ok (no row)`, exit 0.
- `bunx prisma migrate status` → 8 migrations, "Database schema is up to date!", exit 0.
- `bun scripts/smoke-prod.mjs https://auroramuzik.dpdns.org` → all checks PASS, exit 0.
- Temporary differential probe (`scripts/_tmp_resolve.mts`, deleted) → all 8 IDs OK locally.

**Production flows (browser, live URL)**
- Home render + console; search `rick astley` → real results; open `/track/dQw4w9WgXcQ` → play to
  0:05 → pause; 8-ID playback sweep + local differential.

**Logs / network**
- Console: CSP beacon block (Cloudflare-injected) + font preload advisory only.
- Network: `googlevideo.com/videoplayback` fetched for the playing video; Server-Action POST 200;
  no 4xx/5xx on app endpoints; fixture routes gated; open-proxy 404.

**Tests**
- `bun run test` — 200 files / 2915 tests; production smoke 22 checks pass (1 flag-skipped).
