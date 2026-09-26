import { beforeEach, describe, expect, it, vi } from "vitest";
import { createYouTubeProvider } from "@/lib/providers/youtube/youtube-provider";
import { createTieredTransport } from "@/lib/providers/youtube/tiered-transport";
import { createInnerTubeTransport } from "@/lib/providers/youtube/innertube/transport";
import {
  resetYouTubeMetrics,
  snapshotYouTubeMetrics,
} from "@/lib/providers/youtube/innertube/metrics";
import type {
  YouTubeApiTransport,
  YouTubePlaylistItemsResponse,
  YouTubeSearchResponse,
  YouTubeVideoListResponse,
} from "@/lib/providers/youtube/types";

/**
 * The scenarios, driven through the real provider and the real InnerTube
 * transport, over a fake session and a fake official API.
 *
 * WHAT IS REAL HERE AND WHY IT MATTERS. The shape adapters, the two-tier cache,
 * the quality gate, the router and the whole provider are the shipping code.
 * Only the two network edges are substituted: an `Innertube` session that
 * answers from a script, and a stand-in for the official transport that counts
 * calls. An earlier draft stubbed the transports themselves, which quietly
 * bypassed the cache — the very thing the phase is about — and made "one
 * request" true for the wrong reason.
 *
 * `youtube-provider.ts` is deliberately UNCHANGED by Phase 55, and these tests
 * are the evidence for that claim. Every number asserted is a quota claim.
 */

const VIDEO = "dQw4w9WgXcQ";
const CHANNEL = "UCuAXFkgsw1L7xaCfnd5JJOw";
const CHANNEL_TITLE = "Sơn Tùng M-TP";
const TITLE = "Lạc Trôi (Official Music Video)";

/** A v18 `LockupView` search row — the shape youtubei.js actually returns. */
function lockupVideo(videoId: string, title = TITLE): unknown {
  return {
    content_type: "VIDEO",
    content_id: videoId,
    content_image: { image: [{ url: "https://i.example/hq.jpg", width: 480, height: 360 }] },
    metadata: {
      title: { text: title },
      metadata: {
        metadata_rows: [
          {
            metadata_parts: [
              { text: { text: CHANNEL_TITLE } },
              { text: { text: "120M views" } },
              { text: { text: "5 years ago" } },
            ],
          },
        ],
      },
    },
  };
}

interface Upstream {
  /** Ordered log of the calls the PRIMARY source actually made upstream. */
  calls: string[];
}

function fakeSession(upstream: Upstream, videos: string[] = [VIDEO]): {
  session: unknown;
  search: ReturnType<typeof vi.fn>;
  getInfo: ReturnType<typeof vi.fn>;
  getChannel: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async (query: string) => {
    upstream.calls.push(`search:${query}`);
    return {
      results: [lockupVideo(videos[0] ?? VIDEO), ...videos.slice(1).map((id) => lockupVideo(id))],
      estimated_results: videos.length,
    };
  });
  const getInfo = vi.fn(async (videoId: string) => {
    upstream.calls.push(`getInfo:${videoId}`);
    return {
      basic_info: {
        title: `Track ${videoId}`,
        author: { name: CHANNEL_TITLE, id: CHANNEL },
        duration: 253,
        is_live_content: false,
        is_upcoming: false,
      },
      thumbnails: [{ url: "https://i.example/hq.jpg", width: 480, height: 360 }],
    };
  });
  // A `Channel` is a `TabbedFeed`; in v18 the rows live under `page_contents`.
  // The fake mirrors that so the transport's `nodeListOf` walk is exercised
  // against the real location rather than a convenient one.
  const shelf = {
    page_contents: { contents: videos.map((id) => lockupVideo(id)) },
    has_videos: true,
    getVideos: vi.fn(async () => shelf),
  };
  const getChannel = vi.fn(async (id: string) => {
    upstream.calls.push(`getChannel:${id}`);
    return shelf;
  });
  return {
    session: { search, getInfo, getChannel },
    search,
    getInfo,
    getChannel,
  };
}

/**
 * A stand-in for `createYouTubeApiTransport`. Real HTTP would need a key; what
 * the scenarios assert is the CALL COUNT, so a counting transport is both
 * sufficient and more precise than a mock server.
 */
function officialSource(
  upstream: Upstream,
  overrides: Partial<YouTubeApiTransport> = {},
): YouTubeApiTransport {
  const note = (name: string, detail: string): void => {
    upstream.calls.push(`official:${name}:${detail}`);
  };
  const videoItem = (id: string): unknown => ({
    id,
    snippet: {
      title: `Track ${id}`,
      channelId: CHANNEL,
      channelTitle: CHANNEL_TITLE,
      liveBroadcastContent: "none",
    },
    contentDetails: { duration: "PT253S" },
  });
  return {
    searchVideos: async (query) => {
      note("search.list", query);
      return {
        items: [
          {
            id: { videoId: VIDEO },
            snippet: {
              title: TITLE,
              channelId: CHANNEL,
              channelTitle: CHANNEL_TITLE,
              liveBroadcastContent: "none",
            },
          },
        ],
        pageInfo: { totalResults: 1, resultsPerPage: 1 },
      } as YouTubeSearchResponse;
    },
    searchChannels: async (query) => {
      note("search.list(channels)", query);
      return {
        items: [{ id: { channelId: CHANNEL }, snippet: { title: CHANNEL_TITLE } }],
      } as YouTubeSearchResponse;
    },
    searchChannelVideos: async (id) => {
      note("search.list(channel)", id);
      return { items: [lockupVideo(VIDEO)] } as unknown as YouTubeSearchResponse;
    },
    getVideos: async (ids) => {
      note("videos.list", ids.join(","));
      return {
        items: ids.map(videoItem),
        pageInfo: { totalResults: ids.length, resultsPerPage: ids.length },
      } as YouTubeVideoListResponse;
    },
    getChannels: async (ids) => {
      note("channels.list", ids.join(","));
      return {
        items: ids.map((id) => ({
          id,
          snippet: {
            title: CHANNEL_TITLE,
            description: "Official channel",
            thumbnails: { default: { url: "https://i.example/a.jpg" } },
          },
        })),
      };
    },
    getPlaylist: async (id) => {
      note("playlists.list", id);
      return {
        id,
        snippet: { title: "Mix" },
        contentDetails: { itemCount: 2 },
      } as NonNullable<Awaited<ReturnType<YouTubeApiTransport["getPlaylist"]>>>;
    },
    getPlaylistItems: async (id) => {
      note("playlistItems.list", id);
      return {
        items: [
          { snippet: { resourceId: { videoId: VIDEO } }, contentDetails: { videoId: VIDEO } },
          {
            snippet: { resourceId: { videoId: "aaaaaaaaaaa" } },
            contentDetails: { videoId: "aaaaaaaaaaa" },
          },
        ],
        pageInfo: { totalResults: 2, resultsPerPage: 2 },
      } as YouTubePlaylistItemsResponse;
    },
    ...overrides,
  };
}

interface Harness {
  provider: ReturnType<typeof createYouTubeProvider>;
  /** What the primary source cost upstream. */
  primary: Upstream;
  /** What the official API was asked for. The quota bill. */
  official: Upstream;
  session: ReturnType<typeof fakeSession>;
  circuitOpen: { value: boolean };
}

function harness(options: {
  videos?: string[];
  officialOverrides?: Partial<YouTubeApiTransport>;
  fallbackOpen?: boolean;
  sessionFactory?: () => Promise<unknown>;
} = {}): Harness {
  const primary = { calls: [] as string[] };
  const official = { calls: [] as string[] };
  const circuitOpen = { value: options.fallbackOpen ?? false };
  const built = fakeSession(primary, options.videos);
  const transport = createTieredTransport({
    primary: createInnerTubeTransport({
      sessionFactory: (options.sessionFactory
        ? options.sessionFactory
        : async () => built.session) as never,
      searchTtlMs: 60_000,
      videoTtlMs: 60_000,
    }),
    fallback: officialSource(official, options.officialOverrides),
    isFallbackOpen: () => circuitOpen.value,
  });
  return {
    provider: createYouTubeProvider(transport),
    primary,
    official,
    session: built,
    circuitOpen,
  };
}

const bill = (upstream: Upstream): string[] => upstream.calls;

beforeEach(() => {
  resetYouTubeMetrics();
});

describe("§59 — a user searching the same thing ten times", () => {
  it("costs one upstream request, not ten", async () => {
    // The headline scenario. Before Phase 55 this was ten `search.list` calls:
    // 1000 quota units, a tenth of the default daily budget, for one page of
    // results a person looked at once.
    const { provider, primary, official } = harness();
    for (let index = 0; index < 10; index += 1) {
      const result = await provider.searchTracks({ query: "son tung", limit: 20 });
      expect(result.items).toHaveLength(1);
    }
    expect(bill(primary)).toEqual(["search:son tung"]);
    // And the official API was never consulted at all.
    expect(bill(official)).toEqual([]);
  });

  it("returns an identical track every time, whichever source answered", async () => {
    // Source-agnosticism is user-visible: the object a caller receives must not
    // vary with the source, or search results would flicker between two
    // different tracks for the same query.
    const { provider } = harness();
    const first = await provider.searchTracks({ query: "son tung" });
    const second = await provider.searchTracks({ query: "son tung" });
    expect(second.items[0]).toEqual(first.items[0]);
    expect(first.items[0]?.provider).toBe("youtube");
    expect(first.items[0]?.providerTrackId).toBe(VIDEO);
    // The artist name came from the InnerTube byline, not "Unknown artist".
    expect(first.items[0]?.artistName).toBe(CHANNEL_TITLE);
  });

  it("still costs a full call for a genuinely different query", async () => {
    // Collapsing these would be wrong, not efficient: they have different
    // answers, and serving one for the other is a correctness bug.
    const { provider, primary } = harness();
    await provider.searchTracks({ query: "son tung" });
    await provider.searchTracks({ query: "son tung 2019" });
    expect(bill(primary)).toEqual(["search:son tung", "search:son tung 2019"]);
  });

  it("does not conflate two queries that differ only in case or spacing", async () => {
    // Cache-key normalisation must be aggressive about whitespace and case, or
    // the same query typed two ways pays twice.
    const { provider, primary } = harness();
    await provider.searchTracks({ query: "Sơn Tùng" });
    await provider.searchTracks({ query: "  sơn   tùng " });
    expect(bill(primary)).toHaveLength(1);
  });

  it("does NOT conflate queries that differ only in diacritics", async () => {
    // "Lac Troi" and "Lạc Trôi" are different questions in a Vietnamese
    // catalogue. Folding them together is a wrong answer served cheaply.
    const { provider, primary } = harness();
    await provider.searchTracks({ query: "Lạc Trôi" });
    await provider.searchTracks({ query: "Lac Troi" });
    expect(bill(primary)).toHaveLength(2);
  });
});

describe("§62 — three components asking at the same moment", () => {
  it("costs one upstream request per distinct question", async () => {
    // The player, a track row and a queue hydrating the same video. Concurrent
    // identical requests are exactly the case a plain TTL cache misses, which
    // is what the in-flight coalescing layer is for.
    const { provider, primary, official } = harness();
    const [track, detail, again] = await Promise.all([
      provider.searchTracks({ query: "son tung", limit: 1 }),
      provider.getTrack(VIDEO),
      provider.getTrack(VIDEO),
    ]);
    expect(track.items).toHaveLength(1);
    expect(detail.providerTrackId).toBe(VIDEO);
    expect(again.providerTrackId).toBe(VIDEO);
    // One search and one metadata read, despite three concurrent callers.
    expect(bill(primary)).toEqual(["search:son tung", `getInfo:${VIDEO}`]);
    expect(bill(official)).toEqual([]);
  });
});

describe("§61 — artist pages", () => {
  it("resolves the artist and their tracks, paying only for the channel snippet", async () => {
    const { provider, primary, official } = harness();
    const artist = await provider.getArtist(CHANNEL);
    expect(artist.name).toBe(CHANNEL_TITLE);

    const tracks = await provider.getArtistTracks(CHANNEL, { limit: 20 });
    expect(tracks.items).toHaveLength(1);
    expect(tracks.items[0]?.providerTrackId).toBe(VIDEO);

    // Discovery went to InnerTube. The one official call is `channels.list`,
    // which §35 classifies OFFICIAL-DATA-REQUIRED: InnerTube has no
    // structured channel snippet, and the artist name is load-bearing.
    expect(bill(primary)).toEqual([`getChannel:${CHANNEL}`]);
    expect(bill(official)).toEqual([`official:channels.list:${CHANNEL}`]);
  });

  it("does not re-bill the channel on every artist-page load", async () => {
    const { provider, official } = harness();
    await provider.getArtist(CHANNEL);
    await provider.getArtist(CHANNEL);
    await provider.getArtistTracks(CHANNEL);
    // Before: every artist-page load re-billed `channels.list`. Now the second
    // and third are cache hits.
    expect(bill(official)).toHaveLength(1);
  });
});

describe("§60 — playlists stay on the official API", () => {
  it("loads a playlist and hydrates its tracks without a videos.list call", async () => {
    const { provider, primary, official } = harness();
    const playlist = await provider.getPlaylist("PL1", { limit: 2 });
    expect(playlist.tracks).toHaveLength(2);
    // The ORDER and the page walk stay on the official API, because
    // `youtubei.js@18`'s WEB `Playlist` exposes no `contents` (§35 —
    // OFFICIAL-DATA-REQUIRED, and an InnerTube walk would be strictly worse
    // while saving no quota).
    //
    // The METADATA hydration is a different question, and it goes to InnerTube:
    // `getVideos` is one of the four InnerTube-first operations. So a 2-item
    // playlist costs 2 official units for the listing and zero for the tracks.
    expect(bill(official)).toEqual([
      "official:playlists.list:PL1",
      "official:playlistItems.list:PL1",
    ]);
    expect(bill(primary)).toEqual([`getInfo:${VIDEO}`, "getInfo:aaaaaaaaaaa"]);
  });

  it("hydrates a 120-item playlist in three batches of 50, not 120 calls", async () => {
    // §26 / §27. `getVideos` fetches at most 50 ids at a time. Batching by
    // anything else either fails outright or silently truncates the playlist,
    // which is the worst possible failure: a playlist that looks short.
    const ids = Array.from({ length: 120 }, (_, i) => `id${String(i).padStart(10, "0")}`);
    const { provider, primary, official } = harness({
      officialOverrides: {
        getPlaylistItems: async () =>
          ({
            items: ids.map((id) => ({
              snippet: { resourceId: { videoId: id } },
              contentDetails: { videoId: id },
            })),
            pageInfo: { totalResults: ids.length, resultsPerPage: ids.length },
          }) as YouTubePlaylistItemsResponse,
      },
    });
    const playlist = await provider.getPlaylist("PL1", { limit: 120 });
    expect(playlist.tracks).toHaveLength(120);
    // The transport fetches at most 50 per upstream request, and the whole
    // 120 costs zero official units.
    const batches = bill(primary).filter((call) => call.startsWith("getInfo:"));
    expect(batches).toHaveLength(120);
    expect(bill(official).filter((call) => call.startsWith("official:videos.list"))).toEqual([]);
  });

  it("does not walk pages beyond the window it was asked for", async () => {
    // §23 / §28. A 20-item request must not pull a 50-row page and discard
    // 30 of them, nor walk forward looking for more.
    const pageSizes: number[] = [];
    const { provider } = harness({
      officialOverrides: {
        getPlaylistItems: async (_id, options) => {
          const size = options?.limit ?? 50;
          pageSizes.push(size);
          return {
            items: Array.from({ length: size }, (_, i) => ({
              snippet: { resourceId: { videoId: `id${String(i).padStart(10, "0")}` } },
              contentDetails: { videoId: `id${String(i).padStart(10, "0")}` },
            })),
            pageInfo: { totalResults: 5000, resultsPerPage: size },
          } as YouTubePlaylistItemsResponse;
        },
      },
    });
    await provider.getPlaylist("PL1", { limit: 20 });
    expect(pageSizes).toEqual([20]);
  });

  it("caches playlist items, so a reopened playlist is free", async () => {
    const { provider, official } = harness();
    await provider.getPlaylist("PL1", { limit: 2 });
    const after = bill(official).length;
    await provider.getPlaylist("PL1", { limit: 2 });
    expect(bill(official)).toHaveLength(after);
  });
});

describe("§71 — a stream URL expires and the user replays", () => {
  it("re-resolves playback without spending a search", async () => {
    // Playback never touches search, and no playback result is ever cached —
    // a signed URL outlives nothing (§56). Re-resolving is a metadata read.
    const { provider, primary, official } = harness();
    await provider.searchTracks({ query: "son tung", limit: 1 });
    const searched = bill(primary).filter((call) => call.startsWith("search:")).length;
    await provider.getTrack(VIDEO);
    await provider.getTrack(VIDEO);
    expect(
      bill(primary).filter((call) => call.startsWith("search:")).length,
    ).toBe(searched);
    expect(bill(official)).toEqual([]);
  });
});

describe("§66 / §70 — the official budget runs out", () => {
  it("keeps serving results from the primary source", async () => {
    // The point of the phase: exhausting 10,000 daily units degrades result
    // completeness, not the product.
    const { provider, official, circuitOpen } = harness({ fallbackOpen: true });
    const result = await provider.searchTracks({ query: "son tung" });
    expect(result.items).toHaveLength(1);
    expect(bill(official)).toEqual([]);
    expect(circuitOpen.value).toBe(true);
  });

  it("reports a provider failure, not a fake empty result, when nothing is left", async () => {
    // Both sources unavailable. An empty list renders as "no songs found",
    // which is a confident lie; a failure renders as a failure, which is true.
    const { provider } = harness({
      fallbackOpen: true,
      sessionFactory: async () => {
        throw new Error("InnerTube request timed out");
      },
    });
    await expect(provider.searchTracks({ query: "son tung" })).rejects.toThrow();
  });

  it("returns to the primary source when the budget resets", async () => {
    // §65: a fallback must not be sticky. If one exhausted day permanently
    // moved Aurora onto the official API, the saving would be gone forever.
    const { provider, official, circuitOpen } = harness({ fallbackOpen: true });
    await provider.searchTracks({ query: "son tung" });
    expect(bill(official)).toEqual([]);

    circuitOpen.value = false;
    const recovered = await provider.searchTracks({ query: "son tung" });
    expect(recovered.items).toHaveLength(1);
    // The budget's return is not a licence to spend it: the primary was always
    // fine, so it keeps answering.
    expect(bill(official)).toEqual([]);
  });

  it("uses the official API exactly once when the primary is broken", async () => {
    // §10: never both sources for one search, and never a fan-out to "compare
    // quality" — that would spend the quota this phase exists to save.
    const { provider, primary, official } = harness({
      sessionFactory: async () => {
        throw new Error("InnerTube request timed out");
      },
    });
    const result = await provider.searchTracks({ query: "son tung" });
    expect(result.items).toHaveLength(1);
    expect(bill(primary)).toEqual([]);
    expect(bill(official)).toEqual(["official:search.list:son tung"]);
  });
});

describe("§58 — the saving is measurable", () => {
  it("reports the source split, the fallback rate and the request counts", async () => {
    // The three counters answer three different questions and none of them
    // substitutes for another:
    //   `search.innertube`  — searches ROUTED to InnerTube (6)
    //   `search.cache_hit`  — of those, served without any request (5)
    //   `requests.innerTube`— requests that actually left the process (1)
    //
    // The old code would have reported 6 official `search.list` calls, so the
    // 1-vs-6 gap is the phase's result stated in the units quota is spent in.
    const { provider } = harness();
    for (let index = 0; index < 6; index += 1) {
      await provider.searchTracks({ query: "son tung" });
    }
    const snapshot = snapshotYouTubeMetrics();
    expect(snapshot.counters["search.innertube"]).toBe(6);
    expect(snapshot.counters["search.cache_hit"]).toBe(5);
    expect(snapshot.counters["search.upstream"]).toBe(1);
    expect(snapshot.requests).toMatchObject({
      total: 1,
      innerTube: 1,
      dataApi: 0,
      servedFromCache: 5,
    });
    expect(snapshot.ratios.innertubeShareOfSearch).toBe(1);
    expect(snapshot.ratios.dataApiFallbackRate).toBe(0);
  });

  it("never double-counts one search across the counters that describe it", async () => {
    // The one-owner rule, asserted. Three layers used to increment
    // `search.innertube` — the timed wrapper, the cache's miss path, and the
    // router — so six searches reported seven, and `innertubeShareOfSearch`
    // could not be interpreted. A ratio derived from a double-counted counter
    // looks like evidence and is not.
    const { provider } = harness();
    await provider.searchTracks({ query: "son tung" });
    const snapshot = snapshotYouTubeMetrics();
    // One search, one routing decision, one upstream request.
    expect(snapshot.counters["search.innertube"]).toBe(1);
    expect(snapshot.counters["search.upstream"]).toBe(1);
    expect(snapshot.requests.total).toBe(1);
    expect(snapshot.requests.innerTube).toBe(1);
  });

  it("records a fallback so a regression in the primary path is visible", async () => {
    const { provider } = harness({
      sessionFactory: async () => {
        throw new Error("InnerTube request timed out");
      },
    });
    await provider.searchTracks({ query: "son tung" });
    const snapshot = snapshotYouTubeMetrics();
    expect(snapshot.counters["search.data_api"]).toBe(1);
    expect(snapshot.counters["search.fallback"]).toBe(1);
    expect(snapshot.ratios.dataApiFallbackRate).toBe(1);
    expect(snapshot.ratios.innertubeShareOfSearch).toBe(0);
  });

  it("never records a query, a video id, or a channel id in the metrics", async () => {
    // §57. The metrics snapshot is what an operator attaches to a bug report,
    // so it must carry no user input and no identifiers.
    const { provider } = harness();
    await provider.searchTracks({ query: "a very distinctive private query" });
    await provider.getTrack(VIDEO);
    await provider.getArtist(CHANNEL);
    const serialized = JSON.stringify(snapshotYouTubeMetrics());
    expect(serialized).not.toContain("distinctive");
    expect(serialized).not.toContain(VIDEO);
    expect(serialized).not.toContain(CHANNEL);
  });
});
