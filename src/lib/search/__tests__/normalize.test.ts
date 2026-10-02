import { describe, expect, it } from "vitest";
import {
  FUZZY_MIN_QUERY_CHARS,
  SHORT_QUERY_CHARS,
  normalizeSearchArtist,
  normalizeSearchField,
  normalizeSearchQuery,
} from "@/lib/search/normalize";

describe("normalizeSearchQuery", () => {
  it("preserves the raw trimmed text for providers and display", () => {
    const query = normalizeSearchQuery("  MCK  ");
    expect(query.raw).toBe("MCK");
    // The comparison view is derived; the source text is never rewritten.
    expect(query.normalized).toBe("mck");
  });

  it("collapses repeated whitespace and surrounding space", () => {
    expect(normalizeSearchQuery("  cam   on  ").normalized).toBe("cam on");
    expect(normalizeSearchQuery("cam \t\n on").normalized).toBe("cam on");
  });

  it("lowercases consistently", () => {
    expect(normalizeSearchQuery("CAM ON").normalized).toBe("cam on");
    expect(normalizeSearchQuery("Mck").normalized).toBe("mck");
  });

  it("folds Vietnamese diacritics for cross-script comparison", () => {
    expect(normalizeSearchQuery("Cảm Ơn").folded).toBe("cam on");
    expect(normalizeSearchQuery("cam on").folded).toBe("cam on");
    // Symmetric: an accented query and its plain spelling compare equal both
    // ways, which is what stops a one-way miss.
    expect(normalizeSearchQuery("cảm ơn").folded).toBe(normalizeSearchQuery("cam on").folded);
  });

  it("folds đ/Đ like a diacritic", () => {
    expect(normalizeSearchQuery("Đêm").folded).toBe("dem");
  });

  it("treats hyphens and apostrophes as separators, not deletions", () => {
    // "the-weeknd" and "the weeknd" are the same query to a person.
    expect(normalizeSearchQuery("the-weeknd").normalized).toBe("the weeknd");
    expect(normalizeSearchQuery("the weeknd").normalized).toBe("the weeknd");
    // An apostrophe disappears entirely rather than becoming a space, so
    // "don't" reads as "dont" and not "don t".
    expect(normalizeSearchQuery("don't").normalized).toBe("dont");
  });

  it("normalizes punctuation to spaces", () => {
    expect(normalizeSearchQuery("hello, world!").normalized).toBe("hello world");
  });

  it("applies NFKC so fullwidth text compares to its ASCII form", () => {
    expect(normalizeSearchQuery("ｍｃｋ").normalized).toBe("mck");
  });

  it("tokenizes in order, for both views", () => {
    const query = normalizeSearchQuery("Em Của Ngày Hôm Qua");
    // The accent-preserving view keeps the spelling the person typed...
    expect(query.tokens).toEqual(["em", "của", "ngày", "hôm", "qua"]);
    // ...and the folded view is the one an unaccented query compares against.
    expect(query.foldedTokens).toEqual(["em", "cua", "ngay", "hom", "qua"]);
  });

  it("keeps the accent-sensitive and accent-folded views distinct", () => {
    const query = normalizeSearchQuery("Cảm Ơn");
    // Both views are kept: the first for exact display-faithful comparison,
    // the second for cross-script comparison. Neither replaces the other.
    expect(query.normalized).toBe("cảm ơn");
    expect(query.folded).toBe("cam on");
  });

  it("flags short and fuzzy-eligible queries by length", () => {
    expect(normalizeSearchQuery("a").isShort).toBe(true);
    expect(normalizeSearchQuery("ab").isShort).toBe(true);
    expect(normalizeSearchQuery("abc").isShort).toBe(false);
    // Fuzzy needs enough characters to have a typo inside them.
    expect(normalizeSearchQuery("mck").fuzzyEligible).toBe(false);
    expect(normalizeSearchQuery("cam on").fuzzyEligible).toBe(true);
  });

  it("uses the documented thresholds", () => {
    expect(SHORT_QUERY_CHARS).toBe(2);
    expect(FUZZY_MIN_QUERY_CHARS).toBe(4);
    expect(normalizeSearchQuery("x".repeat(SHORT_QUERY_CHARS)).isShort).toBe(true);
    expect(normalizeSearchQuery("x".repeat(FUZZY_MIN_QUERY_CHARS)).fuzzyEligible).toBe(true);
  });

  it("returns a well-formed empty value for whitespace instead of throwing", () => {
    const query = normalizeSearchQuery("   ");
    expect(query.raw).toBe("");
    expect(query.normalized).toBe("");
    expect(query.folded).toBe("");
    expect(query.tokens).toEqual([]);
    expect(query.foldedTokens).toEqual([]);
    // "Is this an error?" is the caller's policy, not the normalizer's.
    expect(query.isShort).toBe(true);
    expect(query.fuzzyEligible).toBe(false);
  });

  it("does not match the examples in the brief against each other wrongly", () => {
    const cases = ["  MCK  ", "mck", "Mck", "cảm ơn", "cam on", "CAM ON"];
    const folded = cases.map((input) => normalizeSearchQuery(input).folded);
    // The four MCK spellings collapse to one form...
    expect(new Set(folded.slice(0, 3)).size).toBe(1);
    // ...and the three "cam on" spellings collapse to another, distinct one.
    expect(new Set(folded.slice(3)).size).toBe(1);
    expect(folded[0]).not.toBe(folded[3]);
  });
});

describe("normalizeSearchField", () => {
  it("produces the same comparison language as the query", () => {
    const field = normalizeSearchField("Cảm Ơn");
    const query = normalizeSearchQuery("cam on");
    expect(field.folded).toBe(query.folded);
  });

  it("marks a punctuation-only or empty field as empty", () => {
    // Provider text is untrusted shape: a field that normalizes to nothing
    // must be reported as "no evidence" so it can never equal an empty query.
    expect(normalizeSearchField("").empty).toBe(true);
    expect(normalizeSearchField("   ").empty).toBe(true);
    expect(normalizeSearchField("(((").empty).toBe(true);
    expect(normalizeSearchField("!!!").empty).toBe(true);
    expect(normalizeSearchField("a").empty).toBe(false);
  });

  it("handles a live annotation without destroying the base text", () => {
    expect(normalizeSearchField("Cảm Ơn (Live)").folded).toBe("cam on live");
  });
});

describe("normalizeSearchArtist", () => {
  it("routes through the same primitives the matcher uses", () => {
    expect(normalizeSearchArtist("Sơn Tùng M-TP").folded).toBe("son tung m tp");
    expect(normalizeSearchArtist("  ").empty).toBe(true);
  });
});
