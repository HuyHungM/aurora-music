import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ExtractorError } from "@/lib/domain";
import {
  createTieredTransport,
  decideSearchSource,
} from "@/lib/providers/youtube/tiered-transport";
import { InnerTubeUnavailableError } from "@/lib/providers/youtube/innertube/transport";
import {
  resetYouTubeMetrics,
  snapshotYouTubeMetrics,
} from "@/lib/providers/youtube/innertube/metrics";
import type {
  YouTubeApiTransport,
  YouTubeChannelListResponse,
  YouTubePlaylist,
  YouTubePlaylistItemsResponse,
  YouTubeSearchResponse,
  YouTubeVideoListResponse,
} from "@/lib/providers/youtube/types";

/**
 * The quota decisions, tested in isolation from any network.
 *
 * These tests are the evidence for the phase's central claim: on the happy
 * path the official `search.list` is never called, and when the primary source
 * is broken the official API is called exactly once — never both.
 */

const VIDEO = "dQw4w9WgXcQ";

function videoItem(videoId: string, title = "Lạc Trôi"): unknown {
  return { id: { videoId }, snippet: { title, liveBroadcastContent: "none" } };
}

function response(count: number): YouTubeSearchResponse {
  return {
    items: Array.from({ length: count }, (_, index) => videoItem(`${VIDEO.slice(0, 8)}${index}`)),
  };
}

/**
 * A transport that records what it was asked and answers from a script.
 *
 * The spy handles live on a separate `mocks` field rather than being reached
 * through the transport. `YouTubeApiTransport` declares plain methods, so
 * `transport.searchVideos.mockResolvedValue` does not typecheck — and routing
 * it through a named field also stops a test from silently mutating the wrong
 * mock when the names are near-identical.
 */
interface FakeTransport extends YouTubeApiTransport {
  /** Ordered `operation:argument` log. The quota assertions read this. */
  calls: string[];
  mocks: {
    searchVideos: Mock<(query: string) => Promise<YouTubeSearchResponse>>;
    searchChannels: Mock<(query: string) => Promise<YouTubeSearchResponse>>;
    searchChannelVideos: Mock<(id: string) => Promise<YouTubeSearchResponse>>;
    getVideos: Mock<(ids: string[]) => Promise<YouTubeVideoListResponse>>;
    getChannels: Mock<(ids: string[]) => Promise<YouTubeChannelListResponse>>;
    getPlaylist: Mock<(id: string) => Promise<YouTubePlaylist | null>>;
    getPlaylistItems: Mock<(id: string) => Promise<YouTubePlaylistItemsResponse>>;
  };
}

function fakeTransport(
  answers: Partial<Record<keyof YouTubeApiTransport, () => Promise<unknown>>>,
): FakeTransport {
  const calls: string[] = [];
  const searchVideos = vi.fn(async (query: string) => {
    calls.push(`searchVideos:${query}`);
    return (answers.searchVideos?.() ?? response(3)) as YouTubeSearchResponse;
  });
  const searchChannels = vi.fn(async (query: string) => {
    calls.push(`searchChannels:${query}`);
    return (answers.searchChannels?.() ?? response(2)) as YouTubeSearchResponse;
  });
  const searchChannelVideos = vi.fn(async (id: string) => {
    calls.push(`searchChannelVideos:${id}`);
    return (answers.searchChannelVideos?.() ?? response(1)) as YouTubeSearchResponse;
  });
  const getVideos = vi.fn(async (ids: string[]) => {
    calls.push(`getVideos:${ids.join(",")}`);
    return (answers.getVideos?.() ?? {
      items: ids.map((id) => ({ id, snippet: { title: id, liveBroadcastContent: "none" } })),
    }) as YouTubeVideoListResponse;
  });
  const getChannels = vi.fn(async (ids: string[]) => {
    calls.push(`getChannels:${ids.join(",")}`);
    return (answers.getChannels?.() ?? { items: [] }) as YouTubeChannelListResponse;
  });
  const getPlaylist = vi.fn(async (id: string) => {
    calls.push(`getPlaylist:${id}`);
    return (answers.getPlaylist?.() ?? null) as YouTubePlaylist | null;
  });
  const getPlaylistItems = vi.fn(async (id: string) => {
    calls.push(`getPlaylistItems:${id}`);
    return (answers.getPlaylistItems?.() ?? { items: [] }) as YouTubePlaylistItemsResponse;
  });
  return {
    calls,
    searchVideos,
    searchChannels,
    searchChannelVideos,
    getVideos,
    getChannels,
    getPlaylist,
    getPlaylistItems,
    mocks: {
      searchVideos,
      searchChannels,
      searchChannelVideos,
      getVideos,
      getChannels,
      getPlaylist,
      getPlaylistItems,
    },
  };
}

function unavailable(): () => Promise<never> {
  return () => Promise.reject(new InnerTubeUnavailableError("searchVideos", "simulated"));
}

beforeEach(() => {
  resetYouTubeMetrics();
});

describe("the quality gate is a pure, deterministic function", () => {
  it("trusts InnerTube when the leading items carry ids", () => {
    const decision = decideSearchSource(response(5));
    expect(decision).toEqual({ source: "innertube", confidence: 1, items: 5 });
  });

  it("never trusts an EMPTY result as proof that nothing exists", () => {
    // The asymmetry that makes the phase safe. A YouTube markup change turns
    // every row into an unparseable node, and from inside the transport that
    // is indistinguishable from a genuinely empty result. One of those is a
    // bug, so emptiness routes to the official API.
    expect(decideSearchSource({ items: [] })).toEqual({
      source: "data-api",
      reason: "innertube-returned-no-items",
    });
    expect(decideSearchSource({})).toEqual({
      source: "data-api",
      reason: "innertube-returned-no-items",
    });
  });

  it("rejects a result whose items have no identity at all", () => {
    expect(
      decideSearchSource({ items: [{ snippet: { title: "x" } }, { snippet: {} }] }),
    ).toEqual({ source: "data-api", reason: "innertube-items-had-no-identity" });
  });

  it("accepts a partially-identified result and reports the confidence", () => {
    // Better to use a partial InnerTube result than to spend a `search.list`
    // call on a query that mostly answered.
    const decision = decideSearchSource({
      items: [videoItem(VIDEO), { snippet: { title: "no id" } }, { snippet: {} }],
    });
    expect(decision).toEqual({ source: "innertube", confidence: 0.33, items: 3 });
  });

  it("is stable across repeated calls with the same input", () => {
    const input = { items: [] as unknown[] };
    expect(decideSearchSource(input)).toEqual(decideSearchSource(input));
  });
});

describe("InnerTube is the primary source", () => {
  it("never calls the official API on the happy path", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    const transport = createTieredTransport({ primary, fallback });

    await transport.searchVideos("son tung", { limit: 10 });
    await transport.searchChannels("son tung", { limit: 10 });
    await transport.searchChannelVideos("UCabc", { limit: 10 });
    await transport.getVideos([VIDEO]);

    // The whole point of the phase: `search.list` is not reached.
    expect(fallback.calls).toEqual([]);
    expect(primary.calls).toHaveLength(4);
  });

  it("records the source split so the saving is measurable", async () => {
    // The work has to happen inside this test: the counters are process-wide
    // and reset by `beforeEach`, so asserting on a previous test's traffic
    // would be asserting on test order.
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    const transport = createTieredTransport({ primary, fallback });
    await transport.searchVideos("a");
    await transport.searchVideos("b");

    const snapshot = snapshotYouTubeMetrics();
    expect(snapshot.counters["search.innertube"]).toBe(2);
    expect(snapshot.counters["search.data_api"]).toBeUndefined();
    expect(snapshot.ratios.dataApiFallbackRate).toBe(0);
    expect(snapshot.ratios.innertubeShareOfSearch).toBe(1);
  });

  it("does not call BOTH sources for one search", async () => {
    // §10. Calling both to "compare quality" would spend the quota this phase
    // exists to save, and merging two ranked lists produces a worse list.
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    await createTieredTransport({ primary, fallback }).searchVideos("son tung");
    expect(fallback.calls).toHaveLength(0);
  });
});

describe("fallback to the official API", () => {
  it("falls back when the primary source is unavailable", async () => {
    const primary = fakeTransport({ searchVideos: unavailable() });
    const fallback = fakeTransport({});
    const result = await createTieredTransport({ primary, fallback }).searchVideos("x");
    expect(result.items).toHaveLength(3);
    expect(fallback.calls).toEqual(["searchVideos:x"]);
  });

  it("falls back when the primary source returns nothing parseable", async () => {
    const primary = fakeTransport({ searchVideos: async () => ({ items: [] }) });
    const fallback = fakeTransport({});
    const result = await createTieredTransport({ primary, fallback }).searchVideos("x");
    expect(result.items).toHaveLength(3);
    expect(fallback.calls).toEqual(["searchVideos:x"]);
  });

  it("prefers the official result outright rather than merging", async () => {
    const primary = fakeTransport({ searchVideos: async () => ({ items: [] }) });
    const fallback = fakeTransport({
      searchVideos: async () => ({
        items: [
          { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "official", liveBroadcastContent: "none" } },
        ],
      }),
    });
    const result = await createTieredTransport({ primary, fallback }).searchVideos("x");
    // The official answer, not a union of the two.
    expect(result.items).toHaveLength(1);
    const first = (result.items as Array<{ snippet: { title: string } }>)[0];
    expect(first?.snippet.title).toBe("official");
  });

  it("surfaces a programming error instead of hiding it behind the fallback", async () => {
    // A bug in the primary path that fell back silently would be permanently
    // unfixable: the fallback always works, so nothing would ever look broken.
    const primary = fakeTransport({
      searchVideos: () => Promise.reject(new TypeError("undefined is not a function")),
    });
    const fallback = fakeTransport({});
    await expect(
      createTieredTransport({ primary, fallback }).searchVideos("x"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fallback.calls).toEqual([]);
  });
});

describe("quota exhaustion (§66, §70)", () => {
  it("serves the untrusted primary result when the official API is paused", async () => {
    // Better than an error page: what the primary parsed is genuinely
    // playable, it is just less complete than usual.
    const primary = fakeTransport({ searchVideos: async () => ({ items: [] }) });
    const fallback = fakeTransport({});
    const transport = createTieredTransport({
      primary,
      fallback,
      isFallbackOpen: () => true,
    });
    const result = await transport.searchVideos("x");
    expect(result.items).toEqual([]);
    expect(fallback.calls).toEqual([]);
  });

  it("fails with a typed error when the official API is paused AND the primary is down", () => {
    const primary = fakeTransport({ searchVideos: unavailable() });
    const fallback = fakeTransport({});
    const transport = createTieredTransport({
      primary,
      fallback,
      isFallbackOpen: () => true,
    });
    // Not an empty result and not a raw provider error: a typed, non-retryable
    // engine error the UI can report.
    return expect(transport.searchVideos("x")).rejects.toBeInstanceOf(ExtractorError);
  });

  it("returns to the primary source once quota recovers, without a restart", async () => {
    // §65: a fallback must not be sticky. If one bad hour permanently moved
    // Aurora onto the official API, the quota saving would be lost forever.
    // Three phases: primary down (the official API pays), quota gone (the
    // primary pays), quota back (the primary pays). The official API is called
    // exactly once across all three.
    let open = false;
    const primary = fakeTransport({ searchVideos: unavailable() });
    const fallback = fakeTransport({});
    const transport = createTieredTransport({
      primary,
      fallback,
      isFallbackOpen: () => open,
    });

    // Phase 1: the primary is broken, the official API has budget.
    const viaApi = await transport.searchVideos("x");
    expect(viaApi.items).toHaveLength(3);
    expect(fallback.calls).toHaveLength(1);

    // Phase 2: the primary recovers AND the official quota is gone.
    open = true;
    primary.mocks.searchVideos.mockResolvedValue(response(4));
    const viaPrimary = await transport.searchVideos("x");
    expect(viaPrimary.items).toHaveLength(4);
    expect(fallback.calls).toHaveLength(1);

    // Phase 3: quota is back and the primary is still fine.
    open = false;
    await transport.searchVideos("x");
    expect(fallback.calls).toHaveLength(1);
  });

  it("reports channel metadata as unavailable rather than faking an empty channel", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    const transport = createTieredTransport({
      primary,
      fallback,
      isFallbackOpen: () => true,
    });
    // An empty Artist would render as "Unknown artist" — a silent wrong
    // answer. A typed error renders as a provider failure, which is true.
    await expect(transport.getChannels(["UCabc"])).rejects.toBeInstanceOf(ExtractorError);
    expect(fallback.calls).toEqual([]);
  });
});

describe("operations the official API owns", () => {
  it("never asks the primary for channels or playlists", async () => {
    // §35 classification. The primary transport throws for these; the point is
    // that the tiered transport does not call it at all.
    const primary = fakeTransport({});
    const fallback = fakeTransport({
      getChannels: async () => ({ items: [{ id: "UCabc" }] }),
      getPlaylist: async () => ({ id: "PL1", snippet: { title: "Mix" } }),
      getPlaylistItems: async () => ({ items: [], pageInfo: { totalResults: 0 } }),
    });
    const transport = createTieredTransport({ primary, fallback });

    await transport.getChannels(["UCabc"]);
    await transport.getPlaylist("PL1");
    await transport.getPlaylistItems("PL1");

    expect(primary.calls).toEqual([]);
    expect(fallback.calls).toEqual([
      "getChannels:UCabc",
      "getPlaylist:PL1",
      "getPlaylistItems:PL1",
    ]);
  });

  it("caches channel metadata, so an artist page does not re-bill every load", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({ getChannels: async () => ({ items: [{ id: "UCabc" }] }) });
    const transport = createTieredTransport({ primary, fallback });
    await transport.getChannels(["UCabc"]);
    await transport.getChannels(["UCabc"]);
    await transport.getChannels(["UCabc"]);
    expect(fallback.calls).toHaveLength(1);
  });

  it("caches a missing playlist as a negative entry", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({ getPlaylist: async () => null });
    const transport = createTieredTransport({ primary, fallback });
    await transport.getPlaylist("PLmissing");
    await transport.getPlaylist("PLmissing");
    // Re-asking for a playlist that does not exist on every page load is the
    // same waste as re-running a no-result search.
    expect(fallback.calls).toHaveLength(1);
  });
});

describe("video metadata caching is per id, not per batch (§26)", () => {
  it("does not refetch ids a previous batch already resolved", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    const transport = createTieredTransport({ primary, fallback });

    await transport.getVideos(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    await transport.getVideos(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);

    // The third id is new; the first two are shared. A per-batch key would
    // have refetched all three.
    expect(primary.calls).toEqual([
      "getVideos:aaaaaaaaaaa,bbbbbbbbbbb",
      "getVideos:ccccccccccc",
    ]);
  });

  it("preserves the caller's order", async () => {
    const primary = fakeTransport({});
    const fallback = fakeTransport({});
    const transport = createTieredTransport({ primary, fallback });
    const result = await transport.getVideos(["ccccccccccc", "aaaaaaaaaaa"]);
    expect((result.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
      "ccccccccccc",
      "aaaaaaaaaaa",
    ]);
  });

  it("drops ids no source could resolve instead of inventing an entry", async () => {
    const primary = fakeTransport({ getVideos: async () => ({ items: [], pageInfo: {} }) });
    const fallback = fakeTransport({});
    const result = await createTieredTransport({ primary, fallback }).getVideos([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
    // A deleted or private video simply is not in the response. Padding it
    // would produce a Track with a fabricated title.
    expect(result.items).toEqual([]);
  });

  it("falls back for metadata when the primary source is down", async () => {
    const primary = fakeTransport({
      getVideos: () => Promise.reject(new InnerTubeUnavailableError("getVideos", "down")),
    });
    const fallback = fakeTransport({});
    const result = await createTieredTransport({ primary, fallback }).getVideos([VIDEO]);
    expect(result.items).toHaveLength(1);
    expect(fallback.calls).toEqual([`getVideos:${VIDEO}`]);
  });
});

describe("metrics", () => {
  it("counts the fallback distinctly from the success", async () => {
    const primary = fakeTransport({ searchVideos: unavailable() });
    const fallback = fakeTransport({});
    const working = fakeTransport({});
    await createTieredTransport({ primary, fallback }).searchVideos("x");
    await createTieredTransport({ primary: working, fallback }).searchVideos("y");

    const snapshot = snapshotYouTubeMetrics();
    expect(snapshot.counters["search.data_api"]).toBe(1);
    expect(snapshot.counters["search.innertube"]).toBe(1);
    expect(snapshot.ratios.dataApiFallbackRate).toBe(0.5);
  });
});
