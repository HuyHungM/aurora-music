import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import type { ExtractorSearchOutcome } from "@/lib/providers/extractor-manager";
import { createUnifiedSearch } from "@/lib/music/unified-search";

/**
 * Local candidate supply for a DISCOVERY query.
 *
 * The region term can only reorder what the providers returned. Measured, a
 * generic `pop` fan-out returned 0 of 20 Vietnamese, so the ranker had nothing
 * local to promote however large the boost — which is why this second avenue
 * exists. These tests cover the three properties that make it safe.
 */

let counter = 0;

function track(title: string, artistName: string): Track {
  counter += 1;
  const id = `t-${counter}`;
  return {
    id,
    provider: "deezer",
    providerTrackId: id,
    title,
    artistId: `a-${id}`,
    artistName,
    duration: 200,
  };
}

function ok(tracks: Track[]): ExtractorSearchOutcome {
  return { provider: "deezer", status: "success", tracks };
}

/** Records every query the backend was asked for, in order. */
function backend(perCall: Track[][]) {
  const seen: string[] = [];
  return {
    seen,
    searchAll: vi.fn(async (query: string) => {
      const index = seen.push(query) - 1;
      const outcome = ok(perCall[index] ?? []);
      return {
        query,
        tracks: outcome.tracks,
        outcomes: [outcome],
        succeeded: true,
        partial: false,
      };
    }),
  };
}

const titles = (result: { tracks: Array<{ title: string }> }) =>
  result.tracks.map((item) => item.title);

describe("unified search / local discovery avenue", () => {
  it("asks a second, Aurora-owned query for a generic discovery query", async () => {
    const source = backend([
      [track("Shape of You", "Ed Sheeran"), track("As It Was", "Harry Styles")],
      [track("Lạc Trôi", "Sơn Tùng M-TP")],
    ]);
    await createUnifiedSearch(source).search("pop", { market: "VN" });
    expect(source.seen[0]).toBe("pop");
    expect(source.seen).toHaveLength(2);
    // Aurora's own seed, issued as a SECOND query. The listener's query is
    // never rewritten, appended to, or replaced.
    expect(source.seen[1]).toBe("vpop");
  });

  it("does NOT ask a second query for an entity lookup", async () => {
    // The gate is measured from the results: `Taylor Swift` produces an exact
    // match, so the listener asked for a specific thing and relevance is the
    // whole job. This is what protects exact-match search from the avenue.
    const source = backend([[track("Taylor Swift", "Taylor Swift")]]);
    const result = await createUnifiedSearch(source).search("Taylor Swift", {
      market: "VN",
    });
    expect(source.seen).toHaveLength(1);
    expect(titles(result)[0]).toBe("Taylor Swift");
  });

  it("does not ask a second query for a Vietnamese entity lookup either", async () => {
    const source = backend([
      [track("Lạc Trôi", "Sơn Tùng M-TP")],
      [track("Something Else", "Other")],
    ]);
    const result = await createUnifiedSearch(source).search("Lạc Trôi", {
      market: "VN",
    });
    expect(source.seen).toHaveLength(1);
    expect(titles(result)[0]).toBe("Lạc Trôi");
  });

  it("does not ask a second query without a market", async () => {
    const source = backend([[track("Shape of You", "Ed Sheeran")]]);
    await createUnifiedSearch(source).search("pop", {});
    expect(source.seen).toHaveLength(1);
  });

  it("does not ask a second query for the neutral market", async () => {
    const source = backend([[track("Shape of You", "Ed Sheeran")]]);
    await createUnifiedSearch(source).search("pop", { market: "GLOBAL" });
    expect(source.seen).toHaveLength(1);
  });

  it("does not ask a second query when ranking is switched off", async () => {
    // The gate reads the ranking, so without it there is no gate — and adding
    // an unsorted second fan-out would be noise.
    const source = backend([[track("Shape of You", "Ed Sheeran")]]);
    await createUnifiedSearch(source).search("pop", { market: "VN", rank: false });
    expect(source.seen).toHaveLength(1);
  });

  it("forwards the market to the provider on BOTH queries", async () => {
    const markets: unknown[] = [];
    const source = {
      searchAll: vi.fn(async (query: string, options?: { market?: string }) => {
        markets.push(options?.market);
        return {
          query,
          tracks: [],
          outcomes: [] as ExtractorSearchOutcome[],
          succeeded: true,
          partial: false,
        };
      }),
    };
    await createUnifiedSearch(source).search("pop", { market: "VN" });
    expect(markets).toEqual(["VN", "VN"]);
  });

  it("de-duplicates a track both queries returned", async () => {
    const shared = track("Lạc Trôi", "Sơn Tùng M-TP");
    const source = backend([
      [shared, track("Shape of You", "Ed Sheeran")],
      [shared, track("Nơi Này Có Anh", "Sơn Tùng M-TP")],
    ]);
    const result = await createUnifiedSearch(source).search("pop", { market: "VN" });
    expect(titles(result).filter((title) => title === "Lạc Trôi")).toHaveLength(1);
  });

  it("survives a failing local avenue", async () => {
    let call = 0;
    const source = {
      searchAll: vi.fn(async (query: string) => {
        call += 1;
        if (call === 1) {
          return {
            query,
            tracks: [track("Shape of You", "Ed Sheeran")],
            outcomes: [ok([track("Shape of You", "Ed Sheeran")])],
            succeeded: true,
            partial: false,
          };
        }
        throw new Error("provider down");
      }),
    };
    const result = await createUnifiedSearch(source).search("pop", { market: "VN" });
    expect(titles(result)).toContain("Shape of You");
  });

  it("ranks the local candidate above an equally irrelevant international one", async () => {
    // The end-to-end claim: the avenue supplies local candidates AND the region
    // term lifts them, so a Vietnamese result competes near the top of a
    // generic query.
    const source = backend([
      [
        track("Shape of You", "Ed Sheeran"),
        track("As It Was", "Harry Styles"),
        track("Flowers", "Miley Cyrus"),
      ],
      [
        track("Lạc Trôi", "Sơn Tùng M-TP"),
        track("Nơi Này Có Anh", "Sơn Tùng M-TP"),
      ],
    ]);
    const result = await createUnifiedSearch(source).search("pop", { market: "VN" });
    expect(titles(result)[0]).toBe("Lạc Trôi");
    // International discovery is preserved, not partitioned away.
    expect(titles(result)).toContain("Shape of You");
    expect(titles(result)).toContain("As It Was");
  });

  it("returns nothing extra for a market with no seed", async () => {
    // `GLOBAL` is the only other market, and it has no seed, so the avenue is
    // inert by construction rather than by a special case in the branch.
    const source = backend([[track("Shape of You", "Ed Sheeran")]]);
    const result = await createUnifiedSearch(source).search("pop", {
      market: "GLOBAL",
    });
    expect(titles(result)).toHaveLength(1);
  });
});
