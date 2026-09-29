import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "youtubei.js";

/**
 * The egress seam mutates youtubei.js's platform shim, so this file controls
 * both the environment and the `undici` module it would import. The global
 * `getEnv` is replaced with a holder so the test never depends on the shell's
 * `AURORA_YOUTUBE_EGRESS_PROXY`, and `undici` is replaced with a stub so the
 * enabled path can be exercised without opening a socket.
 */
const mocks = vi.hoisted(() => ({
  proxy: undefined as string | undefined,
  agentUrls: [] as string[],
}));

vi.mock("@/lib/config/env", () => ({
  getEnv: () => ({ AURORA_YOUTUBE_EGRESS_PROXY: mocks.proxy }),
}));

vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(url: string) {
      mocks.agentUrls.push(url);
    }
  },
  fetch: () => Promise.resolve({ ok: true }),
  Request,
  Headers,
}));

import {
  buildProxiedEgress,
  installYouTubeEgress,
  resetYouTubeEgress,
  type UndiciEgressModule,
} from "@/lib/providers/youtube/innertube/egress";

const ORIGINAL_SHIM = {
  fetch: Platform.shim.fetch,
  Request: Platform.shim.Request,
  Headers: Platform.shim.Headers,
};

afterEach(() => {
  Platform.shim.fetch = ORIGINAL_SHIM.fetch;
  Platform.shim.Request = ORIGINAL_SHIM.Request;
  Platform.shim.Headers = ORIGINAL_SHIM.Headers;
  mocks.proxy = undefined;
  mocks.agentUrls.length = 0;
  resetYouTubeEgress();
});

describe("buildProxiedEgress", () => {
  it("injects a dispatcher built from the proxy URL, without dropping the init", async () => {
    const calls: Array<{ input: unknown; init: Record<string, unknown> }> = [];
    class FakeAgent {
      constructor(readonly url: string) {}
    }
    const undici: UndiciEgressModule = {
      fetch: (async (input: unknown, init?: unknown) => {
        calls.push({ input, init: (init ?? {}) as Record<string, unknown> });
        return { ok: true } as unknown as Response;
      }) as unknown as typeof fetch,
      ProxyAgent: FakeAgent as unknown as UndiciEgressModule["ProxyAgent"],
      Request,
      Headers,
    };

    const egress = buildProxiedEgress("http://proxy.example:8080", undici);
    await egress.fetch("https://www.youtube.com/youtubei/v1/player", { method: "POST" });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://www.youtube.com/youtubei/v1/player");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.dispatcher).toBeInstanceOf(FakeAgent);
    expect((calls[0].init.dispatcher as FakeAgent).url).toBe("http://proxy.example:8080");
    // The whole triple comes from one undici, so Request/Headers stay coherent
    // with the fetch that receives them.
    expect(egress.Request).toBe(Request);
    expect(egress.Headers).toBe(Headers);
  });
});

describe("installYouTubeEgress", () => {
  it("touches nothing when no proxy is configured", async () => {
    await installYouTubeEgress();
    expect(Platform.shim.fetch).toBe(ORIGINAL_SHIM.fetch);
    expect(Platform.shim.Request).toBe(ORIGINAL_SHIM.Request);
    expect(Platform.shim.Headers).toBe(ORIGINAL_SHIM.Headers);
  });

  it("installs the proxied triple on the shim when a proxy is configured", async () => {
    mocks.proxy = "http://proxy.example:8080";
    await installYouTubeEgress();

    expect(mocks.agentUrls).toEqual(["http://proxy.example:8080"]);
    expect(Platform.shim.fetch).not.toBe(ORIGINAL_SHIM.fetch);
  });
});
