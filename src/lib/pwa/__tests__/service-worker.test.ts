import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ACTIVATE_MESSAGE, LOCALE_MESSAGE } from "@/lib/pwa/service-worker";

const ORIGIN = "http://127.0.0.1:3100";

interface FakeRequest {
  method: string;
  url: string;
  mode?: string;
  headers?: { get(name: string): string | null };
}

class FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly type: string;
  private readonly bodyText: string;
  private readonly headerMap: Map<string, string>;

  constructor(
    body: string,
    init: { status?: number; headers?: Record<string, string>; type?: string } = {},
  ) {
    this.bodyText = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = init.type ?? "basic";
    this.headerMap = new Map(
      Object.entries(init.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
  }

  get headers(): { get(name: string): string | null } {
    const map = this.headerMap;
    return {
      get(name: string): string | null {
        return map.get(name.toLowerCase()) ?? null;
      },
    };
  }

  async text(): Promise<string> {
    return this.bodyText;
  }

  clone(): FakeResponse {
    return new FakeResponse(this.bodyText, {
      status: this.status,
      headers: Object.fromEntries(this.headerMap),
      type: this.type,
    });
  }
}

interface WorkerHarness {
  api: {
    AURORA_SW_VERSION: string;
    STATIC_CACHE: string;
    META_CACHE: string;
    META_LOCALE_URL: string;
    ACTIVATE_MESSAGE: string;
    LOCALE_MESSAGE: string;
    DEFAULT_LOCALE: string;
    classifyRequest(request: FakeRequest): string;
    OFFLINE_COPY: Record<string, { lang: string; title: string; body: string }>;
    offlineCopy(locale: string): { lang: string; title: string; body: string };
    localeFromRequest(request: FakeRequest): string;
    normalizeLocale(value: unknown): string;
    rememberLocale(locale: string): Promise<void>;
    readRememberedLocale(): Promise<string | null>;
    resolveOfflineLocale(request: FakeRequest): Promise<string>;
    offlineHtml(locale: string): string;
    offlineFallbackResponse(locale: string): FakeResponse;
  };
  listeners: Map<string, Array<(event: never) => void>>;
  fetchCalls: string[];
  cacheStores: Map<string, Map<string, FakeResponse>>;
  openCalls: string[];
  skippedWaiting: { called: boolean };
  claimed: { called: boolean };
  deletedCaches: string[];
}

function loadWorker(
  fetchImpl: (url: string) => Promise<FakeResponse>,
): WorkerHarness {
  const code = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const listeners = new Map<string, Array<(event: never) => void>>();
  const fetchCalls: string[] = [];
  const cacheStores = new Map<string, Map<string, FakeResponse>>();
  const openCalls: string[] = [];
  const skippedWaiting = { called: false };
  const claimed = { called: false };
  const deletedCaches: string[] = [];

  const selfStub = {
    location: { origin: ORIGIN },
    skipWaiting: async () => {
      skippedWaiting.called = true;
    },
    clients: {
      claim: async () => {
        claimed.called = true;
      },
    },
    addEventListener: (type: string, handler: (event: never) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
  };
  const cachesStub = {
    open: async (name: string) => {
      openCalls.push(name);
      if (!cacheStores.has(name)) {
        cacheStores.set(name, new Map());
      }
      const store = cacheStores.get(name) as Map<string, FakeResponse>;
      // Cache Storage accepts a string URL as readily as a Request, and the
      // worker uses the string form for its meta entry so it does not depend on
      // a `Request` global being in scope inside the evaluated file. Keyed
      // either way, so both spellings behave the same here.
      const keyOf = (input: FakeRequest | string): string =>
        typeof input === "string" ? input : input.url;
      return {
        match: async (input: FakeRequest | string) => store.get(keyOf(input)) ?? null,
        put: async (input: FakeRequest | string, response: FakeResponse) => {
          store.set(keyOf(input), response);
        },
      };
    },
    keys: async () => [...cacheStores.keys()],
    delete: async (name: string) => {
      deletedCaches.push(name);
      return cacheStores.delete(name);
    },
  };
  const fetchStub = (input: FakeRequest | string): Promise<FakeResponse> => {
    const url = typeof input === "string" ? input : input.url;
    fetchCalls.push(url);
    return fetchImpl(url);
  };

  const factory = new Function(
    "self",
    "caches",
    "fetch",
    "Response",
    "URL",
    code,
  );
  factory(selfStub, cachesStub, fetchStub, FakeResponse, URL);
  return {
    api: (selfStub as unknown as { __auroraSW: WorkerHarness["api"] })
      .__auroraSW,
    listeners,
    fetchCalls,
    cacheStores,
    openCalls,
    skippedWaiting,
    claimed,
    deletedCaches,
  };
}

function request(
  url: string,
  init: { method?: string; mode?: string; cookie?: string } = {},
): FakeRequest {
  const req: FakeRequest = {
    method: init.method ?? "GET",
    url,
    mode: init.mode,
  };
  if (init.cookie !== undefined) {
    req.headers = {
      get: (name: string) => (name.toLowerCase() === "cookie" ? init.cookie ?? null : null),
    };
  }
  return req;
}

async function runFetch(
  harness: WorkerHarness,
  req: FakeRequest,
): Promise<FakeResponse | null> {
  const handlers = harness.listeners.get("fetch") ?? [];
  let promised: Promise<FakeResponse> | null = null;
  const event = {
    request: req,
    respondWith: (promise: Promise<FakeResponse>) => {
      promised = promise;
    },
  };
  for (const handler of handlers) {
    handler(event as never);
  }
  return promised;
}

async function runEvent(
  harness: WorkerHarness,
  type: "install" | "activate",
): Promise<void> {
  const handlers = harness.listeners.get(type) ?? [];
  const pending: Array<Promise<unknown>> = [];
  for (const handler of handlers) {
    handler({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never);
  }
  await Promise.all(pending);
}

async function runMessage(
  harness: WorkerHarness,
  data: unknown,
): Promise<void> {
  const handlers = harness.listeners.get("message") ?? [];
  const pending: Array<Promise<unknown>> = [];
  for (const handler of handlers) {
    handler({
      data,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as never);
  }
  await Promise.all(pending);
}

/**
 * Total responses held across every cache the worker has opened.
 *
 * The invariant the worker cares about is "nothing is stored", not "no cache
 * was opened": `caches.open` on a name that does not exist yet creates it. So
 * counting stores would conflate "resolved a setting" with "cached a document",
 * and would start failing for a change that caches nothing at all.
 */
function storedResponseCount(harness: WorkerHarness): number {
  let total = 0;
  for (const store of harness.cacheStores.values()) {
    total += store.size;
  }
  return total;
}

describe("service worker versioning", () => {
  it("uses one bounded versioned cache name", () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(harness.api.AURORA_SW_VERSION).toMatch(/^aurora-sw-v\d+$/);
    expect(harness.api.STATIC_CACHE).toContain(
      harness.api.AURORA_SW_VERSION,
    );
  });

  it("install does not take over, and activate cleans only old aurora caches", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    harness.cacheStores.set(harness.api.STATIC_CACHE, new Map());
    harness.cacheStores.set("aurora-old:static", new Map());
    harness.cacheStores.set("foreign-cache", new Map());

    // RULE 37: install must NOT skip waiting. Taking control mid-session
    // re-parents a running page onto a new build, and Aurora's session must
    // survive a deploy.
    await runEvent(harness, "install");
    expect(harness.skippedWaiting.called).toBe(false);

    await runEvent(harness, "activate");
    expect(harness.deletedCaches).toEqual(["aurora-old:static"]);
    expect(harness.cacheStores.has(harness.api.STATIC_CACHE)).toBe(true);
    expect(harness.cacheStores.has("foreign-cache")).toBe(true);
    expect(harness.claimed.called).toBe(true);
  });

  it("activates only when the page explicitly hands over control", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));

    await runEvent(harness, "install");
    expect(harness.skippedWaiting.called).toBe(false);

    // An unrelated message must not trigger a takeover.
    await runMessage(harness, { type: "something-else" });
    expect(harness.skippedWaiting.called).toBe(false);

    await runMessage(harness, { type: harness.api.ACTIVATE_MESSAGE });
    expect(harness.skippedWaiting.called).toBe(true);
  });

  it("uses the same activation message the page sends", async () => {
    // The worker is a plain static file and cannot import the page module, so
    // the literal is duplicated. This pins the two together: a rename on one
    // side would otherwise leave every update parked forever, silently.
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(harness.api.ACTIVATE_MESSAGE).toBe(ACTIVATE_MESSAGE);
    expect(harness.api.ACTIVATE_MESSAGE).toBe("aurora:activate");
  });

  it("uses the same locale message the page sends", () => {
    // Same reasoning as above, and the same failure mode if it drifts: the
    // offline page would silently revert to the shipped default in every
    // browser, which is the bug this replaced.
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(harness.api.LOCALE_MESSAGE).toBe(LOCALE_MESSAGE);
    expect(harness.api.LOCALE_MESSAGE).toBe("aurora:locale");
  });
});

describe("service worker offline locale, as the page tells it", () => {
  it("remembers what the page announced and reads it back", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(await harness.api.readRememberedLocale()).toBeNull();
    await harness.api.rememberLocale("en");
    expect(await harness.api.readRememberedLocale()).toBe("en");
    // A switch back is announced too, and must overwrite rather than append.
    await harness.api.rememberLocale("vi");
    expect(await harness.api.readRememberedLocale()).toBe("vi");
  });

  it("normalises whatever the page announces", async () => {
    // The page is the only source, so it is also untrusted input as far as the
    // worker is concerned: anything that is not a supported locale becomes the
    // shipped default rather than reaching `offlineCopy`.
    const harness = loadWorker(async () => new FakeResponse("x"));
    for (const value of ["xx", "", "en-US", "VI", null, undefined, 7, {}]) {
      expect(harness.api.normalizeLocale(value)).toBe(
        harness.api.DEFAULT_LOCALE,
      );
    }
    expect(harness.api.normalizeLocale("en")).toBe("en");
  });

  it("prefers what the page said over the cookie on the request", async () => {
    // The measured Chromium behaviour: the navigation `Request` a worker
    // receives has no `cookie` header, so the cookie path cannot be the primary
    // source. It is still consulted when nothing has been announced, which is
    // the case on browsers that do expose the header.
    const harness = loadWorker(async () => new FakeResponse("x"));
    await harness.api.rememberLocale("en");
    // Request says Vietnamese, the page says English: the page is right,
    // because the page is what the visitor actually chose.
    expect(
      await harness.api.resolveOfflineLocale(
        request("/", { cookie: "aurora-locale=vi" }),
      ),
    ).toBe("en");
  });

  it("falls back to the request cookie before the shipped default", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(
      await harness.api.resolveOfflineLocale(
        request("/", { cookie: "aurora-locale=en" }),
      ),
    ).toBe("en");
    // Nothing remembered and no cookie: the shipped default, never English.
    expect(await harness.api.resolveOfflineLocale(request("/"))).toBe(
      harness.api.DEFAULT_LOCALE,
    );
  });

  it("stores the announced locale and never any document", async () => {
    // The one thing the meta store is allowed to hold is a two-letter locale.
    const harness = loadWorker(async () => {
      throw new Error("offline");
    });
    await runMessage(harness, { type: harness.api.LOCALE_MESSAGE, locale: "en" });
    await runFetch(
      harness,
      request(`${ORIGIN}/library`, { mode: "navigate" }),
    );
    expect(storedResponseCount(harness)).toBe(1);
    const stored = harness.cacheStores
      .get(harness.api.META_CACHE)
      ?.get(harness.api.META_LOCALE_URL);
    expect(await stored?.text()).toBe("en");
  });

  it("persists the locale when the page posts it", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    await runMessage(harness, { type: harness.api.LOCALE_MESSAGE, locale: "en" });
    expect(await harness.api.readRememberedLocale()).toBe("en");
    // The store is a separate cache from static assets, so announcing a
    // language can never evict a hashed chunk.
    expect(harness.openCalls).toContain(harness.api.META_CACHE);
    expect(harness.api.META_CACHE).not.toBe(harness.api.STATIC_CACHE);
  });
});

describe("service worker offline fallback", () => {
  it("reads the visitor's locale off the navigation request", () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(harness.api.localeFromRequest(request("/"))).toBe(
      harness.api.DEFAULT_LOCALE,
    );
    expect(
      harness.api.localeFromRequest(
        request("/", { cookie: "aurora-locale=en; other=1" }),
      ),
    ).toBe("en");
    expect(
      harness.api.localeFromRequest(
        request("/", { cookie: "other=1; aurora-locale=vi" }),
      ),
    ).toBe("vi");
  });

  it("falls back to the shipped default for unknown or broken values", () => {
    // RULE 47: a Vietnamese default-locale user is never shown English.
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(
      harness.api.localeFromRequest(request("/", { cookie: "aurora-locale=xx" })),
    ).toBe(harness.api.DEFAULT_LOCALE);
    expect(harness.api.offlineCopy("xx")).toEqual(
      harness.api.OFFLINE_COPY[harness.api.DEFAULT_LOCALE],
    );
  });

  it("renders the offline page in the visitor's language", () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    const vi = harness.api.offlineHtml("vi");
    const en = harness.api.offlineHtml("en");
    expect(vi).toContain('lang="vi"');
    expect(en).toContain('lang="en"');
    expect(vi).toContain(harness.api.OFFLINE_COPY.vi.title);
    expect(en).toContain(harness.api.OFFLINE_COPY.en.title);
    // The page is a shell notice, never a cached copy of a real page.
    expect(vi).not.toMatch(/googlevideo/i);
  });
});

describe("service worker request classification", () => {
  function classify(url: string, init: { method?: string; mode?: string } = {}) {
    const harness = loadWorker(async () => new FakeResponse("x"));
    return harness.api.classifyRequest(request(url, init));
  }

  it("never intercepts playback, provider, api, or write traffic", () => {
    expect(
      classify("https://rr1---sn.googlevideo.com/videoplayback?expire=1"),
    ).toBe("passthrough");
    expect(classify("https://lh3.googleusercontent.com/x")).toBe("passthrough");
    expect(classify("https://api.spotify.com/v1/x")).toBe("passthrough");
    expect(classify(`${ORIGIN}/api/auth/session`)).toBe("passthrough");
    expect(classify(`${ORIGIN}/`, { method: "POST" })).toBe("passthrough");
    expect(classify(`not a url`)).toBe("passthrough");
  });

  it("routes immutable static assets and navigations explicitly", () => {
    expect(classify(`${ORIGIN}/_next/static/chunk-abc.js`)).toBe("static");
    expect(classify(`${ORIGIN}/`, { mode: "navigate" })).toBe("navigation");
    expect(classify(`${ORIGIN}/search`, { mode: "navigate" })).toBe("navigation");
  });

  it("keeps same-origin dynamic requests on the network by default", () => {
    expect(classify(`${ORIGIN}/icons/icon-192.png`)).toBe("passthrough");
    expect(classify(`${ORIGIN}/track/xyz`)).toBe("passthrough");
  });
});

describe("service worker fetch behavior", () => {
  it("caches versioned static assets and serves them without refetch", async () => {
    const harness = loadWorker(
      async () => new FakeResponse("js", { type: "basic" }),
    );
    const url = `${ORIGIN}/_next/static/chunk.js`;
    const first = await runFetch(harness, request(url));
    expect(await first?.text()).toBe("js");
    const second = await runFetch(harness, request(url));
    expect(await second?.text()).toBe("js");
    expect(harness.fetchCalls).toEqual([url]);
    // caches.open is idempotent per request; only the versioned cache
    // is ever opened.
    expect(harness.openCalls.length).toBeGreaterThan(0);
    for (const name of harness.openCalls) {
      expect(name).toBe(harness.api.STATIC_CACHE);
    }
  });

  it("never stores error responses", async () => {
    const harness = loadWorker(
      async () => new FakeResponse("nope", { status: 500, type: "basic" }),
    );
    const response = await runFetch(
      harness,
      request(`${ORIGIN}/_next/static/chunk.js`),
    );
    expect(response?.status).toBe(500);
    expect(harness.cacheStores.get(harness.api.STATIC_CACHE)?.size ?? 0).toBe(0);
  });

  it("serves navigations from the network and caches nothing", async () => {
    const harness = loadWorker(async () => new FakeResponse("<html/>"));
    const response = await runFetch(
      harness,
      request(`${ORIGIN}/search`, { mode: "navigate" }),
    );
    expect(await response?.text()).toBe("<html/>");
    expect(harness.cacheStores.size).toBe(0);
  });

  it("serves the built-in offline fallback when navigations fail", async () => {
    const harness = loadWorker(async () => {
      throw new Error("offline");
    });
    const response = await runFetch(
      harness,
      request(`${ORIGIN}/library`, { mode: "navigate" }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const body = (await response?.text()) ?? "";
    // Nothing announced and no cookie: the shipped Vietnamese default.
    expect(body).toContain(harness.api.OFFLINE_COPY[harness.api.DEFAULT_LOCALE].title);
    expect(body).toContain(harness.api.OFFLINE_COPY[harness.api.DEFAULT_LOCALE].body);
    expect(body).not.toMatch(/googlevideo|http/i);
    // NO HTML IS CACHED, so a personalized page can never leak across users or
    // sessions. Asserting on the number of cache NAMES would be the wrong
    // assertion now: resolving the locale opens the meta store (creating an
    // empty one) without storing anything in it. The invariant is that no
    // store holds a response.
    expect(storedResponseCount(harness)).toBe(0);
  });

  it("serves the offline fallback in the visitor's language", async () => {
    const harness = loadWorker(async () => {
      throw new Error("offline");
    });
    const response = await runFetch(
      harness,
      request(`${ORIGIN}/library`, { mode: "navigate", cookie: "aurora-locale=en" }),
    );
    const body = (await response?.text()) ?? "";
    expect(body).toContain(harness.api.OFFLINE_COPY.en.title);
    expect(body).not.toContain(harness.api.OFFLINE_COPY.vi.title);
  });

  it("never puts playback, api, or write traffic into any cache", async () => {
    const harness = loadWorker(
      async () => new FakeResponse("data", { type: "basic" }),
    );
    await runFetch(
      harness,
      request("https://rr1---sn.googlevideo.com/videoplayback?expire=1"),
    );
    await runFetch(harness, request(`${ORIGIN}/api/auth/session`));
    await runFetch(harness, request(`${ORIGIN}/`, { method: "POST" }));
    expect(harness.openCalls).toEqual([]);
    expect(harness.cacheStores.size).toBe(0);
    // Passthrough means the worker never touches fetch itself: the
    // browser handles playback, provider, API, and POST traffic natively.
    expect(harness.fetchCalls).toHaveLength(0);
  });
});
