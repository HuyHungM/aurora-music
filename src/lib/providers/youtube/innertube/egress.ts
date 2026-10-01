/**
 * Optional forward-proxy egress for the YouTube InnerTube session. SERVER-ONLY.
 *
 * WHY THIS EXISTS. YouTube runs an anti-bot layer in front of the player
 * endpoint. From some network egresses — datacenter ranges, Vercel Functions
 * among them — it answers a valid request with
 * `playabilityStatus.status = "LOGIN_REQUIRED"`, reason "Sign in to confirm
 * you're not a bot", and NO `streaming_data`. Extraction then sees zero
 * formats and playback fails with `PLAYBACK_RESOLUTION_ERROR`, while the same
 * video, same code and same library resolve normally from a non-datacenter
 * egress. This is an upstream/network condition, not a parser or decipher
 * bug, and the only legitimate remedy is to change the egress the request
 * leaves from (Session 6 / 9B conclusions).
 *
 * WHAT IT DOES, AND ONLY THAT. When `AURORA_YOUTUBE_EGRESS_PROXY` is set, the
 * one shared `Innertube.create()` in the repository is configured so that its
 * HTTP client sends through that proxy. Nothing else is proxied: not Auth.js,
 * not Prisma, not the Spotify or YouTube Data API providers, not the
 * googlevideo media probe (the CDN is reachable directly and is fetched by the
 * user's browser anyway), and not any user request. Discovery and playback
 * share the session, so both are covered — they are the same upstream client
 * either way.
 *
 * DEFAULT OFF. With the variable unset this module returns the global `fetch`
 * and never touches youtubei.js's platform shim, so the default runtime
 * behaviour is byte-for-byte what it was before this file existed.
 *
 * WHY IT OVERRIDES THE WHOLE SHIM TRIPLE. youtubei.js's HTTP client builds a
 * `Platform.shim.Request`, wraps it in `Platform.shim.Headers`, and hands both
 * to `Platform.shim.fetch`. A dispatcher from one undici instance cannot be
 * mixed with another instance's `fetch`/`Request` (verified: passing a global
 * `Request` to `undici.fetch` fails to parse), so when a proxy is configured
 * the triple is replaced together from the same `undici` module. `Response`
 * is never read through the shim, so it is deliberately left alone. The
 * `undici` import is dynamic and only reached when a proxy is configured, so
 * the default path — and every test that never sets the variable — loads no
 * extra dependency.
 *
 * CREDENTIALS. A proxy URL may embed `user:password@`. It is read from the
 * validated environment, never logged, and never exposed to the client.
 */

import { Platform } from "youtubei.js";
import { getEnv } from "@/lib/config/env";

type FetchFn = typeof fetch;

/** The subset of `undici` this module needs. Kept structural for testing. */
export interface UndiciEgressModule {
  fetch: typeof fetch;
  ProxyAgent: new (url: string) => unknown;
  Request: typeof Request;
  Headers: typeof Headers;
}

/** A self-consistent fetch/Request/Headers triple bound to one proxy. */
export interface YouTubeEgress {
  fetch: FetchFn;
  Request: typeof Request;
  Headers: typeof Headers;
}

/**
 * Builds the proxied triple from an `undici` implementation. Pure and
 * injectable: the production path passes the real module, tests pass a stub,
 * and neither performs I/O here.
 */
export function buildProxiedEgress(
  proxyUrl: string,
  undici: UndiciEgressModule,
): YouTubeEgress {
  const dispatcher = new undici.ProxyAgent(proxyUrl);
  const proxied = ((
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) =>
    undici.fetch(input as never, {
      ...(init ?? {}),
      dispatcher,
    } as never)) as FetchFn;
  return { fetch: proxied, Request: undici.Request, Headers: undici.Headers };
}

let installPromise: Promise<void> | null = null;

/** Test hook: forgets any memoised install attempt. */
export function resetYouTubeEgress(): void {
  installPromise = null;
}

async function loadUndici(): Promise<UndiciEgressModule> {
  // Dynamic so the default, proxy-less path never loads or bundles it.
  const mod = await import("undici");
  return mod as unknown as UndiciEgressModule;
}

/**
 * Installs the proxy egress on the platform shim exactly once per process.
 * Must be awaited BEFORE `Innertube.create()`: the library captures
 * `Platform.shim.fetch` when it constructs its HTTP client. Safe to call
 * repeatedly; a failed install clears the memo so the next session attempt
 * retries instead of replaying the rejection.
 */
export function installYouTubeEgress(): Promise<void> {
  if (installPromise) {
    return installPromise;
  }
  const proxyUrl = getEnv().AURORA_YOUTUBE_EGRESS_PROXY;
  if (!proxyUrl) {
    // Default off: leave the shim exactly as the platform set it.
    installPromise = Promise.resolve();
    return installPromise;
  }
  installPromise = loadUndici()
    .then((undici) => {
      const built = buildProxiedEgress(proxyUrl, undici);
      Platform.shim.fetch = built.fetch;
      Platform.shim.Request = built.Request;
      Platform.shim.Headers = built.Headers;
    })
    .catch((error: unknown) => {
      installPromise = null;
      throw error;
    });
  return installPromise;
}
