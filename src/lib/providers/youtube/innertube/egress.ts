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

/**
 * Creates a proxy-dispatched `fetch` that leaves `Request`/`Headers`
 * construction to the caller.
 *
 * This is the temporary dual-egress seam: the two failover InnerTube
 * sessions must send through different proxies while the shared session and
 * the googlevideo probe keep their existing globals. Translating the request
 * to URL + method + headers + body before calling `undici.fetch` keeps one
 * undici module coherent with both dispatchers, instead of replacing the
 * global shim triple twice. The proxy URL (which may embed credentials) is
 * held only in the dispatcher closure and is never logged.
 */
export function createProxyFetch(
  proxyUrl: string,
  undici: UndiciEgressModule,
): FetchFn {
  const dispatcher = new undici.ProxyAgent(proxyUrl);
  return (async (
    input: Parameters<FetchFn>[0],
    init?: Parameters<FetchFn>[1],
  ) => {
    const headers = new undici.Headers();
    appendProxyHeaders(headers, requestHeaders(input));
    appendProxyHeaders(headers, (init as { headers?: unknown } | undefined)?.headers);
    const rest = { ...((init ?? {}) as Record<string, unknown>) };
    // Body, headers, and dispatcher are always derived here: a caller must
    // not smuggle a different dispatcher (or proxy URL) into the request.
    delete rest.body;
    delete rest.headers;
    delete rest.dispatcher;
    return undici.fetch(requestUrl(input), {
      ...(rest as object),
      method: requestMethod(input, init),
      headers,
      body: await requestBody(input, init),
      dispatcher,
    } as never);
  }) as FetchFn;
}

function requestUrl(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url === "string" && url.length > 0) {
    return url;
  }
  throw new TypeError("Unsupported proxy fetch input");
}

function requestRecord(input: Parameters<FetchFn>[0]): {
  method?: unknown;
  headers?: unknown;
  bodyUsed?: unknown;
  text?: unknown;
} | null {
  if (typeof input === "object" && input !== null && !(input instanceof URL)) {
    return input as {
      method?: unknown;
      headers?: unknown;
      bodyUsed?: unknown;
      text?: unknown;
    };
  }
  return null;
}

function requestMethod(
  input: Parameters<FetchFn>[0],
  init?: Parameters<FetchFn>[1],
): string {
  const initMethod = (init as { method?: unknown } | undefined)?.method;
  if (typeof initMethod === "string" && initMethod.length > 0) {
    return initMethod;
  }
  const method = requestRecord(input)?.method;
  if (typeof method === "string" && method.length > 0) {
    return method;
  }
  return "GET";
}

function requestHeaders(input: Parameters<FetchFn>[0]): unknown {
  return requestRecord(input)?.headers;
}

async function requestBody(
  input: Parameters<FetchFn>[0],
  init?: Parameters<FetchFn>[1],
): Promise<BodyInit | undefined> {
  const initBody = (init as { body?: unknown } | undefined)?.body;
  if (initBody !== undefined) {
    return initBody as BodyInit;
  }
  const record = requestRecord(input);
  if (record?.bodyUsed !== true && typeof record?.text === "function") {
    const text = await (record.text as (this: unknown) => Promise<unknown>).call(input);
    return typeof text === "string" && text.length > 0 ? text : undefined;
  }
  return undefined;
}

function appendProxyHeaders(
  target: { set(name: string, value: string): unknown },
  source: unknown,
): void {
  if (!source || typeof source !== "object") {
    return;
  }
  if (typeof (source as Headers).forEach === "function") {
    (source as Headers).forEach((value, key) => {
      target.set(key, value);
    });
    return;
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        target.set(entry[0], String(entry[1] ?? ""));
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      target.set(key, value);
    } else if (Array.isArray(value)) {
      target.set(key, value.map((item) => String(item)).join(", "));
    } else if (value !== undefined && value !== null) {
      target.set(key, String(value));
    }
  }
}

let installPromise: Promise<void> | null = null;
let undiciModulePromise: Promise<UndiciEgressModule> | null = null;
const proxyFetchByUrl = new Map<string, Promise<FetchFn>>();

/** Test hook: forgets any memoised install attempt. */
export function resetYouTubeEgress(): void {
  installPromise = null;
}

/** Test hook: forgets memoised undici/proxy-fetch state. */
export function resetProxyFetchCache(): void {
  undiciModulePromise = null;
  proxyFetchByUrl.clear();
}

async function loadUndici(): Promise<UndiciEgressModule> {
  // Dynamic so the default, proxy-less path never loads or bundles it.
  if (!undiciModulePromise) {
    undiciModulePromise = import("undici").then(
      (mod) => mod as unknown as UndiciEgressModule,
    ).catch((error: unknown) => {
      undiciModulePromise = null;
      throw error;
    });
  }
  return undiciModulePromise;
}

/**
 * Returns a memoised proxy-dispatched fetch for one proxy URL. One closure
 * per URL keeps repeated playback resolutions from rebuilding agents; a
 * failed build is not memoised, so the next attempt retries.
 */
export function proxyFetchFor(proxyUrl: string): Promise<FetchFn> {
  const pending = proxyFetchByUrl.get(proxyUrl);
  if (pending) {
    return pending;
  }
  const created = loadUndici()
    .then((undici) => createProxyFetch(proxyUrl, undici))
    .catch((error: unknown) => {
      if (proxyFetchByUrl.get(proxyUrl) === created) {
        proxyFetchByUrl.delete(proxyUrl);
      }
      throw error;
    });
  proxyFetchByUrl.set(proxyUrl, created);
  return created;
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
