# Aurora Music — Deployment & release procedure (Phase 27)

## Prerequisites

- Node.js 22+, `npm ci` (lockfile canonical; no Bun/pnpm/Yarn migration).
- PostgreSQL reachable; `DATABASE_URL` set (required in every environment).
- `AUTH_SECRET` set when `NODE_ENV=production` (dummy values only ever in
  CI placeholders, never real secrets in logs or VCS).

## Canonical release order

```text
validate (typecheck, lint, unit)
→ build (`npm run build`)
→ migration review (`git status` + allowlist test)
→ migration deploy (`prisma migrate deploy`)
→ application start (`npm run start -- -p PORT`)
→ readiness (`GET /api/health` → 200 `{"status":"ok"}`)
→ smoke (`npm run smoke:prod -- --spawn --port PORT`)
→ traffic
```

Migrate **before** deploying the new artifact: both current migrations are
purely additive, so old code also runs against the new schema, while new
code requires it.

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

- `npm run smoke:prod [baseUrl]` probes a running server (shell, headers,
  manifest/icons, service worker content, proxy absence, fixture gating,
  auth sanity). Exit 0/1/2 (pass/fail/misconfiguration).
- `npm run smoke:prod -- --spawn --port PORT` additionally refuses an
  occupied port, requires `.next/BUILD_ID` (so a stale build can never
  validate), starts an owned server, waits for `/api/health` readiness,
  runs the checks, then terminates the child and verifies the exit
  (no orphans, no stale-server false positives).

## Rollback

- Application rollback = redeploy the previous artifact. Safe: migrations
  to date are additive, so old code runs on the new schema.
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

## Edge responsibilities (not in-app)

- TLS termination (no HSTS forced by the app), Host-header sanitization
  (`trustHost: true` assumes a sane proxy), rate limiting, backups.
