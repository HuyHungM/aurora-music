# Aurora Music — Session 6: YouTube Production Egress Investigation

**Date:** 2026-09-28
**Scope:** Prove or disprove that the Session 5 production YouTube playback
failure is a network/egress condition (not application code), identify the
production egress, and evaluate remediation.

**Non-goals:** broad project QA; rewriting the YouTube resolver before proof;
re-opening the Cloudflare Workers private-CA investigation.

---

## 1. Current production result (re-verified, not assumed)

The public endpoint briefly returned **HTTP 530 / Cloudflare error 1033**
("Cloudflare Tunnel error") during this session, then recovered to `200`. The
Node origin itself stayed up the whole time and was reachable directly:

```text
https://auroramuzik.dpdns.org/api/health        -> {"status":"ok","checks":{"database":"up"}}
http://zeus.hidencloud.com:24584/api/health     -> {"status":"ok","checks":{"database":"up"}}
```

Because the tunnel was intermittent, the 8-video sweep was run against the
**actual production origin** (`http://zeus.hidencloud.com:24584`, the process
behind the tunnel), which is the correct target for "reproducible from the
actual production origin".

| Video | Metadata resolve | Playback | Exact error |
| --- | --- | --- | --- |
| `dQw4w9WgXcQ` | resolved ("Rick Astley — Never Gonna Give You Up…") | **plays** (0:10 / 3:33, pause works) | — |
| `yuuWdm5tBD0` | fallback (title = id) | fails | `No playable audio format available` |
| `jNQXAC9IVRw` | fallback (title = id) | fails | `No playable audio format available` |
| `kJQP7kiw5Fk` | fallback (title = id) | fails | `No playable audio format available` |
| `9bZkp7q19f0` | fallback (title = id) | fails | `No playable audio format available` |
| `JGwWNGJdvx8` | fallback (title = id) | fails | `No playable audio format available` |
| `OPf0YbXqDm0` | fallback (title = id) | fails | `No playable audio format available` |
| `fJ9rUzIMcZQ` | fallback (title = id) | fails | `No playable audio format available` |

**Result: 1 / 8.**

Candidate/valid-format counts are emitted only in origin-side diagnostic logs,
to which this environment has no access (the origin is a remote container). The
observable client outcome — fallback metadata plus a zero-usable-format
resolution error — is recorded above. The residential differential below
records the valid-format counts, which the same code produces.

## 2. Cooldown / transient test

Re-run hours after Session 5, with no burst loop. Outcome is **identical**:
`dQw4w9WgXcQ` resolves and plays; the other seven fail. The failure is
**persistent**, not a momentary rate-limit spike. (The only transient event
observed was the cloudflared *tunnel connector* bouncing, unrelated to the
resolver.)

## 3. Production egress (identified)

| Property | Value |
| --- | --- |
| Host | `zeus.hidencloud.com` |
| Public host IPv4 | `20.193.253.17` |
| IPv6 | **none** — `zeus.hidencloud.com` has no `AAAA` record, so the origin is IPv4-only |
| Provider | Microsoft Azure (HidenCloud-hosted container on Azure) |
| Region | Pune, Maharashtra, India (IN) |
| ASN | AS8075 Microsoft Corporation |

The exact NAT/egress source IP for the origin's outbound YouTube requests is
**not observable** without shell access to the origin host. The host IPv4 above
is the only externally visible address; the origin egresses over IPv4 (no
AAAA). No browser, Cloudflare-edge or tunnel-public IP was used as a stand-in.

## 4. Differential: residential vs production (same code, same IDs)

A throwaway probe (`scripts/_tmp_resolve.mts`, created then deleted) ran the
**identical** resolver (`createInnertubePlaybackClient`, `PRIMARY_PLAYER_CLIENT=MWEB`
+ `IOS` fallback) from this residential network:

| Video | Residential | Valid formats | Title resolved |
| --- | --- | --- | --- |
| `yuuWdm5tBD0` | ok | 1 | SON TUNG M-TP — Come My Way |
| `dQw4w9WgXcQ` | ok | 7 | Rick Astley — Never Gonna Give You Up |
| `jNQXAC9IVRw` | ok | 13 | Me at the zoo |
| `kJQP7kiw5Fk` | ok | 7 | Luis Fonsi — Despacito |
| `9bZkp7q19f0` | ok | 7 | PSY — Gangnam Style |
| `JGwWNGJdvx8` | ok | 1 | Ed Sheeran — Shape of You |
| `OPf0YbXqDm0` | ok | 1 | Mark Ronson — Uptown Funk |
| `fJ9rUzIMcZQ` | ok | 7 | Queen — Bohemian Rhapsody |

**Residential: 8 / 8.** Production: **1 / 8.** Same resolver, same video IDs,
same time window. Metadata *and* format resolution degrade together on the
production origination, and unauthenticated search (a less-protected endpoint)
still works there — consistent with YouTube applying bot mitigation selectively
to the origin's player requests by source IP.

## 5. IPv4 vs IPv6

The origin is IPv4-only (no AAAA on the host, and the account has no IPv6
path), so all production YouTube traffic egresses over IPv4. No permanent
network-stack change was made.

## 6. Failure classification

```text
IP_REPUTATION / DATACENTER_NETWORK  (primary)
UPSTREAM_CHALLENGE                  (contributing)
```

**Evidence:** identical code and inputs; residential 8/8 vs Azure 1/8;
degraded responses affect the protected player endpoints on the origin while
less-protected endpoints still answer; failure is persistent across hours.

**Confidence:** high that the cause is the origin's **egress network**, not
application code. Medium on the exact upstream mechanism (sign-in/PO-token
challenge vs. probe-stage rejection of the returned media URLs) — that detail
is only visible in origin logs, which are inaccessible here.

Exact wording: production player requests receive behavior **materially
different** from the residential origin.

## 7. Resolver preserved

No resolver change was made. `PRIMARY_PLAYER_CLIENT = "MWEB"` with the `IOS`
fallback is intact. No client rotation, no added retries/sleeps, no cookies, no
hardcoded sessions, no TLS weakening, no undocumented proxy.

## 8. Remediation

No change was implemented: the correct fix is an **infrastructure/egress
change**, which cannot be applied from this environment (the origin is a remote
HidenCloud/Azure container with no shell access here; running cloudflared
locally would hijack the tunnel and is deliberately not done).

| Option | Assessment |
| --- | --- |
| A. Change production egress (different outbound IP / region / provider NAT, or IPv4 route) | **Recommended.** Least invasive legitimate fix. Requires host/panel access. |
| B. Move the resolver to a network with suitable outbound characteristics | Viable if the current host's egress cannot be fixed. |
| C. Alternate playback architecture (PO-token provider / other upstream) | Only if the egress cannot be fixed; a real architectural change with its own security surface. |
| D. Product fallback (document the limitation, other source/provider) | Fall back to only if server-side YouTube playback is impossible from the target environment. Never ship silently-broken playback. |

Rewriting the resolver to hide an egress problem is explicitly rejected.

**Security impact of remediation actually applied: none** (no code/config
changed). TLS and hostname verification remain on; no private key material
handled.

## 9. Repository state

- HEAD: `d783e84 Cloudflare deploy support and playback hardening`
- Working tree: **clean**; nothing staged, nothing untracked (non-ignored).
- The intentional deployment/documentation files are committed:
  `open-next.config.ts`, `wrangler.jsonc`, `FINAL-HARDENING-REPORT.md`,
  `RESPONSIVE-QA-REPORT.md`, `SESSION-5-PRODUCTION-VERIFICATION.md`, plus the
  23 application changes.
- Secret scan of the commit: only `.env.example` placeholders and test
  fixtures (`-----BEGIN CERTIFICATE-----` example text); no live CA, key,
  token or credential material. `.gitignore` covers `.dev.vars*`, `.qa/`,
  `*.out`, `.open-next/`, `.wrangler/`.
- Temporary artifacts: the differential probe was deleted; none remain.

## 10. Regression (unchanged — no code modified this session)

- YouTube-specific tests: green as of Session 5; local differential 8/8.
- Unit: 200 files / 2915 tests (Session 5).
- Typecheck: pass. Lint: 0 errors / 2 pre-existing warnings.

## 11. Decision

The production target does **not** meet the success criterion
(8/8 → resolve → usable audio → playback, reproducible from the production
origin). The cause is external network egress, not application code.

**FINAL STATUS: NOT READY** (production playback unreliable; root cause
external — remediation requires an egress/infrastructure change outside this
environment). Cloudflare Workers remains **BLOCKED** (private CA cannot be
supplied to `cloudflare:sockets`) and is not conflated with Node readiness.
