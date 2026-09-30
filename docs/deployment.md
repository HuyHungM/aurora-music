# Aurora Music — Deployment & release procedure (Phase 27)

## Prerequisites

- Bun 1.4.0 (canonical package manager; `bun.lock` is the only lockfile —
  there is no `package-lock.json`). Install with `bun install`; CI uses
  `bun install --frozen-lockfile`. A `postinstall` hook runs
  `prisma generate`, so a fresh install yields a working tree.
- Node.js 22+ for local runs and for toolchain internals that shell out to a
  Node runtime (Prisma's engine spawn, Next's own helpers). It is not used to
  install dependencies or to run project scripts.
- PostgreSQL reachable; `DATABASE_URL` set (required in every environment).
- `AUTH_SECRET` set when `NODE_ENV=production` (dummy values only ever in
  CI placeholders, never real secrets in logs or VCS).

## Target platform: Vercel (native Next.js)

Aurora deploys as a **native Next.js application on Vercel**. There is no
Workers bundle and no OpenNext adapter: Vercel detects the Next.js framework,
runs `next build`, and serves the App Router through Vercel's Node.js
Functions. API routes, Auth.js, Prisma/PostgreSQL, the YouTube playback
resolver and server actions all keep running server-side.

```text
Browser → Cloudflare DNS → Vercel (Next.js) → Node.js Functions → Aiven PostgreSQL
```

Repository configuration is framework-driven. There is deliberately **no
`vercel.json`**: no `builds`, no catch-all `routes`, no `functions` block. The
build command is the real `package.json` `build` script (`next build`) and the
install command is `bun install` (`bun.lock` is the only lockfile). `.vercel/`
is gitignored and never committed.

### Canonical origin and DNS

- Canonical origin: `https://app.auroramuzik.dpdns.org`.
- The apex `auroramuzik.dpdns.org` **301-redirects to the canonical origin**,
  preserving path and query, over HTTPS, without a redirect loop. This redirect
  is an edge/DNS responsibility (a Cloudflare redirect rule on the apex host),
  **not** an application route — the app does not serve the apex.
- Cloudflare remains the DNS provider for the zone. `app` resolves to the
  Vercel deployment and the Vercel project's production domain is
  `app.auroramuzik.dpdns.org`.
- TLS terminates at Vercel; the app does not force HSTS.

### Environment variables (Vercel Project Settings)

Set these in **Vercel → Project → Settings → Environment Variables** for the
Production (and Preview, where useful) environment. Never commit values.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Aiven PostgreSQL connection string. Keep `sslmode=require` (or `verify-full`); never weaken verification. |
| `AURORA_DATABASE_CA_CERT` | Inline public PEM for Aiven's per-project CA. Vercel Functions have no readable file to point a path at, so supply the CA as a value. Takes precedence over the path variable. |
| `AURORA_PUBLIC_URL` | `https://app.auroramuzik.dpdns.org` — required in production. |
| `AUTH_SECRET` | Required in production (Auth.js). Generate with `openssl rand -base64 32`. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Optional; enables Google sign-in. |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | Optional; enables GitHub sign-in. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional; enables the Spotify catalog provider. |
| `YOUTUBE_API_KEY` | Optional; enables the YouTube metadata provider. |
| `AURORA_YOUTUBE_EGRESS_PROXY` | Optional. Absolute `http(s)` forward proxy for the shared YouTube InnerTube session (discovery + playback). Set it only when this function's egress is treated as a datacenter and playback fails with YouTube's `LOGIN_REQUIRED` bot challenge. Only InnerTube traffic is proxied — never user traffic. May embed credentials. |
| `AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY` | Temporary failover primary for playback resolution. Explicit primary; falls back to `AURORA_YOUTUBE_EGRESS_PROXY` when unset. May embed credentials; never log values. |
| `AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY` | Temporary failover secondary for playback resolution. Used once per video, only after a retryable primary failure. May embed credentials; never log values. |
| `AURORA_FEATURE_FLAGS` | Optional server-side kill switches (see below). |

`AURORA_DATABASE_CA_CERT_PATH` and `SERVER_PORT` are Node-host file/port
mechanisms and are not used on Vercel, which supplies its own port and has no
persistent file to point at. Supply the CA inline instead. `AUTH_TRUST_HOST`
is not required when `AURORA_PUBLIC_URL` is set: the origin is pinned, not
inferred from a proxy header.

**YouTube anti-bot egress.** Vercel Functions egress from a datacenter range,
and YouTube's player endpoint answers some videos there with
`playabilityStatus.status = "LOGIN_REQUIRED"` ("Sign in to confirm you're not a
bot") and no `streaming_data`; extraction then sees zero formats and playback
fails with `No playable audio format available`, while the same video resolves
from a non-datacenter network. The `playback_extraction_empty` log line now
carries `hasStreamingData` / `playabilityStatus` / `playabilityReason` so this
is unambiguous. The only legitimate remedy is a different egress: point
`AURORA_YOUTUBE_EGRESS_PROXY` at an HTTP CONNECT proxy on such a network. Never
satisfy the challenge by carrying cookies, tokens, or a signed-in session; see
`ARCHITECTURE.md` §8.

A minimal, CONNECT-only reference proxy with a strict InnerTube host allowlist
ships in this repository at `tools/youtube-egress-proxy.mjs`. Run it on a
non-datacenter host:

```bash
PROXY_USER=… PROXY_PASS=… PORT=8080 node tools/youtube-egress-proxy.mjs
```

then point `AURORA_YOUTUBE_EGRESS_PROXY` at `http://USER:PASSWORD@HOST:PORT`.
It tunnels only the InnerTube hosts (`www.youtube.com`, `youtube.com`,
`m.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com`); googlevideo
is deliberately **not** in its allowlist and must not be added — the CDN is
probed and played directly, from the function and the browser respectively.

**Temporary failover rollout.** Set both `AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY`
and `AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY` as Production secrets, then
redeploy. Keep the existing primary secret until failover is verified; do not
remove it first. Failover is primary-first, one secondary attempt per video,
with a 3-failure / 5-minute per-egress cooldown. Operational logs use proxy
labels only — never proxy URLs, usernames, passwords, headers, or signed
googlevideo URLs.

### Database migrations

Migrations are **not** run automatically during the Vercel build. Next.js
builds can run more than once and in parallel, and a build is not a safe place
to mutate a database other processes depend on. Run them explicitly, before
promoting the new deployment:

```bash
DATABASE_URL="postgresql://…" bunx prisma migrate deploy
```

Migrate **before** promoting the new artifact: every migration to date is
additive to the schema — the one exception is the reviewed duplicate-row
`DELETE` inside `recently_played_one_row_per_track`, which only removes rows
the new uniqueness forbids — so old code also runs against the new schema,
while new code requires it.

### Build settings

| Setting | Value |
| --- | --- |
| Framework preset | Next.js (auto-detected) |
| Install command | `bun install` (default; `bun.lock` is the lockfile) |
| Build command | `next build` (the `build` script) |
| Output | Next.js default (`.next`); no static export |

`postinstall` runs `prisma generate`, so the Prisma client exists before
`next build`.

### Local preview of a production build

```bash
bun install
bun run build
AURORA_PUBLIC_URL="http://localhost:3000" bun run start
```

## Canonical release order

```text
install (`bun install`)
→ build (`bun run build`)          ← must precede typecheck on a clean clone
→ validate (`bun run typecheck`, `bun run lint`, `bun run test`)
→ migration review (`git status` + allowlist test)
→ migration deploy (`bunx prisma migrate deploy`)   ← separate, pre-promote step
→ deploy to Vercel (Vercel builds `next build` and starts the deployment)
→ readiness (`GET /api/health` → 200 `{"status":"ok"}`)
→ smoke (`bun run smoke:prod https://app.auroramuzik.dpdns.org`)
→ traffic
```

`bun run typecheck` type-checks against `.next/types`, which only a
`next build` (or `next dev`) generates; on a tree that has never been built
the `LayoutProps`-style generated types are absent and typecheck fails. The
build step above is therefore ordered first, not last. This is Next.js 16
behaviour and is unrelated to the package manager.

## Startup contract

- `src/instrumentation.ts` validates configuration at server boot and
  crashes the process with a names-only error when required values are
  missing. No partially initialized serving.
- No automatic migrations at startup (explicit `prisma migrate deploy`
  only). No provider calls, no seeding, no telemetry at boot.

## Readiness

- `GET /api/health` (always dynamic, Node runtime): `200 {"status":"ok"}`
  iff configuration is valid **and** a bounded read-only DB probe
  (`SELECT 1`, 3s timeout) succeeds; otherwise `503` with
  `status: "error"|"degraded"` and a fixed `{environment, database}` shape.
- Liveness = the endpoint answers at all. Readiness = `status: "ok"`.
  Providers are intentionally excluded: Aurora is ready while YouTube,
  Spotify, or Deezer are down.
- The response never contains versions, paths, user data, or secrets.

## Shutdown

- Plain `SIGTERM`/`SIGINT` (Ctrl-C locally): Next.js drains and exits;
  no custom handlers, no background work besides request handling.
  Client playback state (PlayerHost, timers, listeners) is torn down by
  React unmount, independent of server shutdown.

## Smoke checks

- `bun run smoke:prod [baseUrl]` probes a running server (shell, headers,
  manifest/icons, service worker content, proxy absence, fixture gating,
  auth sanity). Exit 0/1/2 (pass/fail/misconfiguration).
- `bun run smoke:prod -- --spawn --port PORT` additionally refuses an
  occupied port, requires `.next/BUILD_ID` (so a stale build can never
  validate), starts an owned server, waits for `/api/health` readiness,
  runs the checks, then terminates the child and verifies the exit
  (no orphans, no stale-server false positives).
- `bun run db:check` is the read-only database smoke test: `SELECT 1` and the
  exact `prisma.account.findUnique()` lookup Auth.js runs in
  `getUserByAccount()` (sentinel key, writes nothing). Prefer it over
  `db:verify`, which upserts a probe track, when you only need to prove the
  connection and the adapter path.

## Database TLS and the provider CA

The application reaches PostgreSQL through Prisma's driver adapter
(`@prisma/adapter-pg`) with the connection in `DATABASE_URL`. TLS is decided by
that URL: `sslmode=require`, `verify-ca` and `verify-full` all perform full
certificate **and** hostname verification against the runtime's trust store
(`pg-connection-string` currently treats all three as `verify-full`).

When the provider signs with its own CA — the production
`self-signed certificate in certificate chain` failure — point the application
at that CA instead of weakening the connection:

```env
AURORA_DATABASE_CA_CERT_PATH="/etc/aurora/postgres-ca.pem"
```

- It is the provider's **public** CA certificate (or bundle): a `.pem` with no
  private key. An empty or unreadable file fails with a names-only
  `ConfigError`, never with the file's contents in the message.
- Keep it outside the repository (`.gitignore` already ignores `*.pem`).
- When set, the application supplies `ssl: { ca, rejectUnauthorized: true }`
  and removes any conflicting SSL parameters from the URL, so the CA cannot be
  silently overridden. Certificate and hostname verification stay ON.
- When unset, the connection string is used exactly as written and `pg`
  verifies against the system trust store — the pre-existing behaviour.

On a filesystem-less runtime such as Vercel, supply the same public CA as
inline PEM text instead, in `AURORA_DATABASE_CA_CERT` (it takes precedence over
the path and never weakens verification).

The same variables are honoured by `db:verify`, `db:check`, `db:integrity` and
the E2E harness, so every path trusts the same CA.

### Managed provider with a per-project CA (Aiven)

Aiven PostgreSQL signs the server certificate with a **per-project CA**
(`<project-id> Project CA`) that is self-signed and therefore absent from every
public trust store. The server sends the complete chain (leaf -> project CA),
so the only missing piece is the trust anchor and hostname verification already
passes; the observed failure is `SELF_SIGNED_CERT_IN_CHAIN`. Trust Aiven's own
CA; never weaken the connection:

1. In the Aiven Console, open the service and download its **CA certificate**
   (`ca.pem`). Do not take a CA from a third-party site.
2. Provide it to the runtime: on a Node host, store it outside the repository
   and outside the web root (e.g. `/home/container/secrets/aiven-ca.pem`) and
   set `AURORA_DATABASE_CA_CERT_PATH` to that absolute path; on Vercel, set
   `AURORA_DATABASE_CA_CERT` to the certificate text.
3. Leave `sslmode=require` (and the rest of `DATABASE_URL`) unchanged.
4. Restart/redeploy, then run `bun run db:check` (`SELECT 1` plus the
   `getUserByAccount` lookup against a sentinel key).

The CA file is a **public** certificate (no private key). Never commit it to
Git — `.gitignore` already ignores `*.pem` — and never serve it. Certificate
and hostname verification remain enabled (`rejectUnauthorized: true`).

`sslmode=disable`, `sslmode=no-verify`, `ssl=false` and `uselibpqcompat=true`
on `require`/`verify-ca` are refused in production. Resolve a certificate
problem by supplying the CA, never by disabling verification.


## Backup and restore runbook

**Back up before any migration that touches data.** A migration is the only
kind of change in this project that can destroy data.

Take a dump (custom format, so the restore carries indexes and constraints
rather than replaying SQL):

```
pg_dump --format=custom --no-owner --no-privileges \
  --file aurora-$(date +%Y%m%d-%H%M%S).pgc "$DATABASE_URL"
```

Keep the archive off the database host. A backup that dies with the host is not
a backup.

**Verify the restore, do not assume it.** The drill does the whole cycle against
a throwaway database and cleans up after itself:

```
AURORA_RESTORE_DRILL=1 bun run db:restore-drill
```

It creates `aurora_restore_drill`, dumps, restores, runs `db:integrity`
against the restored copy, compares row counts across 13 tables, and drops the
target. Run it after any change to the backup procedure, on a schedule, and once
before you need it.

Against an already-restored database - the real recovery case - verify with:

```
DATABASE_URL="postgresql://...@host/aurora_restored" bun run db:integrity
```

`db:integrity` is read-only, so it is safe to point at a recovered copy. It
checks orphaned rows, that every required unique index is present AND unique,
that uniqueness actually holds in the data, that required columns are NOT NULL,
that playlist positions are contiguous, that every user-scoped row resolves to a
real user, and that no migration is failed or half-applied.

**Recovery order after a restore:** run `bun run db:integrity`, then
`bun run smoke:prod`, then compare the migration count in `_prisma_migrations`
against the deployment you are rolling forward to. A schema that is a migration
behind the code will start, and will then fail in a way that looks like a data
bug.

**Drill guards.** The drill refuses to start without `AURORA_RESTORE_DRILL=1`,
refuses if the target equals the source database, and requires a plain lowercase
name. It is not part of the default pipeline and must never be.

## Feature flags and kill switches

Server-side flags are read from one variable and need no deploy to change:

```
AURORA_FEATURE_FLAGS="radio=0,playlistSharing=0"
```

Current flags, their defaults and their owners are declared in
`src/lib/feature-flags.ts`; that registry is the documentation. Parsing never
throws - a typo is collected and ignored rather than stopping the process, so a
mistyped kill switch cannot take the site down.

`playlistSharing` blocks the transition TO shared only. Going back to private is
always permitted: revocation must work even when the feature is being killed.

## Rollback

- Application rollback = redeploy the previous artifact. On Vercel this is an
  instant rollback to the previous deployment; safe, because migrations to date
  are additive to the schema (the one reviewed duplicate-row `DELETE` inside
  `recently_played_one_row_per_track` only removes rows the new uniqueness
  forbids), so old code runs on the new schema.
- Database rollback has **no automatic downgrade** (Prisma provides none);
  it means restoring from backup. Never run `prisma migrate resolve`
  destructive commands casually.
- New application + old database breaks only where new tables are touched
  (today: playback persistence); core playback of catalog metadata is
  unaffected. The migration allowlist test fails closed on any new
  migration so the above analysis is redone explicitly.

## Live playback credentials

- Playback resolution needs no API key. Search/metadata extras need
  `YOUTUBE_API_KEY` / Spotify credentials only where documented; their
  absence disables providers, never breaks boot. Live E2E stays opt-in
  (`AURORA_E2E_LIVE_PLAYBACK=1`) and out of CI.

## Public origin and OAuth (required on a custom domain)

Set the public origin. It is what Google's registered redirect URI must match,
and the only way to get there is to stop deriving it from the request:

```env
AURORA_PUBLIC_URL="https://app.auroramuzik.dpdns.org"
```

`https://app.auroramuzik.dpdns.org` is the canonical production origin. The
previous `https://auroramuzik.dpdns.org` host is the legacy deployment and must
not be treated as canonical anywhere.

Google Cloud Console → Credentials → the OAuth client:

| Field | Value |
| --- | --- |
| Authorized JavaScript origin | `https://app.auroramuzik.dpdns.org` |
| Authorized redirect URI | `https://app.auroramuzik.dpdns.org/api/auth/callback/google` |

GitHub OAuth app → Authorization callback URL:

| Field | Value |
| --- | --- |
| Authorization callback URL | `https://app.auroramuzik.dpdns.org/api/auth/callback/github` |

No port, no trailing slash, and no `http://`. The origin the *process* listens
on is chosen by Vercel and is not part of OAuth. `AURORA_PUBLIC_URL` exists
precisely because the application must not need to know its own port or
deployment hostname to build a correct public URL.

These provider-console entries must be updated to the canonical callbacks and a
real sign-in exercised before OAuth can be called verified. Do not claim a real
OAuth end-to-end success until both are done.

Verify the generated URI rather than the configuration, because the two can
disagree:

```bash
curl -s https://app.auroramuzik.dpdns.org/api/auth/providers
# callbackUrl must be exactly:
#   https://app.auroramuzik.dpdns.org/api/auth/callback/google
```

If `AURORA_PUBLIC_URL` and `AUTH_URL` (or `NEXTAUTH_URL`) are both set and
disagree, the server refuses to boot. Do not resolve that by deleting one —
they are one declaration in two places, and the disagreement is the bug.

### Legacy origin (`auroramuzik.dpdns.org`)

`app.auroramuzik.dpdns.org` is the canonical production origin. The previous
`auroramuzik.dpdns.org` host is the legacy deployment and must not be treated
as canonical in configuration, naming, monitoring or reports. It may still
exist during the migration; do not delete it, and do not change how it routes,
without first inspecting the current Cloudflare routing configuration. Once the
Vercel production origin is verified, turning the legacy host into a 301
redirect to `https://app.auroramuzik.dpdns.org` (preserving path and query) is a
separate, reviewed change.

## Edge responsibilities (not in-app)

- TLS termination (no HSTS forced by the app), the apex 301 redirect, rate
  limiting, backups.
- Host-header sanitization is not a requirement *when* `AURORA_PUBLIC_URL` is
  set — the application pins the origin itself and ignores the header.
  Without it, `trustHost: true` still assumes a sane proxy.
