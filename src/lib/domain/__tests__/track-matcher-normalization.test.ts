import { describe, expect, it } from "vitest";
import {
  compareVersions,
  foldDiacritics,
  identityIsrcs,
  normalizeArtistName,
  normalizeBase,
  normalizeIsrc,
  parseTitleVersion,
  tokenOverlap,
  tokenize,
} from "@/lib/domain/match-text";

describe("normalizeBase", () => {
  it("handles case, whitespace, punctuation, and unicode", () => {
    expect(normalizeBase("  Lạc   TRÔI ")).toBe("lạc trôi");
    expect(normalizeBase("Harder, Better, Faster, Stronger!")).toBe(
      "harder better faster stronger",
    );
    expect(normalizeBase("“Quoted” — Title")).toBe("quoted title");
    expect(normalizeBase("é")).toBe("é");
  });
});

describe("foldDiacritics", () => {
  it("folds combining marks and đ minimally", () => {
    expect(foldDiacritics("lạc trôi")).toBe("lac troi");
    expect(foldDiacritics("đen")).toBe("den");
    expect(foldDiacritics("beyoncé")).toBe("beyonce");
  });
});

describe("normalizeArtistName", () => {
  it("normalizes case and spacing without transliterating", () => {
    expect(normalizeArtistName("  Sơn Tùng M-TP ")).toBe("sơn tùng m tp");
    expect(normalizeArtistName("SON TUNG M-TP")).toBe("son tung m tp");
  });
});

describe("parseTitleVersion", () => {
  it("extracts live markers from brackets and dash suffixes", () => {
    expect(parseTitleVersion("Song (Live)").kinds).toEqual(["live"]);
    expect(parseTitleVersion("Song - Live").kinds).toEqual(["live"]);
    expect(parseTitleVersion("Song [Acoustic]").kinds).toEqual(["acoustic"]);
    expect(parseTitleVersion("Song (Remix)").kinds).toEqual(["remix"]);
    expect(parseTitleVersion("Song - Club Mix").kinds).toEqual(["remix"]);
    expect(parseTitleVersion("Song (Sped Up)").kinds).toEqual(["sped"]);
    expect(parseTitleVersion("Song (Slowed + Reverb)").kinds).toEqual(["sped"]);
    expect(parseTitleVersion("Song (Nightcore)").kinds).toEqual(["sped"]);
    expect(parseTitleVersion("Song (Karaoke)").kinds).toEqual(["karaoke"]);
    expect(parseTitleVersion("Song (Cover)").kinds).toEqual(["cover"]);
    expect(parseTitleVersion("Song (Demo)").kinds).toEqual(["demo"]);
    expect(parseTitleVersion("Song (2024 Remaster)").kinds).toEqual(["remaster"]);
    expect(parseTitleVersion("Song (Instrumental)").kinds).toEqual(["instrumental"]);
  });

  it("separates base title from markers", () => {
    const parsed = parseTitleVersion("Lạc Trôi (Live)");
    expect(parsed.base).toBe("lạc trôi");
    expect(parsed.kinds).toEqual(["live"]);
  });

  it("extracts feature annotations without version judgment", () => {
    const parsed = parseTitleVersion("Song (feat. Artist B)");
    expect(parsed.base).toBe("song");
    expect(parsed.kinds).toEqual([]);
    expect(parsed.features).toEqual(["artist b"]);
    expect(parseTitleVersion("Song - ft. B").features).toEqual(["b"]);
    // Bare feature words in a main title are never reinterpreted.
    expect(parseTitleVersion("Song ft. B").features).toEqual([]);
    expect(parseTitleVersion("Song ft. B").base).toBe("song ft b");
  });

  it("treats standard markers as unmarked", () => {
    expect(parseTitleVersion("Song (Original Mix)").kinds).toEqual([]);
    expect(parseTitleVersion("Song - Album Version").base).toBe("song");
  });

  it("keeps hyphenated titles and unknown annotations intact", () => {
    expect(parseTitleVersion("Spider-Man").base).toBe("spider man");
    const parsed = parseTitleVersion("Song (Album Mix)");
    expect(parsed.kinds).toEqual([]);
    expect(parsed.base).toContain("album mix");
    expect(parsed.others).toEqual(["album mix"]);
  });

  it("keeps non-marker dash suffixes in the base", () => {
    expect(parseTitleVersion("Song - Pt. 2").base).toContain("pt");
    expect(parseTitleVersion("Song - Pt. 2").kinds).toEqual([]);
  });
});

describe("compareVersions", () => {
  const parse = (title: string) => parseTitleVersion(title);

  it("accepts matching or absent markers", () => {
    expect(compareVersions(parse("Song"), parse("Song")).compatible).toBe(true);
    expect(compareVersions(parse("Song (Live)"), parse("Song (Live)")).compatible).toBe(true);
  });

  it("hard-rejects one-sided distinct markers", () => {
    expect(compareVersions(parse("Song"), parse("Song (Live)"))).toEqual({
      compatible: false,
      hardReject: true,
    });
    expect(compareVersions(parse("Song"), parse("Song (Remix)"))).toEqual({
      compatible: false,
      hardReject: true,
    });
    expect(compareVersions(parse("Song (Acoustic)"), parse("Song (Remix)"))).toEqual({
      compatible: false,
      hardReject: true,
    });
  });

  it("softens remaster-only asymmetry", () => {
    const result = compareVersions(parse("Song"), parse("Song (Remastered)"));
    expect(result).toMatchObject({ compatible: true, remasterAsymmetry: true });
  });

  it("flags one-sided unknown annotations softly", () => {
    const result = compareVersions(parse("Song"), parse("Song (Album Mix)"));
    expect(result).toMatchObject({ compatible: true, unknownAsymmetry: true });
  });
});

describe("normalizeIsrc", () => {
  it("accepts valid ISRCs with formatting tolerance", () => {
    expect(normalizeIsrc("usrc17607839")).toBe("USRC17607839");
    expect(normalizeIsrc("USRC-1760-7839")).toBe("USRC17607839");
  });

  it("rejects malformed values", () => {
    expect(normalizeIsrc("short")).toBeNull();
    expect(normalizeIsrc("")).toBeNull();
    expect(normalizeIsrc(null)).toBeNull();
    expect(normalizeIsrc(42)).toBeNull();
  });
});

describe("identityIsrcs", () => {
  it("collects valid ISRCs across sources", () => {
    expect(
      identityIsrcs([
        { metadata: { isrc: "usrc17607839" } },
        { metadata: {} },
        {},
      ]),
    ).toEqual(new Set(["USRC17607839"]));
  });
});

describe("tokens", () => {
  it("computes order-insensitive overlap ratios", () => {
    expect(tokenOverlap(tokenize("a b"), tokenize("b a"))).toBe(1);
    expect(tokenOverlap(tokenize("song alpha"), tokenize("completely different song"))).toBe(0.5);
    expect(tokenOverlap(tokenize("alpha"), tokenize("beta"))).toBe(0);
    expect(tokenOverlap(tokenize(""), tokenize("x"))).toBe(0);
  });
});
