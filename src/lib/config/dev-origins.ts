import { networkInterfaces } from "node:os";

/**
 * Hostname allowlist for `next dev`, consumed by `next.config.ts`.
 *
 * Why this exists
 * ---------------
 * Next.js refuses dev-only resources (`/_next/*`, `/__nextjs_*`) whose
 * `Origin`/`Referer` host is not the hostname the dev server was started with,
 * plus `localhost`. Opening the app from another device on the LAN
 * (`http://192.168.1.32:3000`) - or even from `127.0.0.1` - therefore gets 403
 * responses for the HMR websocket and the dev font endpoint, and the client
 * never hydrates: the page ships as inert server HTML, so nothing is
 * interactive (play, like, menus, search-as-you-type all silently do nothing).
 * `allowedDevOrigins` is the supported remedy; this module computes its value.
 *
 * Rules this module exists to enforce
 * -----------------------------------
 * - Hostnames only: Next matches `URL#hostname` of the `Origin` header and
 *   ignores scheme, port, path and query. Entries are normalised to that shape
 *   so a pasted `http://192.168.1.32:3000/` still works.
 * - Never a bare `*` / `**`: the allowlist is a development safety boundary
 *   for internal endpoints. A wildcard would opt every host that can reach the
 *   port into them, which is exactly what the default deny is protecting.
 * - Detection, not a committed address: DHCP and VPN addresses rotate (this
 *   machine's Tailscale address changed mid-session), and a hardcoded IP is
 *   wrong on every other network and becomes a stale invariant in the repo.
 * - Development only: `getAllowedDevOrigins` returns `[]` outside
 *   `NODE_ENV=development`, so production config stays byte-for-byte what it
 *   was before this option existed.
 *
 * Optional override: `AURORA_DEV_ORIGINS` (comma/space separated hostnames)
 * replaces detection when a machine's interfaces are not what you want to
 * expose - e.g. you only want the Tailscale address, not the cafe Wi-Fi one.
 */

/** Name of the optional override variable. Not a secret: a hostname list. */
export const DEV_ORIGIN_OVERRIDE_ENV_VAR = "AURORA_DEV_ORIGINS";

/**
 * Loopback always works from the host itself, but Next only auto-allows
 * `localhost` and `**.localhost` - `127.0.0.1` and `[::1]` are separate
 * hostnames and are blocked without an entry (the dev server logs tell you so
 * verbatim). `localhost` is listed anyway so the list reads as complete.
 */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * Minimal shape of `os.networkInterfaces()`, declared structurally so this
 * module carries no dependency on a particular `@types/node` version's family
 * encoding (`4 | 6` before Node 18, `"IPv4" | "IPv6"` after).
 */
export type NetworkInterfaceMap = Record<
  string,
  | ReadonlyArray<{
      address: string;
      family: string | number;
      internal: boolean;
    }>
  | undefined
>;

const HOSTNAME_PATTERN =
  /^(?:localhost|(?:\[[0-9a-f:]+\])|(?:\d{1,3}(?:\.\d{1,3}){3})|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*))$/;

/**
 * Normalise one candidate into the exact shape Next compares against.
 *
 * Returns `null` for anything that is not an unambiguous single hostname, so a
 * malformed override entry is dropped rather than silently widening the list.
 */
export function normalizeDevOriginEntry(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return null;
  }

  // Drop the scheme: "http://host:3000" -> "host:3000".
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  if (withoutScheme === "") {
    return null;
  }

  // Drop path/query/hash: "host/dashboard?x=1" -> "host".
  const beforePath = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  if (beforePath === "") {
    return null;
  }

  let hostname = beforePath;
  if (hostname.startsWith("[")) {
    // Bracketed IPv6, optionally with a port: "[::1]:3000" -> "[::1]".
    const closing = hostname.indexOf("]");
    if (closing === -1) {
      return null;
    }
    hostname = hostname.slice(0, closing + 1);
  } else if (hostname.split(":").length > 2) {
    // Bare IPv6 (more than one colon means the colons are address, not a
    // port). Next reads `URL#hostname`, which is bracketed for IPv6.
    hostname = `[${hostname}]`;
  } else {
    const colon = hostname.indexOf(":");
    if (colon !== -1) {
      const port = hostname.slice(colon + 1);
      if (/^\d+$/.test(port)) {
        // "host:3000" -> "host". A non-numeric suffix is not a URL we can
        // interpret, so the entry is rejected rather than guessed at.
        hostname = hostname.slice(0, colon);
      } else {
        return null;
      }
    }
  }

  if (hostname === "") {
    return null;
  }
  if (HOSTNAME_PATTERN.test(hostname)) {
    return hostname;
  }

  // Scoped subdomain patterns ("*.tunnel.example.com") are still expressible,
  // but a bare `*`/`**` - which would match every host that can reach the
  // port - is never an acceptable development allowlist entry. Next's own
  // matcher rejects it too; saying so here keeps the rule at the boundary
  // instead of relying on the library.
  const wildcardLabel = /^(?:\*|\*\*)$/;
  const plainLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const labels = hostname.split(".");
  if (labels.every((label) => wildcardLabel.test(label))) {
    return null;
  }
  return labels.every(
    (label) => wildcardLabel.test(label) || plainLabel.test(label),
  )
    ? hostname
    : null;
}

/**
 * Split the override value: commas and/or whitespace, each token normalised,
 * invalid tokens dropped, order preserved, duplicates removed.
 */
export function parseDevOriginOverride(value: string | undefined | null): string[] {
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  for (const token of value.split(/[\s,]+/)) {
    const normalized = normalizeDevOriginEntry(token);
    if (normalized) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * Hostnames of this machine's routable interfaces, so a phone on the same
 * network can open the dev server at `http://<address>:<port>`.
 *
 * Loopback and internal (NAT) interfaces are skipped: they are either already
 * covered by `LOOPBACK_HOSTNAMES` or unreachable from another device. IPv6
 * link-local addresses are skipped too - they need a zone id (`%eth0`) that
 * cannot appear in an origin.
 */
export function detectInterfaceHostnames(
  interfaces: NetworkInterfaceMap = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }
      const family = String(entry.family).toLowerCase();
      const isIpv4 = family === "ipv4" || family === "4";
      if (!isIpv4 && entry.address.toLowerCase().startsWith("fe80")) {
        continue;
      }
      const normalized = normalizeDevOriginEntry(
        isIpv4 ? entry.address : `[${entry.address}]`,
      );
      if (normalized) {
        found.add(normalized);
      }
    }
  }
  return [...found].sort();
}

export type ResolveDevOriginsOptions = {
  /** Raw `AURORA_DEV_ORIGINS` value; when present it replaces detection. */
  override?: string | undefined;
  /** Injected in tests; defaults to the real interface table. */
  interfaces?: NetworkInterfaceMap;
};

/**
 * Loopback + detected LAN hostnames, or loopback + override when set.
 * Always deduplicated, never containing a bare wildcard.
 */
export function resolveAllowedDevOrigins(
  options: ResolveDevOriginsOptions = {},
): string[] {
  const extra =
    options.override !== undefined
      ? parseDevOriginOverride(options.override)
      : detectInterfaceHostnames(options.interfaces);

  const merged = [...LOOPBACK_HOSTNAMES, ...extra];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of merged) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Value for `allowedDevOrigins` in `next.config.ts`.
 *
 * Empty outside development so a production build never carries a dev
 * allowlist, and so importing `next.config.ts` from a test (which does not run
 * with `NODE_ENV=development`) yields the same config as before.
 */
export function getAllowedDevOrigins(
  // `Partial`, because Next's `ProcessEnv` declares `NODE_ENV` as required:
  // the tests pass a literal env object, and a config helper should accept a
  // partial env rather than the whole process.
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string[] {
  if (env.NODE_ENV !== "development") {
    return [];
  }
  return resolveAllowedDevOrigins({
    override: env[DEV_ORIGIN_OVERRIDE_ENV_VAR],
  });
}
