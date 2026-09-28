# Aurora Music — Deployment & release procedure (Phase 27)

## Prerequisites

- Bun 1.4.0 (canonical package manager; `bun.lock` is the only lockfile —
  there is no `package-lock.json`). Install with `bun install`; CI uses
  `bun install --frozen-lockfile`. A `postinstall` hook runs
  `prisma generate`, so a fresh install yields a working tree.
- Node.js 22+ stays present in the environment for toolchain internals that
  shell out to a Node runtime (Prisma's engine spawn, Next's own helpers). It
  is not used to install dependencies or to run project scripts.
- PostgreSQL reachable; `DATABASE_URL` set (required in every environment).
- `AUTH_SECRET` set when `NODE_ENV=production` (dummy values only ever in
  CI placeholders, never real secrets in logs or VCS).

## Cloudflare Workers (OpenNext)

Aurora deploys to **Cloudflare Workers** through
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare). The
server-rendered Next.js application is bundled into a Worker; it is **not**
converted to a static site. API routes, Auth.js, Prisma/PostgreSQL, the
YouTube playback resolver and server actions all keep running server-side.

```text
next build → @opennextjs/cloudflare build → wrangler deploy → Cloudflare Worker
```

### Committed configuration (no interactive migration)

The deployment is driven entirely by files in the repository. The Cloudflare
build must **not** be allowed to auto-run `@opennextjs/cloudflare migrate`
(which `wrangler deploy` can trigger): that command rewrites `next.config.ts`,
`package.json`, `.dev.vars` and `public/_headers` on the build machine, so the
artifact depends on an ephemeral mutation instead of a review.

| File | Purpose |
| --- | --- |
| `open-next.config.ts` | OpenNext adapter config (`defineCloudflareConfig()`). No R2/ISR override — Aurora is dynamic. |
| `wrangler.jsonc` | Worker name, entry (`.open-next/worker.js`), assets, `nodejs_compat`, `IMAGES` binding. |
| `next.config.ts` | `serverExternalPackages` (see below). |

### Scripts

```bash
bun run build      # next build — the low-level build only
bun run preview    # opennextjs-cloudflare build && opennextjs-cloudflare preview
bun run deploy     # opennextjs-cloudflare build && opennextjs-cloudflare deploy
bun run upload     # opennextjs-cloudflare build && opennextjs-cloudflare upload
bun run cf-typegen # wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts
```

`build` stays `next build`. `opennextjs-cloudflare build` runs the package's
`build` script internally, so pointing `build` at `opennextjs-cloudflare build`
would recurse. `preview`/`deploy` call the OpenNext **binary**, not the `build`
script, so they do not recurse either.

### `pg` / `pg-cloudflare` on workerd

`pg` reaches Cloudflare's native TCP sockets through its optional
`pg-cloudflare` dependency, which exposes a `workerd` export condition:

```jsonc
// node_modules/pg-cloudflare/package.json
"exports": { ".": {
  "workerd": { "import": "./esm/index.mjs", "require": "./dist/index.js" },
  "default": "./dist/empty.js"
} }
```

Next's dependency tracer follows only the `default` condition, so the
standalone output would keep `dist/empty.js` and drop the real socket files.
OpenNext restores the full package **only for names listed in Next's
`serverExternalPackages`** (`copyWorkerdPackages`). `next.config.ts` therefore
declares:

```ts
serverExternalPackages: ["pg", "pg-cloudflare"],
```

Removing either entry breaks PostgreSQL on Workers (bundling resolves/keeps
`pg-cloudflare`'s missing `dist/index.js`, and the runtime TCP socket is not
available). `pg-cloudflare` is a transitive *optional* dependency of `pg`; it
is deliberately not added as a direct dependency, because the lockfile already
pins it and the tracer/OpenNext copy is what matters.

### Runtime compatibility

- `nodejs_compat` is required by `pg`, `@prisma/adapter-pg` and Auth.js.
- `IMAGES` enables optimised `next/image`; `ASSETS` serves `.open-next/assets`.
- Secrets are set with `wrangler secret put NAME` (or the dashboard) — never in
  `wrangler.jsonc`, `open-next.config.ts` or a committed `.dev.vars`. `.dev.vars`
  is gitignored.
- **Database TLS on Workers — private CAs are a deployment prerequisite, not
  an env var.** The Node-host mechanism `AURORA_DATABASE_CA_CERT_PATH` reads a
  file from disk, which Workers do not have; `AURORA_DATABASE_CA_CERT` supplies
  the same public CA inline for a **filesystem-less Node** runtime (takes
  precedence over the path, fails closed on a non-PEM value, keeps verification
  ON). It does **not** work on Workers: `pg` uses `pg-cloudflare`, whose
  `startTls` hands the caller's options to `cloudflare:sockets`, which accepts
  only `expectedServerHostname` and therefore cannot be given the provider's
  CA. Workerd verifies against Cloudflare's own trust store, which cannot hold
  Aiven's per-project CA, so the TLS upgrade to the database fails
  (`Network connection lost`) while TCP and publicly-trusted TLS succeed.
  Verification must stay ON, so the fix is a trust boundary outside the app:
  use [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) (Cloudflare's
  Postgres connector, which owns the origin TLS and CA — the vendor's
  documented recommendation), or point the service at a publicly-trusted
  certificate. Do not deploy the Workers target against a private-CA database
  until one of those is configured. See `docs/scope-boundaries.md`.
- **What ends up in the build artifact:** `opennextjs-cloudflare build`
  compiles the values from `.env` / `.env.local` into the generated
  `.open-next/cloudflare/next-env.mjs`. Cloudflare bindings and secrets are
  applied to `process.env` first, so a real Worker secret always wins over the
  compiled fallback — but any secret sitting in a local env file at build time
  is still written into the (gitignored) bundle. Keep infra-only secrets such
  as `CLOUDFLARED_TOKEN` out of `.env` when building for Cloudflare, and prefer
  `wrangler secret put` for everything the Worker needs.

## Canonical release order

```text
install (`bun install`)
→ build (`bun run build`)          ← must precede typecheck on a clean clone
→ validate (`bun run typecheck`, `bun run lint`, `bun run test`)
→ migration review (`git status` + allowlist test)
→ migration deploy (`bunx prisma migrate deploy`)
→ application start (`bun run start -- -p PORT`)
→ readiness (`GET /api/health` → 200 `{"status":"ok"}`)
→ smoke (`bun run smoke:prod -- --spawn --port PORT`)
→ traffic
```

`bun run typecheck` type-checks against `.next/types`, which only a
`next build` (or `next dev`) generates; on a tree that has never been built
the `LayoutProps`-style generated types are absent and typecheck fails. The
build step above is therefore ordered first, not last. This is Next.js 16
behaviour and is unrelated to the package manager.

Migrate **before** deploying the new artifact: every migration to date is
additive to the schema — the one exception is the reviewed duplicate-row
`DELETE` inside `recently_played_one_row_per_track`, which only removes rows
the new uniqueness forbids — so old code also runs against the new schema,
while new code requires it.

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

The same variable is honoured by `db:verify`, `db:check`, `db:integrity` and
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
2. Store it on the host, outside the repository and outside the web root, e.g.
   `/home/container/secrets/aiven-ca.pem`.
3. Set `AURORA_DATABASE_CA_CERT_PATH` to that absolute path and leave
   `sslmode=require` (and the rest of `DATABASE_URL`) unchanged.
4. Restart the application, then run `bun run db:check` (`SELECT 1` plus the
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

- Application rollback = redeploy the previous artifact. Safe: migrations
  to date are additive to the schema (the one reviewed duplicate-row
  `DELETE` inside `recently_played_one_row_per_track` only removes rows the
  new uniqueness forbids), so old code runs on the new schema.
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

## Public origin and OAuth (required behind a tunnel or reverse proxy)

Set the public origin. It is what Google's registered redirect URI must match,
and the only way to get there is to stop deriving it from the request:

```env
AURORA_PUBLIC_URL="https://auroramuzik.dpdns.org"
```

Google Cloud Console → Credentials → the OAuth client:

| Field | Value |
| --- | --- |
| Authorized JavaScript origin | `https://auroramuzik.dpdns.org` |
| Authorized redirect URI | `https://auroramuzik.dpdns.org/api/auth/callback/google` |

No port, no trailing slash, and no `http://`. The origin the *process* listens
on stays internal and is not part of OAuth:

```env
PORT=24584                 # next start binds 24584
                           # Cloudflared origin: http://127.0.0.1:24584
```

`PORT` is what Next.js reads. Nothing else in the repository refers to this
port by name — the value lives in the launcher's environment and in the tunnel
configuration, which is why `AURORA_PUBLIC_URL` exists: the application must
not need to know its own port to build a correct public URL.

Tunnel route:

| Field | Value |
| --- | --- |
| Hostname | `auroramuzik.dpdns.org` |
| Path | `*` |
| Service type | HTTP |
| URL | `http://127.0.0.1:24584` |
| HTTP Host Header | **unset** — or exactly `auroramuzik.dpdns.org` |

Never `127.0.0.1:24584`, `localhost:24584` or `<public-host>:24584` in the
Host Header override. `AURORA_PUBLIC_URL` makes the application ignore that
header, so the override is no longer load-bearing, but leaving a wrong one in
place keeps every other proxied URL on the deployment wrong too.

Verify the generated URI rather than the configuration, because the two can
disagree:

```bash
curl -s https://auroramuzik.dpdns.org/api/auth/providers
# callbackUrl must be exactly:
#   https://auroramuzik.dpdns.org/api/auth/callback/google
```

If `AURORA_PUBLIC_URL` and `AUTH_URL` (or `NEXTAUTH_URL`) are both set and
disagree, the server refuses to boot. Do not resolve that by deleting one —
they are one declaration in two places, and the disagreement is the bug.

## Edge responsibilities (not in-app)

- TLS termination (no HSTS forced by the app), rate limiting, backups.
- Host-header sanitization is no longer a requirement *when*
  `AURORA_PUBLIC_URL` is set — the application pins the origin itself and
  ignores the header. Without it, `trustHost: true` still assumes a sane proxy.
