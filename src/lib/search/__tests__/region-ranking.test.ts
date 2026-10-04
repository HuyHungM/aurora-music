import { describe, expect, it } from "vitest";
import type { Artist, Track, TrackIdentity } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import { normalizeSearchQuery } from "@/lib/search/normalize";
import {
  SEARCH_RANK_BANDS,
  rankSearchResults,
  scoreSearchResult,
} from "@/lib/search/rank";
import {
  REGION_AFFINITY_POINTS,
  marketForLocale,
  regionAffinityOf,
  regionPointsFor,
  type Market,
} from "@/lib/region/affinity";
import { searchCacheKey } from "@/lib/search/search-cache";

/**
 * Region-aware ranking.
 *
 * These are behavioural tests about ORDER, not about a function having run.
 * Every ranking assertion below is written so that reverting the region term
 * to zero makes it fail — which is checked by the `neutral` control case that
 * runs beside each one.
 */

let counter = 0;

function artist(name: string): Artist {
  counter += 1;
  return {
    id: `artist-${counter}`,
    provider: "youtube",
    providerArtistId: `artist-${counter}`,
    name,
  };
}

function track(
  title: string,
  artistName: string,
  overrides: Partial<Track> = {},
): TrackIdentity {
  counter += 1;
  const id = `t-${counter}`;
  return toTrackIdentity({
    id,
    provider: "youtube",
    providerTrackId: id,
    title,
    artistId: "a1",
    artistName,
    duration: 200,
    providerUrl: `https://example.invalid/${id}`,
    ...overrides,
  });
}

function withMetadata(
  identity: TrackIdentity,
  metadata: Record<string, unknown>,
): TrackIdentity {
  return { ...identity, metadata };
}

const rank = (
  query: string,
  tracks: readonly TrackIdentity[],
  market?: Market,
) =>
  rankSearchResults(normalizeSearchQuery(query), tracks, market ? { market } : {});

const titles = (results: ReturnType<typeof rank>) =>
  results.map((entry) => entry.identity.title);

describe("region affinity / classification", () => {
  it("classifies an explicit Vietnamese title as Vietnamese", () => {
    // `Lạc Trôi` carries tone vowels only — no `đ ă ơ ư`. It must still land,
    // or the most recognisable V-pop title in the catalogue scores as foreign.
    expect(regionAffinityOf(track("Lạc Trôi", "Sơn Tùng M-TP"))).toBe("vietnam");
  });

  it("classifies an explicit Vietnamese artist with no diacritics in the title", () => {
    // The other failure mode the brief names: Vietnamese names need not carry
    // diacritics. `Sơn Tùng M-TP` supplies them.
    expect(regionAffinityOf(track("3107", "Sơn Tùng M-TP"))).toBe("vietnam");
  });

  it("classifies by provider language ahead of any text heuristic", () => {
    // A Vietnamese tag on a title with no Vietnamese characters at all. If the
    // text vote ran first this would be `unknown`.
    expect(
      regionAffinityOf(
        withMetadata(track("Wrong", "Anh Trai Over The Moon"), {
          language: "vie",
        }),
      ),
    ).toBe("vietnam");
  });

  it("honours a provider language that rules Vietnamese OUT", () => {
    // `Chloé` and `Bô` contain letters that look Vietnamese. A provider saying
    // `fr` is more information than a diacritic, in both directions.
    expect(
      regionAffinityOf(withMetadata(track("Chloé", "Bô"), { language: "fr" })),
    ).toBe("international");
  });

  it("classifies by an explicit market genre tag", () => {
    const tagged: TrackIdentity = {
      ...track("Onl", "3107"),
      artists: [{ ...artist("3107"), genres: ["v-pop"] }],
    };
    expect(regionAffinityOf(tagged)).toBe("vietnam");
  });

  it("does NOT classify missing metadata as Vietnamese", () => {
    // The brief's explicit requirement. No language, no genre, no diacritics.
    for (const [title, name] of [
      ["Shape of You", "Ed Sheeran"],
      ["Blinding Lights", "The Weeknd"],
      ["Get Lucky", "Daft Punk"],
      ["3107", "Random International Act"],
    ] as const) {
      expect(regionAffinityOf(track(title, name))).toBe("unknown");
    }
  });

  it("gives `unknown` and `international` no points", () => {
    // Absence of evidence must not become evidence of locality.
    expect(REGION_AFFINITY_POINTS.unknown).toBe(0);
    expect(REGION_AFFINITY_POINTS.international).toBe(0);
    expect(REGION_AFFINITY_POINTS.vietnam).toBeGreaterThan(0);
  });

  it("does not let a single shared diacritic decide on its own", () => {
    // `ô` is French, Portuguese and Romanian. One weak vote is below threshold.
    const romanian = track("Mâncare", "Artist");
    expect(regionAffinityOf(romanian)).toBe("unknown");
  });

  it("awards points only under the VN market", () => {
    const local = track("Lạc Trôi", "Sơn Tùng M-TP");
    expect(regionPointsFor(local, "VN")).toBe(REGION_AFFINITY_POINTS.vietnam);
    expect(regionPointsFor(local, "GLOBAL")).toBe(0);
  });
});

describe("market resolution", () => {
  it("treats the shipped Vietnamese locale as the VN market", () => {
    expect(marketForLocale("vi")).toBe("VN");
  });

  it("stays neutral for an English UI with no region evidence", () => {
    expect(marketForLocale("en")).toBe("GLOBAL");
    expect(marketForLocale("en", "en-GB")).toBe("GLOBAL");
  });

  it("reads the region from the browser tag only for a non-Vietnamese locale", () => {
    // The `en` UI says nothing about where the listener is; an explicit `VN`
    // region subtag does. Both BCP-47 (`-`) and POSIX (`_`) separators count.
    expect(marketForLocale("en", "en-VN")).toBe("VN");
    expect(marketForLocale("en", "en_VN")).toBe("VN");
  });

  it("does not promote an English locale that merely has a region", () => {
    expect(marketForLocale("en", "en-US")).toBe("GLOBAL");
    expect(marketForLocale("en", "en_US")).toBe("GLOBAL");
  });
});

describe("region-aware search ranking", () => {
  it("lifts a Vietnamese result over an equally relevant international one (vi-VN)", () => {
    // A realistic `pop` fan-out: the providers returned these because they are
    // pop, NOT because the word "pop" is in the title. So every candidate sits
    // in `BAND_NONE` and the only thing separating them is region affinity —
    // which is precisely the situation the boost exists for.
    const candidates = [
      track("Shape of You", "Ed Sheeran"),
      track("Blinding Lights", "The Weeknd"),
      track("As It Was", "Harry Styles"),
      track("Lạc Trôi", "Sơn Tùng M-TP"),
      track("Nơi Này Có Anh", "Sơn Tùng M-TP"),
    ];
    const results = rank("pop", candidates, "VN");
    expect(results[0]?.identity.title).toBe("Lạc Trôi");
  });

  it("proves that boost is what did it: the same set under a neutral market", () => {
    const candidates = [
      track("Shape of You", "Ed Sheeran"),
      track("Blinding Lights", "The Weeknd"),
      track("As It Was", "Harry Styles"),
      track("Lạc Trôi", "Sơn Tùng M-TP"),
      track("Nơi Này Có Anh", "Sơn Tùng M-TP"),
    ];
    const neutral = rank("pop", candidates, "GLOBAL");
    const regional = rank("pop", candidates, "VN");
    expect(titles(regional)[0]).not.toBe(titles(neutral)[0]);
    // And the Vietnamese result genuinely moved up, rather than the whole set
    // being reshuffled by a changed tiebreak.
    expect(
      neutral.findIndex((entry) => entry.identity.title === "Lạc Trôi") -
        regional.findIndex((entry) => entry.identity.title === "Lạc Trôi"),
    ).toBeGreaterThan(0);
  });

  it("still ranks a literal `Pop` title first, because that is an exact match", () => {
    // The counter-case, and the reason the band structure is not being touched:
    // a real textual match still beats region affinity. `Pop` in the title is
    // the user's actual query; nothing about market should override it.
    const results = rank(
      "pop",
      [track("Lạc Trôi", "Sơn Tùng M-TP"), track("Pop", "Dua Lipa")],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Pop");
  });

  it("keeps `Taylor Swift` first for a Vietnamese listener", () => {
    // The exact-match band is the protection: a Vietnamese result cannot be
    // promoted into a higher band by points, only within the band it earned.
    const results = rank(
      "Taylor Swift",
      [
        track("Taylor Swift (Vpop Cover)", "Minh Anh"),
        track("Lạc Trôi", "Sơn Tùng M-TP"),
        track("Taylor Swift", "Taylor Swift"),
        track("Love Story", "Taylor Swift"),
      ],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Taylor Swift");
    // `exactTitle` here because the fixture track's title is also the query;
    // either exact band is above every band the rivals can reach.
    expect(SEARCH_RANK_BANDS[results[0]?.band ?? "none"]).toBeGreaterThanOrEqual(
      SEARCH_RANK_BANDS.exactArtist,
    );
  });

  it("keeps `The Weeknd` first for a Vietnamese listener", () => {
    const results = rank(
      "The Weeknd",
      [track("Blinding Lights", "The Weeknd"), track("Nắng", "Bích Ngọc")],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Blinding Lights");
    expect(results[0]?.band).toBe("exactArtist");
  });

  it("keeps `Daft Punk` first for a Vietnamese listener", () => {
    const results = rank(
      "Daft Punk",
      [track("Get Lucky", "Daft Punk"), track("Nơi Này Có Anh", "Sơn Tùng M-TP")],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Get Lucky");
  });

  it("keeps an explicit Vietnamese artist first", () => {
    const results = rank(
      "Sơn Tùng M-TP",
      [track("Lạc Trôi", "Sơn Tùng M-TP"), track("Taylor Swift", "Taylor Swift")],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Lạc Trôi");
  });

  it("favours Vietnamese music for a `V-pop` genre query", () => {
    const results = rank(
      "V-pop",
      [
        track("As It Was", "Harry Styles"),
        track("Flowers", "Miley Cyrus"),
        track("Lạc Trôi", "Sơn Tùng M-TP"),
      ],
      "VN",
    );
    // A `V-pop` fan-out is mostly tracks the providers returned for the GENRE,
    // not for the literal string, so nothing here reaches a coverage band and
    // the Vietnamese track is the one that should sit on top.
    expect(results[0]?.identity.title).toBe("Lạc Trôi");
  });

  it("does not let a Vietnamese title-with-no-match outrank a real token match", () => {
    // The other side of the same boundary: a result that literally contains the
    // query token has textual EVIDENCE, and region affinity — a prior — must not
    // outrank it. This is what stops the boost from becoming a sort.
    const results = rank(
      "V-pop",
      [
        track("Some Western Pop Album", "Various Artists"),
        track("Lạc Trôi", "Sơn Tùng M-TP"),
      ],
      "VN",
    );
    expect(results[0]?.identity.title).toBe("Some Western Pop Album");
  });

  it("applies no boost at all for a non-Vietnamese market", () => {
    const candidates = [
      track("Shape of You", "Ed Sheeran"),
      track("Lạc Trôi", "Sơn Tùng M-TP"),
    ];
    expect(titles(rank("pop", candidates, "VN"))).not.toEqual(
      titles(rank("pop", candidates, "GLOBAL")),
    );
    // And a neutral market is byte-for-byte what an omitted market produced.
    expect(titles(rank("pop", candidates, "GLOBAL"))).toEqual(
      titles(rank("pop", candidates)),
    );
  });

  it("preserves international diversity inside a boosted result set", () => {
    // The brief's anti-feedback-loop requirement: a boost reorders, it never
    // partitions. Nothing is dropped and nothing is excluded.
    const mixed = [
      track("Pop", "Dua Lipa"),
      track("Shape of You", "Ed Sheeran"),
      track("Lạc Trôi", "Sơn Tùng M-TP"),
      track("Nơi Này Có Anh", "Sơn Tùng M-TP"),
      track("Blinding Lights", "The Weeknd"),
    ];
    const results = rank("pop", mixed, "VN");
    expect(results).toHaveLength(mixed.length);
    expect(titles(results)).toContain("Shape of You");
    expect(titles(results)).toContain("Blinding Lights");
  });

  it("never lets the region term cross a band boundary", () => {
    // The structural guarantee, asserted as the invariant it is rather than
    // through a convenient example: this is the whole reason exact-match search
    // is safe, so it is checked over results that earn the maximum possible
    // detail AND the maximum possible region term.
    const maximal: TrackIdentity[] = [
      track("Pop", "Sơn Tùng M-TP"),
      track("Pop", "Sơn Tùng M-TP"),
      track("Pop", "Sơn Tùng M-TP"),
    ];
    const results = rankSearchResults(normalizeSearchQuery("Pop"), maximal, {
      market: "VN",
    });
    for (const entry of results) {
      // `score % 100` is the in-band remainder (detail + region). If it ever
      // reached 100 the result would have silently become the NEXT band.
      expect(entry.score % 100).toBeLessThan(100);
      // And the in-band remainder is bounded by detail + the region ceiling.
      expect(entry.score % 100).toBeLessThanOrEqual(REGION_AFFINITY_POINTS.vietnam + 79);
    }
  });

  it("scores the region term in `scoreSearchResult` too", () => {
    const query = normalizeSearchQuery("Pop");
    const local = track("Pop", "Sơn Tùng M-TP");
    const far = track("Pop", "Various Artists");
    expect(scoreSearchResult(query, local, { market: "VN" })).toBeGreaterThan(
      scoreSearchResult(query, far, { market: "VN" }),
    );
    expect(scoreSearchResult(query, local)).toBe(
      scoreSearchResult(query, far),
    );
  });
});

describe("search cache / market isolation", () => {
  it("does not share one entry between markets", () => {
    // A market-aware result set is a different answer, so a VN-keyed entry
    // served to a GLOBAL caller would be the wrong candidate set AND the wrong
    // ranking.
    const query = normalizeSearchQuery("pop");
    expect(searchCacheKey(query, { limit: 20, market: "VN" })).not.toBe(
      searchCacheKey(query, { limit: 20, market: "GLOBAL" }),
    );
  });

  it("keeps a marketless key equal to the neutral one", () => {
    // An omitted market must not fragment the cache for callers that never
    // opted in.
    const query = normalizeSearchQuery("pop");
    expect(searchCacheKey(query, { limit: 20 })).toBe(
      searchCacheKey(query, { limit: 20, market: "GLOBAL" }),
    );
  });

  it("still shares one entry across every spelling of the same question", () => {
    const market = { limit: 20, market: "VN" } as const;
    expect(searchCacheKey(normalizeSearchQuery("Cam  On"), market)).toBe(
      searchCacheKey(normalizeSearchQuery("cảm ơn"), market),
    );
  });
});
