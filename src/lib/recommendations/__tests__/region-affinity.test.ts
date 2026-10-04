import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import type { RadioDiscoveryBackend } from "@/lib/radio/service";
import {
  AFFINITY_FOLLOWED,
  RECOMMENDATION_REGION_AFFINITY,
  generateRecommendations,
} from "@/lib/recommendations/service";
import type { Market } from "@/lib/region/affinity";

/**
 * Region affinity in the recommendation pipeline.
 *
 * The point of these tests is that a MARKET PRIOR must stay a prior: it may
 * reorder equally-relevant candidates, and it must never overturn the
 * listener's own history, never filter anything out, and never apply at all
 * when no market was supplied.
 */

let counter = 0;

function track(title: string, artistName: string, id?: string): Track {
  counter += 1;
  const key = id ?? `t-${counter}`;
  return {
    id: key,
    provider: "deezer",
    providerTrackId: key,
    title,
    artistId: `artist-${key}`,
    artistName,
    duration: 200,
  };
}

function backend(overrides: Partial<RadioDiscoveryBackend> = {}): RadioDiscoveryBackend {  return {
    searchTracks: async () => [],
    artistTracks: async () => [],
    albumTracks: async () => [],
    artistAlbums: async () => [],
    popularTracks: async () => [],
    getTrack: async () => null,
    getArtist: async () => null,
    ...overrides,
  };
}

function scoresOf(set: { items: Array<{ score: number }> }): number[] {
  return set.items.map((item) => item.score);
}

/**
 * A catalog with the international and Vietnamese tracks interleaved, and the
 * international ones FIRST, so an unchanged order is observable rather than
 * accidental.
 */
function mixedCatalog(): Track[] {  return [
    track("Shape of You", "Ed Sheeran", "intl-1"),
    track("Blinding Lights", "The Weeknd", "intl-2"),
    track("As It Was", "Harry Styles", "intl-3"),
    track("Lạc Trôi", "Sơn Tùng M-TP", "vn-1"),
    track("Nơi Này Có Anh", "Sơn Tùng M-TP", "vn-2"),
    track("Em Của Ngày Hôm Qua", "Sơn Tùng M-TP", "vn-3"),
  ];
}

describe("generateRecommendations / region affinity", () => {
  it("puts Vietnamese discovery first for a VN listener", async () => {
    const set = await generateRecommendations(
      backend({ popularTracks: async () => mixedCatalog() }),
      { market: "VN" },
    );
    const ordered = set.items.map((item) => item.identity.title);
    expect(ordered[0]).toBe("Lạc Trôi");
  });

  it("proves the boost did it: the neutral order is unchanged", async () => {
    const provider = backend({ popularTracks: async () => mixedCatalog() });
    const neutral = await generateRecommendations(provider, { market: "GLOBAL" });
    const regional = await generateRecommendations(provider, { market: "VN" });
    // Neutral keeps provider order, which puts international first.
    expect(neutral.items[0]?.identity.title).toBe("Shape of You");
    expect(regional.items[0]?.identity.title).not.toBe(
      neutral.items[0]?.identity.title,
    );
  });

  it("is byte-for-byte identical when no market is supplied", async () => {
    const provider = backend({ popularTracks: async () => mixedCatalog() });
    const omitted = await generateRecommendations(provider, {});
    const global = await generateRecommendations(provider, { market: "GLOBAL" });
    expect(omitted.items.map((item) => item.identity.title)).toEqual(
      global.items.map((item) => item.identity.title),
    );
  });

  it("drops nothing: the boost reorders, it never filters", async () => {
    const set = await generateRecommendations(
      backend({ popularTracks: async () => mixedCatalog() }),
      { market: "VN" },
    );
    expect(set.items).toHaveLength(6);
    // Diversity must not have been solved by deleting the international half.
    const titles = set.items.map((item) => item.identity.title);
    expect(titles).toContain("Shape of You");
    expect(titles).toContain("Blinding Lights");
    expect(titles).toContain("As It Was");
  });

  it("keeps international diversity at the top of a boosted set", async () => {
    // The anti-feedback-loop requirement, measured rather than assumed: with
    // three Vietnamese tracks to one international ceiling, international music
    // must still reach the visible half.
    const set = await generateRecommendations(
      backend({ popularTracks: async () => mixedCatalog() }),
      { market: "VN" },
    );
    const top = set.items.slice(0, 3).map((item) => item.identity.title);
    expect(top.some((title) => /Shape of You|Blinding Lights|As It Was/.test(title))).toBe(
      true,
    );
  });

  it("does not let a market prior overturn the listener following an artist", async () => {
    // `AFFINITY_FOLLOWED` is first-hand evidence of taste; the market is a prior
    // about a population. The weights are what keep that ordering true, so the
    // assertion is on the weights.
    expect(RECOMMENDATION_REGION_AFFINITY).toBeLessThan(AFFINITY_FOLLOWED);
    expect(RECOMMENDATION_REGION_AFFINITY).toBeGreaterThan(0);
  });

  it("withholds the region term from a track-anchored recommendation", async () => {
    // "More like THIS" must not become "more like Vietnam". Proven by score,
    // not by order: with an international seed the region term must contribute
    // exactly zero, so the anchored run's scores are identical to the neutral
    // run's scores. If the term leaked in, `vn` would score higher under `VN`.
    const seed = track("Shape of You", "Ed Sheeran", "seed-1");
    const catalog = [
      seed,
      track("Lạc Trôi", "Sơn Tùng M-TP", "vn-1"),
      track("Nơi Này Có Anh", "Sơn Tùng M-TP", "vn-2"),
    ];
    const run = (market?: Market) =>
      generateRecommendations(
        backend({
          getTrack: async () => seed,
          searchTracks: async () => catalog,
          // Empty, so `similar-to-current` is the only avenue that produces
          // anything and the comparison cannot be perturbed by a second
          // discovery venue.
          popularTracks: async () => [],
        }),
        {
          currentTrack: { provider: "deezer", providerTrackId: "seed-1" },
          ...(market ? { market } : {}),
        },
      );

    const anchored = await run("VN");
    const neutral = await run("GLOBAL");
    expect(anchored.items).not.toHaveLength(0);
    expect(scoresOf(anchored)).toEqual(scoresOf(neutral));
  });

  it("applies the region term to the same catalog when discovery is unanchored", async () => {
    // The control for the test above: identical catalog, identical venues, only
    // the anchoring removed. If this did NOT differ, the previous test would be
    // passing for the wrong reason.
    const catalog = [
      track("Shape of You", "Ed Sheeran", "intl-1"),
      track("Lạc Trôi", "Sơn Tùng M-TP", "vn-1"),
    ];
    const run = (market?: Market) =>
      generateRecommendations(
        backend({ popularTracks: async () => catalog }),
        { ...(market ? { market } : {}) },
      );
    const boosted = await run("VN");
    const neutral = await run("GLOBAL");
    expect(scoresOf(boosted)).not.toEqual(scoresOf(neutral));
    expect(
      boosted.items.find((item) => item.identity.title === "Lạc Trôi")?.score,
    ).toBeGreaterThan(
      neutral.items.find((item) => item.identity.title === "Lạc Trôi")?.score ?? 0,
    );
  });

  it("asks the market-scoped discovery avenue only when a market is set", async () => {
    const seen: Array<[string, number, string]> = [];
    const provider = backend({
      popularTracks: async () => [],
      searchTracksInMarket: async (query, limit, market) => {
        seen.push([query, limit, market]);
        return [track("Lạc Trôi", "Sơn Tùng M-TP", "vn-1")];
      },
    });

    await generateRecommendations(provider, {});
    expect(seen).toHaveLength(0);

    const set = await generateRecommendations(provider, { market: "VN" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[2]).toBe("VN");
    expect(set.items.map((item) => item.identity.title)).toContain("Lạc Trôi");
  });

  it("does not duplicate a result that both avenues returned", async () => {
    // The market avenue is additive, so it can surface a track the popular
    // avenue already had. §25 still has to hold.
    const shared = track("Lạc Trôi", "Sơn Tùng M-TP", "shared-1");
    const set = await generateRecommendations(
      backend({
        popularTracks: async () => [shared, track("Shape of You", "Ed Sheeran", "i-1")],
        searchTracksInMarket: async () => [shared],
      }),
      { market: "VN" },
    );
    const titles = set.items.map((item) => item.identity.title);
    expect(titles.filter((title) => title === "Lạc Trôi")).toHaveLength(1);
  });
});
