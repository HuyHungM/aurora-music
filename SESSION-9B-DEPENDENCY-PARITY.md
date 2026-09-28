# Session 9B — Production Dependency & Host Diagnostics

**Date:** 2026-09-28
**Scope:** Confirm production dependency parity (specifically `youtubei.js`) before
treating Session 6/7's egress hypothesis as the remaining blocker; inspect host /
cloudflared access. Diagnostic only — no application code was modified.

---

## Executive summary

- **SFTP/host file access was obtained.** The HidenCloud Pterodactyl SFTP endpoint
  (`zeus.hidencloud.com:2022`) accepted the credentials that were supplied
  out-of-band to the tool. The session's SFTP root is the application directory
  (chroot), so the tree was inspected directly. **No credential or secret is
  recorded in this document.**
- **Dependency parity is VERIFIED — not unverified.** Production `bun.lock` is
  **byte-for-byte identical** to the repository `bun.lock` (same size and
  SHA-256), and every runtime-critical package resolves to the **same tarball**
  in production's `package-lock.json` as in the repo `bun.lock` (identical sha512
  integrity). Production `youtubei.js` = **18.0.0**, exactly the pin.
- **The dependency-mismatch explanation is eliminated.** 54 packages differ
  between the two lockfiles, **all dev/build-only** (eslint plugins, browserslist,
  caniuse-lite, rolldown bindings, `dotenv`, `globals`, …) resolving newer
  patch/minor from caret ranges. None are in the resolver's runtime path.
- **8-video sweep re-run against the live origin: 1/8**, exact error unchanged
  (`No playable audio format available`, stage `stream`, `retryable:false`).
  Production HEAD = `dfc35f7` (repo HEAD); buildId `bacbgrFwvhwDhH7ItZ2_9`.
- **Root cause: production egress / upstream treatment**, not dependency drift.
  The origin's egress IP is now directly observable as **`20.193.253.17`** (the
  `ip=` parameter inside the one successful signed media URL).
- **HOST SHELL ACCESS remains UNAVAILABLE** (SFTP only). Cloudflared
  process/protocol/route/log inspection is still blocked.
- Per the session's rule (§1), **no resolver or other application code was
  touched**.

---

## 1. Access obtained (this session)

| Channel | Status |
| --- | --- |
| SFTP (`zeus.hidencloud.com:2022`) | **Available** — authenticated, host key matched the existing `known_hosts` pin; read-only inspection performed |
| Shell / SSH exec | **Unavailable** — SFTP has no command execution |
| Pterodactyl panel console | Not accessible from here |
| Cloudflared process/logs | Unavailable (needs shell) |

> The SFTP credentials were provided by the operator for this diagnostic and were
> used only to read files. They are deliberately not recorded here, and `.env` /
> `secrets/` contents were not read.

## 2. Dependency parity — **VERIFIED**

`Expected` = repository intent (`package.json` exact pins + `bun.lock`).
`Production` = value read from `node_modules/<pkg>/package.json` on the origin.

| Package | Expected | Production | Match |
| --- | --- | --- | --- |
| youtubei.js | `18.0.0` (exact pin) | `18.0.0` | ✅ |
| @auth/core | `0.41.3` (via next-auth) | `0.41.3` | ✅ |
| oauth4webapi | `3.8.8` (via @auth/core) | `3.8.8` | ✅ |
| next-auth | `5.0.0-beta.32` | `5.0.0-beta.32` | ✅ |
| next | `16.3.5` (exact pin) | `16.3.5` | ✅ |
| react | `19.2.8` (exact pin) | `19.2.8` | ✅ |
| react-dom | `19.2.8` (exact pin) | `19.2.8` | ✅ |
| prisma | `7.10.0` | `7.10.0` | ✅ |
| @prisma/client | `7.10.0` | `7.10.0` | ✅ |
| @prisma/adapter-pg | `7.10.0` | `7.10.0` | ✅ |
| pg | `8.23.0` | `8.23.0` | ✅ |

**All eleven match.**

### 2.1 Lockfile parity

- Repo `bun.lock` SHA-256: `22e6ef183909f96984964ba15f3bc2746a0b9c7ee7c7500e1aeaa20572322c7a`
  (size 265,625 B).
- Production `bun.lock` SHA-256: `22e6ef183909f96984964ba15f3bc2746a0b9c7ee7c7500e1aeaa20572322c7a`
  (size 265,625 B).
- **Identical — zero diff lines.**

### 2.2 Tarball (integrity) parity

Production also carries an `npm`-generated `package-lock.json`. For every
runtime-critical package its `integrity` equals the repo `bun.lock` `sha512-…`
value, i.e. the same published tarball is installed. Examples:

| Package | sha512 (repo `bun.lock` == prod `package-lock.json`) |
| --- | --- |
| `youtubei.js@18.0.0` | `sha512-7Tztl5QzNL4nIhiAxa4P/0C8cDDsUe0j4iaUeNiaA+ZfSe/l+HkHxXyoWlQXNW7IPi2n6AW23ysVMJLDh+AwWQ==` |
| `@auth/core@0.41.3` | `sha512-sJ3JMHHkXMD3aOjopv7mOBTO1Ocw4b0fAEXJBz6k7YHLpYQI6C40jCUPc5fNvUKxXRXNE1/sRISA15UrwWJBTw==` |
| `oauth4webapi@3.8.8` | `sha512-8N28E+a/oxfXWBgOMt+ZP/JUf/XR+IFbvkAEPP3gznXOMv9BpAAwiIj0TFNz3tGTPc0ZQ8zmWBNgN1nAys0gng==` |
| `next@16.3.5` | `sha512-MdtsTgzyfCPRLC6uJ1mN8ao7lyJ4BB0U6Inhnx3gta1UcCIdHK3yxLG0E8OWQteWD8/Q0qb8A5o7wJaL8M9y2w==` |
| `pg@8.23.0` | `sha512-Ip2EQCngowJLGOfCwkFhPXU7/ljlhn6Rxlmy4XYfL2Y+vyRM59+8uR2xqRWKdYmbXmxCFOAmKxBuSUCdF34qLg==` |

A full automated join of the two lockfiles: **860 packages with identical
integrity**, **0 mismatches among any runtime-critical package**, and **0
packages present on the origin but absent from the repo graph**.

### 2.3 Dev/build-only drift (54 packages)

The only differences are dev/build tooling resolving newer patch/minor from
caret ranges on the origin (e.g. `@typescript-eslint/*` `8.70.0 → 8.70.1`,
`browserslist` `4.29.0 → 4.29.1`, `caniuse-lite`, `baseline-browser-mapping`,
`electron-to-chromium`, `rolldown` bindings `1.2.9 → 1.2.11`, `dotenv`,
`globals`, `@csstools/*`, `@emnapi/runtime`, `@oxc-project/types`, `isexe`).
**None are reachable from the playback resolver.** They cannot change the
`No playable audio format available` outcome.

## 3. Critical dependency

- **youtubei.js expected:** `18.0.0` — exact pin (`package.json`, no range).
- **youtubei.js production:** `18.0.0` — read directly from
  `node_modules/youtubei.js/package.json`.
- **Integrity:** identical tarball (see §2.2).
- **Decision-tree outcome:** production `youtubei.js` == local `youtubei.js` and
  all relevant dependency versions match → **dependency-version investigation is
  closed**; the residual differential is egress/upstream treatment.

## 4. Install / build method (mixed tooling, no version effect)

- The official `start.js` deploys with **Bun**: `bun install --frozen-lockfile` →
  `bun next build` → `bun next start` (cloudflared + migrations around it).
- The origin nonetheless contains an **npm-generated `package-lock.json`** and
  `.npm/_logs/` entries for plain `npm install` (npm 12.1.0 / node 24.21.0, cwd
  `/home/container`, exit 0) — so `npm install` has been run on the host in
  addition to Bun.
- npm 12 blocks dependency lifecycle scripts by default; the logs report **7
  blocked** (`esbuild@0.25.4/0.28.1/0.28.2`, `@prisma/engines@7.10.0`,
  `prisma@7.10.0`, `unrs-resolver@1.12.2`, `workerd@…`). The **root** project
  `postinstall` (`prisma generate`) still ran — `src/generated/prisma/*` is
  present and was regenerated at install time.
- **Net effect on runtime:** none. `bun.lock` governs, `package-lock.json`
  resolves the same runtime tarballs (§2.2), and the only drift is dev tooling
  (§2.3). Mixing the two installers is still undesirable hygiene, but it did
  **not** cause the playback failure.

## 5. Timeline (origin file mtimes, local time)

| Event | Evidence |
| --- | --- |
| Previous source pull | source files (`package.json`, `ARCHITECTURE.md`, …) `Sep 28 11:52:30` |
| `npm install` (log 1) | `/.npm/_logs/2026-09-28T04_52_30_406Z-…` |
| `npm install` (log 2, pre-build) | `/.npm/_logs/2026-09-28T10_29_46_115Z-…`; `package-lock.json` `17:29:49` |
| first build this day | `.next` `17:30:55` (served buildId later observed as `Wybxp71HRetJUj52Euu_p`) |
| `git pull 0ffa93e → dfc35f7` + `npm install` + build | `.git` `19:56:39`, `package-lock.json` `19:56:36`, `node_modules` `19:56:39`, `src/generated/prisma` `19:56:40`, `.next/BUILD_ID` `19:57:53` |
| current deployed buildId | **`bacbgrFwvhwDhH7ItZ2_9`** |

> The origin was redeployed mid-session (pull to `dfc35f7`, the repository's
> current HEAD); both the pre- and post-redeploy `package-lock.json` are
> **byte-identical** (SHA-256 `f19c23a398ecf0d33338fc841503f3f7fb8452e45a451df8483c54b4ba1beab0`).

## 6. Host access

- **SFTP:** available and used (read-only).
- **Shell:** **UNAVAILABLE.**
- **Provider console:** not accessible from here.

**HOST SHELL ACCESS UNAVAILABLE.** Consequently `ps`, `ip route`, `curl`,
`systemctl`, and cloudflared logs remain unobservable.

## 7. Network

- **Egress IP:** now **directly confirmed** as **`20.193.253.17`** — the `ip=`
  parameter of the successful `googlevideo.com` media URL returned by the origin
  (the URL is signed for the requesting address). This matches the host A record.
- **Provider:** Microsoft Azure, AS8075, Pune (IN); IPv4-only (no AAAA).
- **Route/NAT internals:** not inspectable without shell.

## 8. Cloudflare

- **Process / tunnel / protocol / logs:** not inspectable without shell.
- No `530`/`1033` was observed during this session's origin probes; the direct
  origin `:24584` answered throughout.

## 9. YouTube — 8-video sweep (re-run this session)

Method: the production **server action** `resolveAudioSourceAction`
(id `60127df6b0f18b570f3d331bd10d1ed04e146acefc`, taken from the deployed
`.next/server/server-reference-manifest.json`) was invoked against the **direct
origin** `http://zeus.hidencloud.com:24584`, ~2.5 s apart. Only properties are
recorded — never the full signed media URL.

| Video | Result | Audio URL host | Error |
| --- | --- | --- | --- |
| `dQw4w9WgXcQ` | **ok** (`video/mp4; avc1+mp4a`, 213000 ms, 444226 bps) | `rr5---sn-cvh7knzk.googlevideo.com` | — |
| `yuuWdm5tBD0` | fail | — | `No playable audio format available` (stage `stream`) |
| `jNQXAC9IVRw` | fail | — | `No playable audio format available` (stage `stream`) |
| `kJQP7kiw5Fk` | fail | — | `No playable audio format available` (stage `stream`) |
| `9bZkp7q19f0` | fail | — | `No playable audio format available` (stage `stream`) |
| `JGwWNGJdvx8` | fail | — | `No playable audio format available` (stage `stream`) |
| `OPf0YbXqDm0` | fail | — | `No playable audio format available` (stage `stream`) |
| `fJ9rUzIMcZQ` | fail | — | `No playable audio format available` (stage `stream`) |

**Result: 1 / 8 — identical to Session 6**, on a freshly rebuilt origin with
proven dependency parity. Exact client-observable error is unchanged. Candidate /
valid-format counts are still only in origin-side diagnostic logs (no shell).

## 10. Root cause

- **Dependency mismatch:** **eliminated** (§2).
- **Network egress / upstream treatment:** **high confidence.** Same code, same
  exact dependency tarballs, same video IDs: residential 8/8 (Session 6) vs
  production 1/8, persistent, egress `20.193.253.17`.
- **Transient:** no — reproduced hours apart and after a full redeploy.
- **Unknown:** the precise upstream mechanism (sign-in/PO-token challenge vs
  probe-stage rejection of returned media URLs) — visible only in origin logs.

## 11. Recommended remediation

1. **Change production egress** — a different outbound IP / NAT / region /
   provider whose egress is not treated as a datacenter by YouTube, or front the
   player requests from a permitted network. Least-invasive legitimate fix;
   requires host/panel control.
2. If egress cannot be changed: move the resolver to a suitable outbound network
   (Option B), or adopt a PO-token-capable architecture (Option C) as a real
   change with its own security surface.
3. **Do not** rewrite the resolver, rotate clients, add retries/cookies/PO
   tokens, or weaken TLS to hide the egress condition.
4. Hygiene (not the bug): eliminate the extra `npm install` on the host so only
   `bun install --frozen-lockfile` owns the tree; remove the stray
   `package-lock.json` once its cause is understood.

## 12. FINAL STATUS

**Parity: VERIFIED.** **Origin: NOT READY** — 1/8 production playback remains the
blocker. **Root cause: production egress / upstream treatment** (not dependency
drift). **Host shell / cloudflared inspection: BLOCKED** (SFTP only, no exec).
No application code was modified.
