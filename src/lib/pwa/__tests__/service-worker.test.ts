import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://127.0.0.1:3100";

interface FakeRequest {
  method: string;
  url: string;
  mode?: string;
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
    classifyRequest(request: FakeRequest): string;
    OFFLINE_TITLE: string;
    OFFLINE_BODY: string;
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
      return {
        match: async (request: FakeRequest) => store.get(request.url) ?? null,
        put: async (request: FakeRequest, response: FakeResponse) => {
          store.set(request.url, response);
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
  init: { method?: string; mode?: string } = {},
): FakeRequest {
  return { method: init.method ?? "GET", url, mode: init.mode };
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

describe("service worker versioning", () => {
  it("uses one bounded versioned cache name", () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    expect(harness.api.AURORA_SW_VERSION).toMatch(/^aurora-sw-v\d+$/);
    expect(harness.api.STATIC_CACHE).toContain(
      harness.api.AURORA_SW_VERSION,
    );
  });

  it("install skips waiting and activate cleans only old aurora caches", async () => {
    const harness = loadWorker(async () => new FakeResponse("x"));
    harness.cacheStores.set(harness.api.STATIC_CACHE, new Map());
    harness.cacheStores.set("aurora-old:static", new Map());
    harness.cacheStores.set("foreign-cache", new Map());

    await runEvent(harness, "install");
    expect(harness.skippedWaiting.called).toBe(true);

    await runEvent(harness, "activate");
    expect(harness.deletedCaches).toEqual(["aurora-old:static"]);
    expect(harness.cacheStores.has(harness.api.STATIC_CACHE)).toBe(true);
    expect(harness.cacheStores.has("foreign-cache")).toBe(true);
    expect(harness.claimed.called).toBe(true);
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
    expect(body).toContain(harness.api.OFFLINE_TITLE);
    expect(body).toContain(harness.api.OFFLINE_BODY);
    expect(body).not.toMatch(/googlevideo|http/i);
    expect(harness.cacheStores.size).toBe(0);
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
