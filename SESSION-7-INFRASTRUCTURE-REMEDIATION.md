# Aurora Music — Session 7: Infrastructure Remediation & Production Stability

**Date:** 2026-09-28
**Scope:** Attempt the infrastructure remediation Session 6 identified (production
egress / cloudflared stability), track the Auth.js Google `iss` error separately,
and report a single status.

---

## Executive summary

- **Infrastructure remediation is BLOCKED.** This environment has **no access to
  the production origin host**: no SSH key/config/agent, no cloudflared binary,
  no provider panel credentials, and no host env vars. Every host-level step
  (network inventory, running the resolver on the host, changing the egress,
  reading/restarting cloudflared) cannot be executed here.
- **No local cloudflared connector was started** (it would hijack the production
  tunnel).
- The **Auth.js Google `iss` error was root-caused and fixed** as a separate,
  self-contained commit — see §5. It could not be confirmed end-to-end because a
  real Google login cannot be completed from this environment.
- Everything observable from outside was re-verified: OAuth initiation is
  correct, the database/TLS path is healthy, the public site is stable, and the
  production smoke suite passes. The only flapping observed is the app's own
  `/api/health` 503 (a 3 s DB probe), **not** the tunnel.

---

## 1. Host access — BLOCKED (the gating fact)

| Check | Result |
| --- | --- |
| `~/.ssh` contents | only `known_hosts` (no private key, no `config`, no agent) |
| `known_hosts` entry | `[nl0.freemchosting.com]:2022` — an **unrelated**, currently **unreachable** host (DNS now `45.13.237.208`, TCP refused) |
| cloudflared binary | not installed |
| provider panel / API credentials | none in the environment |
| host env vars (HIDEN/ZEUS/PANEL/SSH/DEPLOY…) | none |

The production origin is a **remote HidenCloud container on Azure**
(`zeus.hidencloud.com` → `20.193.253.17`, AS8075, Pune, India, IPv4-only).

Consequently these requested steps are **not executable** and were not faked:
§3 host network inventory, §4 run the resolver on the host, §5 egress change,
§7 cloudflared logs, §8 cloudflared process health, §9 restart/recovery, §12
host-side 8-video retest.

## 2. Egress (re-confirmed, unchanged)

| Property | Value |
| --- | --- |
| Host IPv4 | `20.193.253.17` |
| IPv6 | none (host has no `AAAA`; IPv4-only) |
| Provider | Microsoft Azure (HidenCloud container) |
| Region | Pune, Maharashtra, India (IN) |
| ASN | AS8075 Microsoft Corporation |

The exact NAT/egress source IP the origin presents to YouTube remains
**unobservable without host shell access** (§3/§4 BLOCKED).

## 3. What was verified from outside (read-only)

- **OAuth initiation is correct.** Driving the CSRF + `POST
  /api/auth/signin/google` flow returns a well-formed Google authorization URL:
  `redirect_uri=https://auroramuzik.dpdns.org/api/auth/callback/google` (no
  `:24584`), `code_challenge_method=S256`, `scope=openid profile email`.
- **Database / TLS healthy and untouched.** `bun run db:check` → `SELECT 1: ok`,
  `account.findUnique: ok`; `bunx prisma migrate status` → 8 migrations,
  "Database schema is up to date"; `db-tls.ts` still `rejectUnauthorized: true`.
- **Production smoke** (`bun scripts/smoke-prod.mjs https://auroramuzik.dpdns.org`)
  → every check PASS (home, health, CSP, headers, manifest/icons, service worker,
  app-config, no open proxy, fixtures gated, auth session, no secret leak).
- **Sustained public stability (§13).** Window A: 12 samples × 4 routes
  (`/`, `/api/health`, `/api/auth/providers`, `/api/app-config`) → only 2
  non-200, both `/api/health` **503**, **no 530/1033**. Window B: 70 consecutive
  `/api/health` → 70/70 OK. The 503 is the app's own probe timing out
  (`DB_CHECK_TIMEOUT_MS = 3000` on `SELECT 1`), i.e. transient Aiven latency, not
  a tunnel or process failure — the 503 body is the app's health contract, so the
  app answered.

## 4. Cloudflare tunnel (§7–§9)

- No `530` / Cloudflare `1033` was observed in any Session 7 window; the single
  `1033` seen in Session 6 recovered on its own.
- Whether cloudflared crashed/restarted/was killed, its journal, and its process
  count can only be read **on the host** → **BLOCKED**.
- The `/api/health` 503 flapping is **separate from the tunnel** and is an
  application-level DB-probe latency symptom.

## 5. Google OAuth `iss` error — root-caused and fixed (separate commit)

Determination chain (each step verified against the installed code):

| Step | Finding |
| --- | --- |
| Google sent `iss`? | **Not reliably.** Google's discovery advertises `authorization_response_iss_parameter_supported: true`, but its authorization responses do not always carry the parameter. |
| Browser received `iss`? | Whatever Google sent. |
| Cloudflare preserved `iss`? | Yes — query parameters pass through. |
| Next.js callback received `iss`? | Yes when sent. The auth route rebuilds on the public origin with `new NextRequest(new URL(request.url), request)`; a probe proved `code`, `state` **and `iss`** survive byte-for-byte. |
| Auth.js parsed `iss`? | `oauth4webapi.validateAuthResponse` (present since 3.3.0, pulled by `@auth/core@0.41.3`) throws `response parameter "iss" (issuer) missing` when the AS advertises support and the parameter is absent. The check runs **before** `code`/`state`, so it surfaces first. |

**Fix (commit `36da94e`).** The Google provider is given a `customFetch`
(`googleDiscoveryFetch`) that intercepts only Google's discovery response and
deletes the single `authorization_response_iss_parameter_supported` field.
This stops *requiring* `iss`; it does **not** disable issuer validation:

- when Google does send `iss`, oauth4webapi still compares it to the discovered
  issuer;
- the OIDC **id_token** `iss` claim is still validated during the code exchange;
- `state` and PKCE checks are untouched;
- no other discovery field (jwks, token/userinfo endpoints, issuer, algs) is
  modified, and only Google uses this fetch.

**Verification limit.** A real Google login callback (2FA/credentials) cannot be
completed here, so the fix is **not yet confirmed end-to-end in production**. It
is green on 7 new unit tests, typecheck, lint, and a full `next build`.

## 6. Repository (§15)

```text
HEAD   36da94e Tolerate Google omitting the RFC 9207 iss parameter on the OAuth callback
       b7c55b1 Document Session 6 YouTube production egress investigation
       d783e84 Cloudflare deploy support and playback hardening
status clean (nothing staged, nothing untracked, non-ignored)
```

No host secrets, tokens, certificates or provider credentials were committed.
The Session 6 temporary probe and the `build.out` scratch file were removed.

## 7. Regression

- Unit: **201 files / 2922 tests** pass (2915 + 7 new).
- Typecheck: pass. Lint: 0 errors / 2 pre-existing warnings. `next build`: pass.
- Production smoke: all PASS.
- YouTube: unchanged this session (no host access to re-run; Session 6's 1/8 and
  the `IP_REPUTATION / DATACENTER_NETWORK` classification stand).

## 8. Decision

The remediation Session 6 called for — change the origin's outbound network — and
the cloudflared investigation both require shell/admin access to the production
host, which this environment does not have. The one thing that *could* be fixed
independently (the Auth.js `iss` error) has been fixed and committed.

**FINAL STATUS: BLOCKED** — infrastructure access to the production origin
prevents the required remediation (egress change and cloudflared inspection). The
Auth.js fix is applied but requires a real Google callback to confirm.
