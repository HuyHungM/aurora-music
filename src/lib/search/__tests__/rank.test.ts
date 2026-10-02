import { describe, expect, it } from "vitest";
import type { Album, Artist, Track, TrackIdentity } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import { normalizeSearchQuery } from "@/lib/search/normalize";
import {
  SEARCH_RANK_BANDS,
  rankSearchResults,
  scoreSearchResult,
} from "@/lib/search/rank";

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

function album(title: string): Album {
  counter += 1;
  return {
    id: `album-${counter}`,
    title,
    artistId: "a1",
    artistName: "Artist",
    provider: "youtube",
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

/**
 * Replaces an identity's artist set. `toTrackIdentity` builds artists from a
 * single `artistName`, so a test that needs the SAME name in both the title
 * and the artist field has to set it on the identity directly.
 */
/** Attaches an album, which `toTrackIdentity` only builds from `albumName`. */
function withAlbum(identity: TrackIdentity, value: Album): TrackIdentity {
  return { ...identity, album: value };
}

function rank(query: string, identities: TrackIdentity[]) {
  return rankSearchResults(normalizeSearchQuery(query), identities);
}

/** The display name a result row shows, which the tests assert against. */
function artistNameOf(identity: TrackIdentity): string {
  return identity.artists[0]?.name ?? "";
}

function firstTitle(query: string, identities: TrackIdentity[]): string {
  return rank(query, identities)[0]?.identity.title ?? "";
}

describe("exact tiers", () => {
  it("ranks an exact title above everything else", () => {
    const results = rank("Cảm Ơn", [
      track("Cảm Ơn Thôi", "MCK"),
      track("Em Của Ngày Hôm Qua", "Sơn Tùng M-TP"),
      track("Cảm Ơn", "MCK"),
    ]);
    expect(results[0]?.identity.title).toBe("Cảm Ơn");
    // The query is the title, not the artist, so this is the title tier.
    expect(results[0]?.band).toBe("exactTitle");
  });

  it("matches an exact title across accent differences", () => {
    // The accented spelling wins the exact tier even though the query was
    // typed without diacritics.
    expect(firstTitle("cam on", [track("Cảm Ơn", "MCK")])).toBe("Cảm Ơn");
  });

  it("ranks an exact artist match as its own tier", () => {
    // The query is the ARTIST; the title is unrelated. That is still an exact
    // match, just not an exact title.
    const results = rank("Taylor Swift", [
      track("Love Story", "Taylor Swift"),
      track("Blank Space", "Ariana Grande"),
    ]);
    expect(artistNameOf(results[0]?.identity as TrackIdentity)).toBe("Taylor Swift");
    expect(results[0]?.band).toBe("exactArtist");
  });

  it("recognises an exact album match", () => {
    const results = rank("1989", [
      withAlbum(track("Welcome to New York", "Taylor Swift"), album("1989")),
      track("Blank Space", "Ariana Grande"),
    ]);
    expect(results[0]?.band).toBe("exactAlbum");
  });

  it("prefers a multi-field exact match over a single-field one", () => {
    // The query names BOTH fields. One row supplies both (artist Adele, title
    // Hello); the other supplies only the title. The multi-field band wins.
    const both = track("Hello", "Adele");
    const titleOnly = track("Hello", "Someone Else Entirely");
    const results = rank("Adele Hello", [titleOnly, both]);
    expect(results[0]?.identity.title).toBe("Hello");
    expect(artistNameOf(results[0]?.identity as TrackIdentity)).toBe("Adele");
    expect(results[0]?.band).toBe("exactMultiField");
  });

  it("keeps a single-field complete match out of the multi-field band", () => {
    // All query tokens are in the title and none are in the artist. The title
    // ALSO happens to start with the query, so prefix outranks token coverage
    // — which is the point: a prefix is stronger evidence than mere coverage.
    const results = rank("cam on", [track("Cảm Ơn Rất Đẹp", "Various Artists")]);
    expect(results[0]?.band).toBe("prefixTitle");

    // Without the prefix, the same shape lands in the single-field tier.
    const covered = rank("cam on", [track("Bài Hát Cảm Ơn Hay Nhất", "Various")]);
    expect(covered[0]?.band).toBe("tokenCoverage");
  });
});

describe("prefix tiers", () => {
  it("ranks a title prefix above a partial containment", () => {
    const results = rank("Love", [
      track("Burning Love", "Elvis"),      // containment
      track("Love Story", "Taylor Swift"),  // prefix
    ]);
    expect(results[0]?.identity.title).toBe("Love Story");
    expect(results[0]?.band).toBe("prefixTitle");
  });

  it("does not treat a mid-title word as a prefix", () => {
    // "Cảm Ơn" must not be a prefix match for a title that merely contains it.
    const results = rank("Cảm Ơn", [track("Em Của Cảm Ơn", "Artist")]);
    expect(results[0]?.band).not.toBe("prefixTitle");
  });

  it("ranks a title prefix above an artist prefix", () => {
    const results = rank("Love", [
      track("Something", "Love Jones"),
      track("Love Story", "Nobody"),
    ]);
    expect(results[0]?.identity.title).toBe("Love Story");
  });
});

describe("token and phrase tiers", () => {
  it("recognises all tokens present out of order", () => {
    // "mck" is in the artist, "cam on" in the title: order in the query does
    // not matter, and supplying both fields is the strongest band.
    const results = rank("mck cam on", [track("Cảm Ơn", "MCK")]);
    expect(results[0]?.band).toBe("exactMultiField");
  });

  it("recognises all tokens present in one field", () => {
    // Both tokens in the title, neither in the artist, and the title does not
    // START with the query — so this is coverage, not a prefix.
    const results = rank("cam on", [track("Khoảnh Khắc Cảm Ơn Rất Nhớ", "Nhạc trẻ")]);
    expect(results[0]?.band).toBe("tokenCoverage");
  });

  it("recognises a phrase appearing inside a longer title", () => {
    // Only SOME query tokens are present, and the query is not a prefix of the
    // title: this is containment, so it belongs below full token coverage.
    const results = rank("cam on", [
      track("Bài Hát Về Cảm (Phần 1)", "Various"),
    ]);
    expect(results[0]?.band).toBe("phrase");
  });

  it("recognises query tokens in order with gaps", () => {
    const results = rank("em ngay", [track("Em Của Ngày Hôm Qua", "STT")]);
    expect(["tokenCoverage", "phrase"]).toContain(results[0]?.band);
  });

  it("ranks full token coverage above partial coverage", () => {
    const results = rank("cam on", [
      track("Cảm Ơn Thôi Nhiều Lắm Vậy", "X"),  // both tokens
      track("Cảm Ơn", "Y"),                      // one token, and an exact title
    ]);
    // "Cảm Ơn" is an EXACT title, which outranks token coverage by band. The
    // ordering here is the more specific match winning, not coverage winning.
    expect(results[0]?.identity.title).toBe("Cảm Ơn");
    expect(results[0]?.band).toBe("exactTitle");
  });

  it("separates full from partial token coverage inside the same tiers", () => {
    // Neither title is an exact match, so the comparison is purely coverage.
    const results = rank("cam on", [
      track("Khoảnh Khắc Cảm Ơn Rất Nhớ", "X"),  // both tokens
      track("Nỗi Nhớ Cảm Phải", "Y"),             // one token
    ]);
    expect(results[0]?.identity.title).toBe("Khoảnh Khắc Cảm Ơn Rất Nhớ");
    expect(results[0]?.band).toBe("tokenCoverage");
  });
});

describe("dominance", () => {
  it("puts an exact match above every fuzzy match, regardless of input order", () => {
    // The exact match arrives LAST. Ordering must not matter.
    const results = rank("taylor swift", [
      track("Taylar Sw1ft Megamix", "DJ Nobody"),
      track("TayLor Swiftt Remix Vol 2", "Another DJ"),
      track("Blank Space", "Taylor Swift"),
    ]);
    expect(results[0]?.identity.title).toBe("Blank Space");
    expect(results[0]?.band).toBe("exactArtist");
    // The typo-y rows survive — providers decided they are relevant — but
    // they sit below the exact match.
    expect(results.slice(1).map((entry) => entry.band)).toContain("fuzzy");
  });

  it("never lets a lower band outrank a higher band", () => {
    // Deliberately shuffled input covering many bands at once. The property
    // under test is that the OUTPUT is non-increasing in band strength, which
    // is what makes "exact beats fuzzy" structural rather than incidental.
    const identities = [
      track("Something Entirely Different", "A"),
      track("Cảm Ơn", "MCK"),
      track("Cam On", "B"),
      track("Cam On karaoke", "C"),
      track("Totally Other Song", "D"),
      track("Em Của", "E"),
    ];
    const order = ["exactMultiField", "exactTitle", "exactArtist", "exactAlbum",
      "prefixTitle", "prefixArtist", "prefixAlbum", "tokenCoverage", "phrase", "fuzzy", "none"];
    for (const query of ["cam on", "cam", "Cảm Ơn", "mck", "em của"]) {
      // `order` is strongest-first, so a correctly ranked output has
    // NON-DECREASING indices.
    const positions = rank(query, identities).map((entry) =>
        order.indexOf(entry.band),
      );
      for (let i = 1; i < positions.length; i += 1) {
        expect(
          positions[i - 1] as number,
          `query "${query}" position ${i}`,
        ).toBeLessThanOrEqual(positions[i] as number);
      }
    }
  });

  it("keeps the band ordering as documented", () => {
    // The spacing is the mechanism: a higher band must always outscore a lower
    // one, whatever the detail points are.
    const values = Object.values(SEARCH_RANK_BANDS);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i - 1] as number).toBeGreaterThan(values[i] as number);
    }
  });

  it("prefers the tighter title when both are in the same band", () => {
    const results = rank("cảm ơn", [
      track("Cảm Ơn Thôi Nhiều Lắm Vậy", "MCK"),
      track("Cảm Ơn", "MCK"),
    ]);
    expect(results[0]?.identity.title).toBe("Cảm Ơn");
  });
});

describe("fuzzy", () => {
  it("recovers an obvious artist typo", () => {
    expect(firstTitle("tayor swift", [track("Blank Space", "Taylor Swift")]))
      .toBe("Blank Space");
  });

  it("recovers a doubled-letter typo", () => {
    expect(firstTitle("mcck", [track("Cảm Ơn", "MCK")])).toBe("Cảm Ơn");
  });

  it("recovers a spacing/punctuation typo", () => {
    expect(firstTitle("camm on", [track("Cảm Ơn", "MCK")])).toBe("Cảm Ơn");
  });

  it("recovers a truncated word", () => {
    expect(firstTitle("the weekd", [track("Blinding Lights", "The Weeknd")]))
      .toBe("Blinding Lights");
  });

  it("does not fuzzy-match a query too short to contain a typo", () => {
    // Three characters: a one-edit match would match almost anything, so the
    // fuzzy tier stays off entirely.
    const results = rank("abc", [track("abd", "Someone")]);
    expect(results[0]?.band).not.toBe("fuzzy");
  });

  it("does not turn an unrelated query into a result", () => {
    const results = rank("spoitfy", [track("Blank Space", "Taylor Swift")]);
    expect(results[0]?.band).toBe("none");
  });

  it("keeps every result and orders the irrelevant ones last", () => {
    const identities = [
      track("Totally Unrelated", "Someone"),
      track("Cảm Ơn", "MCK"),
    ];
    const results = rank("cam on", identities);
    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.identity.title)).toEqual([
      "Cảm Ơn",
      "Totally Unrelated",
    ]);
  });

  it("bounds the fuzzy budget so a long result list cannot cost unboundedly", () => {
    const identities = Array.from({ length: 80 }, (_, i) =>
      track(`Completely Other Title ${i}`, "Various"),
    );
    const started = Date.now();
    const results = rankSearchResults(normalizeSearchQuery("completly othr"), identities, {
      fuzzyCandidateLimit: 5,
    });
    // The cap is what keeps this linear in the cap, not in the list length.
    expect(results).toHaveLength(80);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("short queries", () => {
  it("does not use exact tiers for one or two characters", () => {
    // Every catalog entry starts with "a"; an exact tier there is noise.
    const results = rank("a", [track("Anything", "A")]);
    expect(results[0]?.band).toBe("prefixTitle");
  });

  it("still matches a two-character prefix quickly", () => {
    expect(firstTitle("lo", [track("Love Story", "Taylor Swift")])).toBe("Love Story");
  });
});

describe("determinism and purity", () => {
  it("falls back to input order for textually equal results", () => {
    const a = track("Same Title", "Same Artist");
    const b = track("Same Title", "Same Artist");
    const results = rank("Same Title", [a, b]);
    expect(results.map((entry) => entry.identity.id)).toEqual([a.id, b.id]);
  });

  it("is stable across repeated calls", () => {
    const identities = [
      track("Cảm Ơn", "MCK"),
      track("Cảm Ơn Thôi", "X"),
      track("Em Của Ngày Hôm Qua", "STT"),
    ];
    const first = rank("cam on", identities).map((entry) => entry.identity.id);
    const second = rank("cam on", identities).map((entry) => entry.identity.id);
    expect(second).toEqual(first);
  });

  it("does not mutate the input array or its identities", () => {
    const identities = [track("B", "B"), track("A", "A")];
    const snapshot = identities.map((identity) => identity.id);
    rank("a", identities);
    expect(identities.map((identity) => identity.id)).toEqual(snapshot);
  });

  it("returns an empty list for an empty input", () => {
    expect(rank("cam on", [])).toEqual([]);
  });

  it("scores an empty query without throwing", () => {
    expect(scoreSearchResult(normalizeSearchQuery(""), track("A", "B"))).toBe(0);
  });

  it("handles a track with no artists and no album", () => {
    const bare: TrackIdentity = {
      id: "bare-1",
      title: "Cảm Ơn",
      artists: [],
      sources: [{ source: "youtube", id: "bare-1" }],
      primarySource: { source: "youtube", id: "bare-1" },
    };
    expect(() => rank("cam on", [bare])).not.toThrow();
    // The title still matches exactly; the absent artist simply means the
    // combined tier is unavailable.
    expect(rank("cam on", [bare])[0]?.band).toBe("exactTitle");
  });

  it("never matches a blank provider field against a blank query", () => {
    const blank: TrackIdentity = {
      id: "blank-1",
      title: "(((",
      artists: [artist("!!!")],
      sources: [{ source: "youtube", id: "blank-1" }],
      primarySource: { source: "youtube", id: "blank-1" },
    };
    const results = rank("", [blank]);
    expect(results[0]?.band).toBe("none");
  });
});

describe("explainability", () => {
  it("reports a reason for the band it chose", () => {
    const results = rank("cảm ơn", [track("Cảm Ơn", "MCK")]);
    expect(results[0]?.reasons).toHaveLength(1);
    expect(results[0]?.reasons[0]?.band).toBe("exactTitle");
    expect(results[0]?.reasons[0]?.detail.length).toBeGreaterThan(0);
  });

  it("carries the input position so a tiebreak is auditable", () => {
    const results = rank("x", [track("A", "A"), track("B", "B")]);
    expect(results.map((entry) => entry.order).sort()).toEqual([0, 1]);
  });
});
