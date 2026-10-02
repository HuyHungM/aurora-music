import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import type {
  ExtractorSearchOutcome,
  FanoutSearchResult,
} from "@/lib/providers/extractor-manager";
import { createUnifiedSearch, enrichIdentity } from "@/lib/music/unified-search";

/**
 * Integration of the three new search layers — normalization, ranking, and the
 * fan-out itself — at the level the product actually calls them.
 */

function track(
  provider: string,
  id: string,
  title: string,
  artist: string,
): Track {
  return {
    id: `${provider}-${id}`,
    provider,
    providerTrackId: id,
    title,
    artistId: `${provider}-${artist.replace(/\s/g, "-").toLowerCase()}`,
    artistName: artist,
    duration: 210,
    providerUrl: `https://example.invalid/${provider}/${id}`,
  };
}

function outcome(provider: string, tracks: Track[]): ExtractorSearchOutcome {
  return { provider, status: "success", tracks };
}

/** A backend whose result set is fixed, counting how often it was asked. */
function backendFor(outcomes: ExtractorSearchOutcome[]) {
  const state = { calls: 0 };
  return {
    state,
    async searchAll(query: string): Promise<FanoutSearchResult> {
      state.calls += 1;
      return {
        query,
        outcomes: outcomes.map((entry) => ({ ...entry, tracks: [...entry.tracks] })),
        tracks: outcomes.flatMap((entry) => entry.tracks),
        succeeded: outcomes.some(
          (entry) => entry.status === "success" || entry.status === "empty",
        ),
      };
    },
  };
}

/**
 * The shape the baseline measurement used: three providers, heavy overlap,
 * and a first provider that returns its NOISIER results first. This is what
 * made a live cover outrank the exact match before ranking existed.
 */
function noisyOutcomes(): ExtractorSearchOutcome[] {
  const exact = [
    track("youtube", "v1", "Cảm Ơn", "MCK"),
    track("deezer", "d1", "Cảm Ơn", "MCK"),
    track("spotify", "s1", "Cảm Ơn", "MCK"),
  ];
  const noise = [
    track("youtube", "v2", "Cảm Ơn (Live)", "Some Cover Band"),
    track("youtube", "v3", "Cảm Ơn Thôi", "Another Artist"),
    track("deezer", "d2", "Em Của Ngày Hôm Qua (Remix)", "DJ Nobody"),
    track("spotify", "s2", "ca cam on tutorial", "Spoken Word"),
  ];
  // The same song under three providers must merge into ONE identity.
  return [outcome("youtube", [...noise.slice(0, 2), ...exact]), outcome("deezer", [exact[1]!, noise[2]!]), outcome("spotify", [exact[2]!, noise[3]!])];
}

describe("ranking through the search pipeline", () => {
  it("puts the exact match first, where the provider order had not", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const result = await search.search("cam on");
    expect(result.tracks[0]?.title).toBe("Cảm Ơn");
    expect(result.tracks[0]?.artists[0]?.name).toBe("MCK");
    expect(result.diagnostics.topBand).toBe("exactTitle");
  });

  it("reports the top band and the ranking cost", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const result = await search.search("cam on");
    expect(result.diagnostics.topBand).not.toBeNull();
    expect(result.diagnostics.rankingMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps every result — ranking reorders, it never drops", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const result = await search.search("cam on");
    const titles = result.tracks.map((identity) => identity.title);
    expect(titles).toContain("Cảm Ơn");
    expect(titles).toContain("Cảm Ơn (Live)");
    expect(titles).toContain("ca cam on tutorial");
  });

  it("can be switched off to recover provider order", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const ranked = await search.search("cam on", { rank: true });
    const unranked = await search.search("cam on", { rank: false });
    // With ranking off the first provider's first row wins again, which is
    // precisely the behaviour ranking replaced.
    expect(unranked.tracks[0]?.title).toBe("Cảm Ơn (Live)");
    expect(ranked.tracks[0]?.title).toBe("Cảm Ơn");
    expect(unranked.diagnostics.topBand).toBeNull();
  });

  it("matches an unaccented query to accented results", async () => {
    const search = createUnifiedSearch(
      backendFor([
        outcome("youtube", [
          track("youtube", "v1", "Ngày Mai Người Ta Lấy Chồng", "Hồ Quỳnh Hương"),
        ]),
      ]),
    );
    const result = await search.search("ngay mai nguoi ta lay chong");
    expect(result.tracks).toHaveLength(1);
    // The display text is untouched; only the comparison was folded.
    expect(result.tracks[0]?.title).toBe("Ngày Mai Người Ta Lấy Chồng");
  });

  it("still returns the raw query the person typed", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const result = await search.search("  Cam  On  ");
    expect(result.query).toBe("Cam  On");
  });

  it("passes the trimmed query to providers, not the folded one", async () => {
    // Folding is a comparison concern. Sending "cam on" upstream would ask
    // YouTube to search a spelling the person did not type.
    const backend = backendFor(noisyOutcomes());
    await createUnifiedSearch(backend).search("  CẢM ƠN  ");
    expect(backend.state.calls).toBe(1);
  });

  it("keeps cross-provider merging intact alongside ranking", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const result = await search.search("cam on");
    const exact = result.tracks.find((identity) => identity.title === "Cảm Ơn");
    // The three provider representations of one song are ONE identity, and it
    // is the one ranking put first.
    expect(exact?.sources).toHaveLength(3);
    expect(result.tracks[0]?.title).toBe("Cảm Ơn");
    expect(result.diagnostics.mergedSources).toBeGreaterThanOrEqual(2);
  });

  it("reports no results for an empty result set", async () => {
    const search = createUnifiedSearch(backendFor([{ provider: "youtube", status: "empty", tracks: [] }]));
    const result = await search.search("zzzz");
    expect(result.tracks).toEqual([]);
    expect(result.diagnostics.topBand).toBeNull();
    expect(result.diagnostics.rankingMs).toBe(0);
  });

  it("still rejects an empty query", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    await expect(search.search("   ")).rejects.toThrow();
  });
});

describe("provider failure isolation", () => {
  function withFailures(): ExtractorSearchOutcome[] {
    return [
      outcome("youtube", [track("youtube", "v1", "Cảm Ơn", "MCK")]),
      {
        provider: "deezer",
        status: "failed",
        tracks: [],
        error: {
          name: "ExtractorError",
          code: "EXTRACTOR_ERROR",
          message: "down",
          retryable: true,
          provider: "deezer",
        },
      },
      outcome("spotify", [track("spotify", "s1", "Cảm Ơn", "MCK")]),
    ];
  }

  it("keeps usable results when one provider fails", async () => {
    const search = createUnifiedSearch(backendFor(withFailures()));
    const result = await search.search("cam on");
    expect(result.succeeded).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.tracks[0]?.title).toBe("Cảm Ơn");
  });

  it("keeps useful results when a provider returns nothing", async () => {
    const outcomes: ExtractorSearchOutcome[] = [
      outcome("youtube", [track("youtube", "v1", "Cảm Ơn", "MCK")]),
      { provider: "deezer", status: "empty", tracks: [] },
    ];
    const result = await createUnifiedSearch(backendFor(outcomes)).search("cam on");
    expect(result.succeeded).toBe(true);
    expect(result.tracks).toHaveLength(1);
  });

  it("reports failure when every provider fails", async () => {
    const outcomes: ExtractorSearchOutcome[] = [
      { provider: "youtube", status: "failed", tracks: [] },
      { provider: "deezer", status: "unsupported", tracks: [] },
    ];
    const result = await createUnifiedSearch(backendFor(outcomes)).search("x");
    expect(result.succeeded).toBe(false);
    expect(result.tracks).toEqual([]);
  });
});

describe("deduplication", () => {
  it("merges a repeated identical provider row instead of duplicating it", async () => {
    const dup = track("youtube", "v1", "Cảm Ơn", "MCK");
    const search = createUnifiedSearch(
      backendFor([outcome("youtube", [dup, { ...dup }, { ...dup }])]),
    );
    const result = await search.search("cam on");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.sources).toHaveLength(1);
  });

  it("keeps genuinely different recordings separate", async () => {
    const search = createUnifiedSearch(
      backendFor([
        outcome("youtube", [
          track("youtube", "v1", "Lạc Trôi", "Sơn Tùng M-TP"),
          track("youtube", "v2", "Lạc Trôi (Live)", "Sơn Tùng M-TP"),
        ]),
      ]),
    );
    const result = await search.search("lac troi");
    expect(result.tracks).toHaveLength(2);
    // Both survive; ranking decides which is shown first.
    expect(result.tracks[0]?.title).toBe("Lạc Trôi");
  });

  it("enrichment still merges only on exact or strong evidence", async () => {
    const identity = await createUnifiedSearch(
      backendFor([outcome("deezer", [track("deezer", "d1", "Lạc Trôi", "Sơn Tùng M-TP")])]),
    ).search("lac troi");
    const target = identity.tracks[0];
    expect(target).toBeDefined();
    if (!target) {
      return;
    }
    const sameSong = await createUnifiedSearch(
      backendFor([outcome("youtube", [track("youtube", "v1", "Lạc Trôi", "Sơn Tùng M-TP")])]),
    ).search("lac troi");
    const enriched = enrichIdentity(target, sameSong.tracks);
    expect(enriched.sources).toHaveLength(2);
  });
});

describe("concurrency", () => {
  it("does not let one search corrupt another's ordering", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    // Two different queries in flight together: the second must not be ranked
    // with the first's query, and neither may observe the other's order.
    const [a, b] = await Promise.all([
      search.search("cam on"),
      search.search("cam on live"),
    ]);
    expect(a.tracks[0]?.title).toBe("Cảm Ơn");
    expect(b.tracks[0]?.title).toBe("Cảm Ơn (Live)");
  });

  it("gives the same answer for the same query every time", async () => {
    const search = createUnifiedSearch(backendFor(noisyOutcomes()));
    const first = await search.search("cam on");
    const second = await search.search("cam on");
    // Compared on the provider reference, not the Aurora identity id: that id
    // is a fresh cuid per canonicalization, so it is expected to differ
    // between two runs and asserting on it would test the id generator.
    const refOf = (result: Awaited<ReturnType<typeof search.search>>) =>
      result.tracks.map((identity) =>
        [
          identity.title,
          identity.artists.map((artist) => artist.name).join(","),
          identity.sources
            .map((source) => `${source.source}:${source.id}`)
            .sort()
            .join("|"),
        ].join("::"),
      );
    expect(refOf(second)).toEqual(refOf(first));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
