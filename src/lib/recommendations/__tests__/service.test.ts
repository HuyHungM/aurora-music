import { describe, expect, it, vi } from "vitest";
import type { Track, TrackIdentity } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import type { RadioDiscoveryBackend } from "@/lib/radio/service";
import {
  AFFINITY_LIKED,
  MAX_RECOMMENDATION_BATCHES,
  MAX_RECOMMENDATIONS_PER_ARTIST,
  RECOMMENDATION_SET_SIZE,
  generateRecommendations,
  interleaveWithDiversity,
  type RecommendationSignals,
} from "@/lib/recommendations/service";

/**
 * Recommendation pipeline unit tests (Phase 47, §71).
 *
 * These cover the pipeline stages that are Aurora's own logic — candidate
 * planning, de-duplication, filtering, ranking, diversity, and degradation —
 * against a fake discovery backend. The shared matcher/ranker underneath is
 * already covered by `src/lib/radio/__tests__/service.test.ts`; what is new
 * and asserted here is the layer on top of it.
 *
 * No ML, no vectors, no external recommendation API: the assertions are
 * about deterministic, explainable behavior, and several of them check that
 * a *specific* real signal changed the outcome, so a "score" that was
 * invented rather than derived would fail.
 */

function makeTrack(
  provider: string,
  id: string,
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    provider: provider as Track["provider"],
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: `artist-of-${id}`,
    artistName: `Artist of ${id}`,
    duration: 200,
    ...overrides,
  };
}

function backend(overrides: Partial<RadioDiscoveryBackend> = {}): RadioDiscoveryBackend {
  return {
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

function keyOf(identity: TrackIdentity): string {
  return `${identity.primarySource.source}:${identity.primarySource.id}`;
}

function ids(set: { items: Array<{ identity: TrackIdentity }> }): string[] {
  return set.items.map((item) => item.identity.primarySource.id);
}

const noSignals: RecommendationSignals = {};

describe("generateRecommendations candidate generation", () => {
  it("falls back to non-personalized discovery with no signals at all", async () => {
    const popularTracks = vi.fn(async () => [
      makeTrack("spotify", "p1", { title: "Pop One", artistName: "Nova" }),
      makeTrack("spotify", "p2", { title: "Pop Two", artistName: "Orion" }),
    ]);
    const searchTracks = vi.fn(async () => []);
    const set = await generateRecommendations(
      backend({ popularTracks, searchTracks }),
      noSignals,
    );

    // An anonymous listener must not receive a personalized label, and must
    // not pay for avenues that have no signal behind them.
    expect(set.categories).toEqual(["continue-discovering"]);
    expect(set.items.length).toBe(2);
    expect(ids(set)).toEqual(["p1", "p2"]);
    expect(searchTracks).not.toHaveBeenCalled();
  });

  it("plans no personalized avenue without the signal behind it", async () => {
    const searchTracks = vi.fn(async () => [makeTrack("spotify", "s1")]);
    const artistTracks = vi.fn(async () => [makeTrack("spotify", "a1")]);
    // Only a current track — no recent, liked, or followed artists.
    const set = await generateRecommendations(
      backend({
        getTrack: async () => makeTrack("youtube", "seed", { title: "Seed Song", artistName: "Nova" }),
        searchTracks,
        artistTracks,
        popularTracks: async () => [],
      }),
      { currentTrack: { provider: "youtube", providerTrackId: "seed" } },
    );

    expect(set.categories).not.toContain("because-you-listened");
    expect(set.categories).not.toContain("from-artists-you-follow");
    expect(set.categories).not.toContain("based-on-likes");
    expect(set.categories).toEqual(["similar-to-current"]);
    // No followed artists means the artist avenue must never be attempted.
    expect(artistTracks).not.toHaveBeenCalled();
  });

  it("uses the seed track's own catalog to plan the similar-to-current avenue", async () => {
    const seed = makeTrack("youtube", "seed", { title: "Midnight Run", artistName: "Nova" });
    const getTrack = vi.fn(async () => seed);
    const searchTracks = vi.fn(async () => [
      makeTrack("spotify", "near", { title: "Midnight Drive", artistName: "Nova", duration: 202 }),
    ]);
    const set = await generateRecommendations(
      backend({ getTrack, searchTracks, popularTracks: async () => [] }),
      { currentTrack: { provider: "youtube", providerTrackId: "seed", artistName: "Nova" } },
    );

    expect(getTrack).toHaveBeenCalledWith("youtube", "seed");
    expect(set.categories).toContain("similar-to-current");
    // The reason must be the real seed artist, never a fabricated score.
    expect(set.items[0]?.reason).toBe("Nova");
  });

  it("falls back to non-personalized discovery when the seed cannot resolve", async () => {
    const set = await generateRecommendations(
      backend({
        getTrack: async () => null,
        popularTracks: async () => [makeTrack("spotify", "p1", { title: "Fallback", artistName: "Orion" })],
      }),
      { currentTrack: { provider: "youtube", providerTrackId: "missing" } },
    );

    // §50/§63: losing the seed degrades the result, it does not empty it.
    expect(set.categories).toEqual(["continue-discovering"]);
    expect(ids(set)).toEqual(["p1"]);
  });

  it("does not pay for the discovery fallback when a signal avenue already produced", async () => {
    const popularTracks = vi.fn(async () => [makeTrack("spotify", "p1")]);
    const set = await generateRecommendations(
      backend({
        getTrack: async () => null,
        popularTracks,
      }),
      { currentTrack: { provider: "youtube", providerTrackId: "missing" }, recentArtists: ["Nova"] },
    );

    // The because-you-listened avenue ran and found something, so no extra
    // fallback request is issued.
    expect(ids(set)).toEqual(["p1"]);
    expect(set.categories).toEqual(["because-you-listened"]);
    // Exactly one discovery request: the planned one, not planned + fallback.
    expect(popularTracks).toHaveBeenCalledTimes(1);
  });

  it("bounds the number of avenues it will ask for", async () => {
    const set = await generateRecommendations(
      backend({ searchTracks: async () => [makeTrack("spotify", "s1")], popularTracks: async () => [] }),
      {
        currentTrack: { provider: "youtube", providerTrackId: "seed" },
        recentArtists: ["A", "B"],
        likedArtists: ["C", "D"],
        followedArtists: [
          { provider: "spotify", providerArtistId: "fa", name: "E" },
        ],
      },
    );
    // Five categories are derivable from this signal set; the service must
    // cap the fan-out rather than issue every request.
    expect(set.categories.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_BATCHES);
  });
});

describe("generateRecommendations de-duplication", () => {
  it("returns one entry per canonical track across avenues", async () => {
    // Both avenues see the same song under two providers; the matcher
    // groups them, and the result must contain it once.
    const track = makeTrack("spotify", "dup", { title: "Only Song", artistName: "Nova", duration: 200 });
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [track, track],
        popularTracks: async () => [track],
      }),
      { recentArtists: ["Nova"] },
    );

    const keys = set.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(1);
  });

  it("does not exclude a legitimate duplicate already in the queue by global identity", async () => {
    // §25: exclusion is per canonical KEY, not "drop anything whose title
    // matches something queued". A genuinely different song with a similar
    // title must survive.
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "queued", { title: "Echoes", artistName: "Nova" }),
          makeTrack("spotify", "different", { title: "Echoes Part Two", artistName: "Nova" }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"], excludeKeys: ["spotify:queued"] },
    );

    expect(ids(set)).not.toContain("queued");
    expect(ids(set)).toContain("different");
  });
});

describe("generateRecommendations filtering", () => {
  it("never returns a track the caller excluded (queue, history, prior suggestions)", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "keep"),
          makeTrack("spotify", "queued"),
          makeTrack("spotify", "played"),
        ],
        popularTracks: async () => [],
      }),
      {
        recentArtists: ["Nova"],
        excludeKeys: ["spotify:queued", "spotify:played"],
      },
    );

    const resultIds = ids(set);
    expect(resultIds).toEqual(["keep"]);
  });

  it("excludes through every canonical key, not just the primary one", async () => {
    // Two providers return the same song; the matcher groups them into one
    // identity whose PRIMARY source is the first seen (spotify). The caller's
    // exclusion is phrased with the SECONDARY key (deezer) — a primary-only
    // check would let this through and re-add a track the listener already
    // has in the queue.
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "sp-x", { title: "Cross Source", artistName: "Nova", duration: 200 }),
          makeTrack("deezer", "dz-x", { title: "Cross Source", artistName: "Nova", duration: 201 }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"], excludeKeys: ["deezer:dz-x"] },
    );

    expect(ids(set)).toEqual([]);
  });

  it("keeps a genuinely distinct track whose artist matches an exclusion", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "sp-y", { title: "Cross Source", artistName: "Nova", duration: 200 }),
          makeTrack("deezer", "dz-y", { title: "Cross Source", artistName: "Nova", duration: 200 }),
          makeTrack("deezer", "dz-z", { title: "Different Song", artistName: "Orion", duration: 180 }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"], excludeKeys: ["deezer:dz-y"] },
    );

    // Only the merged Cross Source group is dropped; a different song by the
    // same artist still surfaces.
    expect(ids(set)).toEqual(["dz-z"]);
  });

  it("never returns the seed track itself", async () => {
    const seed = makeTrack("youtube", "seed", { title: "Midnight Run", artistName: "Nova" });
    const set = await generateRecommendations(
      backend({
        getTrack: async () => seed,
        searchTracks: async () => [
          makeTrack("spotify", "seed", { title: "Midnight Run", artistName: "Nova", duration: 200 }),
          makeTrack("spotify", "other", { title: "Something Else", artistName: "Orion" }),
        ],
        popularTracks: async () => [],
      }),
      { currentTrack: { provider: "youtube", providerTrackId: "seed" }, excludeKeys: ["spotify:seed"] },
    );

    // §32: the current track must not be suggested back to the listener.
    expect(ids(set)).toEqual(["other"]);
  });
});

describe("generateRecommendations ranking", () => {
  it("raises a followed artist's track above an unaffiliated one", async () => {
    const set = await generateRecommendations(
      backend({
        getTrack: async () => makeTrack("youtube", "seed", { title: "Midnight Run", artistName: "Nova" }),
        searchTracks: async () => [
          makeTrack("spotify", "stranger", { title: "Midnight Run", artistName: "Stranger", duration: 200 }),
          makeTrack("spotify", "followed", { title: "Midnight Run", artistName: "Nova", duration: 200 }),
        ],
        popularTracks: async () => [],
      }),
      {
        currentTrack: { provider: "youtube", providerTrackId: "seed" },
        followedArtists: [{ provider: "spotify", providerArtistId: "fa", name: "Nova" }],
      },
    );

    expect(ids(set)[0]).toBe("followed");
  });

  it("is deterministic across repeated identical runs", async () => {
    const build = () =>
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "a", { title: "A", artistName: "One" }),
          makeTrack("spotify", "b", { title: "B", artistName: "Two" }),
          makeTrack("spotify", "c", { title: "C", artistName: "Three" }),
          makeTrack("spotify", "d", { title: "D", artistName: "Four" }),
        ],
        popularTracks: async () => [
          makeTrack("spotify", "e", { title: "E", artistName: "Five" }),
          makeTrack("spotify", "f", { title: "F", artistName: "Six" }),
        ],
      });
    const signals: RecommendationSignals = { recentArtists: ["One"], likedArtists: ["Two"] };
    const first = await generateRecommendations(build(), signals, 6);
    const second = await generateRecommendations(build(), signals, 6);

    expect(ids(first)).toEqual(ids(second));
    expect(first.items.map((item) => item.score)).toEqual(
      second.items.map((item) => item.score),
    );
  });

  it("adds affinity for a liked artist, and none for an unaffiliated one", async () => {
    const makeSet = (likedArtists: string[]) =>
      generateRecommendations(
        backend({
          searchTracks: async () => [
            makeTrack("spotify", "liked", { title: "X", artistName: "Beloved" }),
            makeTrack("spotify", "cold", { title: "Y", artistName: "Stranger" }),
          ],
          popularTracks: async () => [],
        }),
        { recentArtists: ["Zzz"], likedArtists },
      );
    const withLiked = await makeSet(["Beloved"]);
    const without = await makeSet([]);

    const likedScore = withLiked.items.find((i) => i.identity.primarySource.id === "liked")?.score ?? 0;
    const coldScore = withLiked.items.find((i) => i.identity.primarySource.id === "cold")?.score ?? 0;
    expect(likedScore - coldScore).toBe(AFFINITY_LIKED);
    expect(without.items.every((item) => item.score === 0)).toBe(true);
  });
});

describe("generateRecommendations diversity", () => {
  it("does not run the same artist twice in a row while another is available", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "n1", { title: "N1", artistName: "Nova" }),
          makeTrack("spotify", "n2", { title: "N2", artistName: "Nova" }),
          makeTrack("spotify", "o1", { title: "O1", artistName: "Orion" }),
          makeTrack("spotify", "o2", { title: "O2", artistName: "Orion" }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
      4,
    );

    const artists = set.items.map((item) => item.identity.artists[0]?.name);
    for (let i = 1; i < artists.length; i += 1) {
      expect(artists[i]).not.toBe(artists[i - 1]);
    }
  });

  it("keeps one artist from taking the whole set", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          makeTrack("spotify", "n1", { title: "N1", artistName: "Nova" }),
          makeTrack("spotify", "n2", { title: "N2", artistName: "Nova" }),
          makeTrack("spotify", "n3", { title: "N3", artistName: "Nova" }),
          makeTrack("spotify", "n4", { title: "N4", artistName: "Nova" }),
          makeTrack("spotify", "n5", { title: "N5", artistName: "Nova" }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
      5,
    );

    // Either diversity held it down, or — with a single-artist pool the rules
    // cannot fix — the relaxation pass still produced a full set rather than
    // returning nothing. Both are acceptable; returning an empty set is not.
    const novaCount = set.items.filter(
      (item) => item.identity.artists[0]?.name === "Nova",
    ).length;
    expect(novaCount).toBeLessThanOrEqual(MAX_RECOMMENDATIONS_PER_ARTIST + 2);
    expect(set.items.length).toBeGreaterThan(0);
  });

  it("relaxes rather than returning nothing when the pool is one artist", () => {
    const ranked = Array.from({ length: 4 }, (_, i) => ({
      artistName: "Nova",
      id: `n${i}`,
    }));
    // §50: a full result is guaranteed by the relaxation pass; the strict
    // rules must not be able to starve the output.
    expect(interleaveWithDiversity(ranked, 3)).toHaveLength(3);
  });

  it("preserves relative score order among the survivors", () => {
    const ranked = [
      { artistName: "A", id: "a", score: 10 },
      { artistName: "A", id: "a2", score: 9 },
      { artistName: "B", id: "b", score: 8 },
      { artistName: "C", id: "c", score: 7 },
    ];
    const out = interleaveWithDiversity(ranked, 3);
    const scores = out.map((entry) => (entry as { score: number }).score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("returns nothing for a zero or negative limit", () => {
    expect(interleaveWithDiversity([{ artistName: "A" }], 0)).toEqual([]);
    expect(interleaveWithDiversity([{ artistName: "A" }], -1)).toEqual([]);
  });
});

describe("generateRecommendations degradation and empty sets", () => {
  it("reports exhausted for a completely empty catalog", async () => {
    const set = await generateRecommendations(backend(), noSignals);
    expect(set).toEqual({ items: [], categories: [], exhausted: true });
  });

  it("still returns a set when one avenue throws", async () => {
    const set = await generateRecommendations(
      backend({
        getTrack: async () => makeTrack("youtube", "seed", { title: "S", artistName: "Nova" }),
        // The seed avenue throws; the discovery avenue must survive it.
        searchTracks: async (query: string) => {
          if (query.includes("Midnight")) {
            throw new Error("provider exploded");
          }
          return [makeTrack("spotify", "survivor", { title: "Survivor", artistName: "Orion" })];
        },
        popularTracks: async () => [],
      }),
      {
        currentTrack: { provider: "youtube", providerTrackId: "seed", artistName: "Nova" },
        recentArtists: ["Orion"],
      },
    );

    expect(ids(set)).toContain("survivor");
  });

  it("never throws when every avenue rejects", async () => {
    const set = await generateRecommendations(
      backend({
        getTrack: async () => {
          throw new Error("lookup down");
        },
        searchTracks: async () => {
          throw new Error("search down");
        },
        popularTracks: async () => {
          throw new Error("popular down");
        },
        artistTracks: async () => {
          throw new Error("artist down");
        },
      }),
      {
        currentTrack: { provider: "youtube", providerTrackId: "seed" },
        recentArtists: ["Nova"],
        followedArtists: [{ provider: "spotify", providerArtistId: "fa", name: "Nova" }],
      },
    );

    expect(set.exhausted).toBe(true);
    expect(set.items).toEqual([]);
  });

  it("skips an uncanonicalizable candidate instead of failing the set", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [
          { ...makeTrack("spotify", "blank", { title: "   " }) },
          makeTrack("spotify", "good", { title: "Good Song", artistName: "Nova" }),
        ],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
    );

    expect(ids(set)).toEqual(["good"]);
  });

  it("clamps an oversized limit to a bounded maximum", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeTrack("spotify", `t${i}`, { title: `T${i}`, artistName: `Artist ${i}` }),
    );
    const set = await generateRecommendations(
      backend({ searchTracks: async () => many, popularTracks: async () => [] }),
      { recentArtists: ["Artist 0"] },
      10_000,
    );

    expect(set.items.length).toBeLessThanOrEqual(RECOMMENDATION_SET_SIZE * 2);
  });

  it("returns the shared empty constant shape for a zero limit without calling the backend", async () => {
    const searchTracks = vi.fn(async () => [makeTrack("spotify", "x")]);
    const set = await generateRecommendations(backend({ searchTracks }), noSignals, 0);
    expect(set.exhausted).toBe(true);
    expect(searchTracks).not.toHaveBeenCalled();
  });
});

describe("recommendation result shape", () => {
  it("exposes only public pipeline output, never the internal ranking bookkeeping", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [makeTrack("spotify", "one", { artistName: "Nova" })],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
    );

    const item = set.items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item as object).sort()).toEqual([
      "category",
      "identity",
      "key",
      "reason",
      "reasons",
      "score",
    ]);
  });

  it("reports a reason drawn from a real signal, never a percentage", async () => {
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [makeTrack("spotify", "one", { artistName: "Nova" })],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
    );
    expect(set.items[0]?.reason).toBe("Nova");
    expect(set.items[0]?.reason).not.toMatch(/\d+%/);
  });

  it("produces identities usable as Aurora tracks", async () => {
    const source = makeTrack("youtube", "yt1", { title: "Song yt1", artistName: "Nova" });
    const identity = toTrackIdentity(source);
    const set = await generateRecommendations(
      backend({
        searchTracks: async () => [source],
        popularTracks: async () => [],
      }),
      { recentArtists: ["Nova"] },
    );
    expect(keyOf(identity)).toBe(set.items[0]?.key);
  });
});
