# Session 9B — Production Dependency & Host Diagnostics

**Date:** 2026-09-28
**Scope:** Confirm production dependency parity (specifically `youtubei.js`) before
treating Session 6/7's egress hypothesis as the remaining blocker; inspect host /
cloudflared access. Diagnostic only — no application code was modified.

---

## Executive summary

- **SFTP is NOT available in this environment.** The production SFTP endpoint
  (`zeus.hidencloud.com:2022`) is up and offers `password,publickey`, but this
  machine holds **no credential of either kind** and no SFTP client/session. A
  connection *was* made from outside this session (the host key is pinned in
  `known_hosts`), but the credential it used is not present here.
- **HOST SHELL ACCESS UNAVAILABLE.** No provider console / web terminal, no MCP
  shell tool, no SSH key/config/agent, and no panel session exists.
- Therefore the node_modules inspection the session requires **cannot be
  performed**, and dependency parity is **UNVERIFIED**.
- **Publicly verifiable**: production serves buildId `Wybxp71HRetJUj52Euu_p`
  (matches the session's claim; `/_next/static/Wybxp71HRetJUj52Euu_p/_buildManifest.js`
  → 200). Full "source commit = 0ffa93e" cannot be independently confirmed.
- **One materially useful local fact**: `youtubei.js` is **exact-pinned** to
  `18.0.0` (no `^`/`~`) in `package.json`. `next` (16.3.5) and `react`/`react-dom`
  (19.2.8) are exact-pinned too. An accidental `npm install` therefore cannot
  change the critical package's version — it resolves to `18.0.0` under either
  installer. This **weakens** (but does not eliminate) the dependency-mismatch
  explanation for the 1/8 YouTube result; it does **not** prove the egress
  hypothesis, because the server tree could still be absent/corrupt/inconsistent.
- Per the session's own rule (§1), **no resolver or other application code was
  touched**.

---

## Deployment

- **Production commit:** claimed `0ffa93e` — **unverifiable from here**. Partial
  public corroboration: served buildId is `Wybxp71HRetJUj52Euu_p`.
- **Build ID:** `Wybxp71HRetJUj52Euu_p` — **verified publicly** (present in served
  HTML; `/_next/static/Wybxp71HRetJUj52Euu_p/_buildManifest.js` → HTTP 200).
- **Install method:** **UNKNOWN** — no host access; cannot confirm `bun install`
  vs `npm install`, nor whether the running `node_modules` came from either.
- **Build method:** **UNKNOWN** — `start.js` does not exist in the repository
  (it would be server-only), so the deployed start/build path cannot be inspected
  from here.

## Dependency Parity

`Expected` = exact repo intent (`package.json` pins + `bun.lock`). `Production` and
`package-lock` columns require host access and are **UNAVAILABLE**.

| Package | Expected | Production node_modules | package-lock | Match |
| --- | --- | --- | --- | --- |
| youtubei.js | `18.0.0` (exact pin) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| @auth/core | `0.41.3` (via next-auth) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| oauth4webapi | `3.8.8` (via @auth/core) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| next-auth | `5.0.0-beta.32` | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| next | `16.3.5` (exact pin) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| react | `19.2.8` (exact pin) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| react-dom | `19.2.8` (exact pin) | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| prisma | `7.10.0` | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| @prisma/client | `7.10.0` | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| @prisma/adapter-pg | `7.10.0` | UNAVAILABLE | UNAVAILABLE | UNKNOWN |
| pg | `8.23.0` | UNAVAILABLE | UNAVAILABLE | UNKNOWN |

## Critical Dependency

- **youtubei.js expected:** `18.0.0` — **exact** pin (`package.json` line 39, no
  range operator; identical in `bun.lock`).
- **youtubei.js production:** **UNAVAILABLE** (no SFTP/host access to read
  `node_modules/youtubei.js/package.json`).
- **Match:** **UNKNOWN**, but an exact pin means both `npm` and `bun` would install
  `18.0.0`; a mismatch would require an install failure, a partial tree, or manual
  tampering rather than lockfile drift.

## Timeline

- **Source pull:** UNKNOWN (server-side).
- **Install:** UNKNOWN.
- **node_modules update:** UNKNOWN (`mtime` of `node_modules/youtubei.js/package.json`
  and `node_modules/@auth/core/package.json` could not be read).
- **Build:** production buildId `Wybxp71HRetJUj52Euu_p` is live; exact build time
  UNKNOWN.

## Host Access

- **SFTP:** endpoint up (`zeus.hidencloud.com:2022`, auth `password,publickey`),
  but **no credential available here** → cannot connect.
- **Shell:** **UNAVAILABLE.**
- **Provider console:** none accessible (no HidenCloud/Pterodactyl panel session
  or credentials; only browser tab is the production app itself).
- **Available diagnostics:** public HTTP only (the production app + build assets).

**HOST SHELL ACCESS UNAVAILABLE.**

## Network

- **Egress:** not re-measured this session (requires host). Session 6/7 value stands:
  HidenCloud container on Microsoft Azure, AS8075.
- **IPv4:** `20.193.253.17` (host A record; exact NAT egress unobservable here).
- **IPv6:** none (host is IPv4-only).
- **DNS:** `zeus.hidencloud.com` → `20.193.253.17` (CNAME `zeus.ns.hidencloud.com`).
- **Route:** could not inspect (`ip route` is host-only).

## Cloudflare

- **Process:** could not inspect (host-only).
- **Tunnel:** public URL serves 200; tunnel ID/connector count unknown.
- **Protocol:** unknown (`CLOUDFLARED_PROTOCOL` env exists locally but says nothing
  about the running connector).
- **Logs:** unavailable.
- **530/1033:** none observed (no host logs; no external 530/1033 during this
  session's probes).

## YouTube

- **Residential:** 8/8 (Session 6/7 differential, same resolver/IDs).
- **Production:** 1/8 (Session 6/7; recorded against buildId-verified origin).
- **Result:** **not re-tested this session** — §13 conditions a re-test on confirmed
  parity **and** shell access, neither of which is available. No resolver change was
  made.

## Root Cause

- **Dependency mismatch / Network egress / Transient / Unknown:** **Unknown —
  UNRESOLVED pending parity.** Dependency parity could not be checked (no access),
  so per the session's decision tree the egress hypothesis is **not** declared
  proven. The exact pin on `youtubei.js` makes a lockfile-drift mismatch unlikely;
  the strongest prior evidence still points to production egress/upstream
  treatment, but that remains a hypothesis, not a proof.

## Recommended Remediation

1. **Provide host access** — one of: the Session 9A SFTP credentials/connection
   method, an SSH key for `zeus.hidencloud.com:2022`, or a HidenCloud/Pterodactyl
   panel session with a Console/Web Terminal. (Do not paste secrets into reports;
   expose them to the tool only.)
2. With access, run the §2/§3/§7 inspection: read the eleven `node_modules/*/package.json`
   `version` fields, compare to the Expected column above, and check `mtime`s.
3. If `youtubei.js` production ≠ `18.0.0` (or the tree is absent/inconsistent):
   `PARITY BROKEN` → clean `node_modules` → `bun install --frozen-lockfile` → rebuild
   → redeploy. Never mix Bun and npm installation.
4. If parity holds, repeat the 8-video test from the origin before any network change.
5. Investigate the stray `package-lock.json` / `npm install` origin on the host
   (`start.js`, startup scripts); remove it only once its cause is understood.

## FINAL STATUS

**BLOCKED** — the required diagnostic (SFTP node_modules inspection) and host
console/cloudflared inspection are prevented by unavailable host access. No code was
modified.
