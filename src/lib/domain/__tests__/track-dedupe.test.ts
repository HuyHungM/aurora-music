import { describe, expect, it } from "vitest";
import type { MatchClassification, Track } from "@/lib/domain";
import {
  AUTO_MERGE_CLASSIFICATIONS,
  CanonicalDuplicateIndex,
  canonicalIdentityOf,
  canonicalTrackKeys,
  dedupeCanonicalTracks,
  findCanonicalDuplicate,
  isAutoMergeable,
  mergeSourceReference,
  toTrackIdentity,
} from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";

function track(
  id: string,
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "artist-1",
    artistName: "Artist",
    ...overrides,
  };
}

describe("canonicalTrackKeys", () => {
  it("uses provider and stable provider id, never the internal id", () => {
    // The internal id and the provider id differ on a DB row, and only the
    // provider-scoped pair identifies the recording.
    expect(canonicalTrackKeys(track("yt-1", { id: "internal-77" }))).toEqual([
      "youtube:yt-1",
    ]);
  });

  it("falls back to the row id when no provider id is present", () => {
    expect(canonicalTrackKeys(track("only-id", { providerTrackId: undefined }))).toEqual([
      "youtube:only-id",
    ]);
  });

  it("includes every source a merged group carries in metadata", () => {
    const group = identityToTrack(
      mergeSourceReference(
        toTrackIdentity(track("sp-1", { provider: "spotify" }), { id: "aurora-1" }),
        { source: "youtube", id: "yt-9" },
      ),
    );
    expect(canonicalTrackKeys(group).sort()).toEqual(["spotify:sp-1", "youtube:yt-9"]);
  });

  it("ignores malformed carried sources instead of throwing", () => {
    const row = track("yt-1", {
      metadata: {
        sources: [
          { source: "deezer", id: "dz-1" },
          { source: "deezer" },
          null,
          "deezer:dz-2",
          { source: "deezer", id: "" },
        ],
      },
    });
    expect(canonicalTrackKeys(row)).toEqual(["youtube:yt-1", "deezer:dz-1"]);
  });
});

describe("canonicalIdentityOf", () => {
  it("returns null for a track it cannot canonicalize", () => {
    // Unknown provider, no stable id, and no title each fail independently.
    expect(canonicalIdentityOf(track("x", { provider: "jamendo" as never }))).toBeNull();
    expect(canonicalIdentityOf(track("x", { providerTrackId: undefined }))).toBeNull();
    expect(canonicalIdentityOf(track("x", { title: "" }))).toBeNull();
    expect(canonicalIdentityOf(track("x", { artistName: "" }))).toBeNull();
  });

  it("folds carried sources into the identity so the matcher sees the group", () => {
    const row = track("sp-1", {
      provider: "spotify",
      metadata: { sources: [{ source: "youtube", id: "yt-9" }] },
    });
    const identity = canonicalIdentityOf(row);
    expect(identity?.sources.map((source) => `${source.source}:${source.id}`).sort()).toEqual([
      "spotify:sp-1",
      "youtube:yt-9",
    ]);
  });

  it("skips carried sources naming an unknown provider", () => {
    const row = track("yt-1", {
      metadata: { sources: [{ source: "jamendo", id: "j-1" }] },
    });
    // The KEY is still produced (keys accept any non-empty pair, which can only
    // ever find MORE duplicates), but the identity keeps just its own source.
    expect(canonicalTrackKeys(row)).toEqual(["youtube:yt-1", "jamendo:j-1"]);
    expect(canonicalIdentityOf(row)?.sources).toHaveLength(1);
  });
});

describe("findCanonicalDuplicate", () => {
  it("finds the same source by exact key", () => {
    const existing = [track("a"), track("b")];
    const found = findCanonicalDuplicate(track("b"), existing);
    expect(found).toMatchObject({ index: 1, key: "youtube:b", reason: "exact-key" });
  });

  it("finds a cross-provider rendering through the matcher", () => {
    const spotify = track("sp-1", { provider: "spotify", title: "Song", duration: 200 });
    const deezer = track("dz-1", { provider: "deezer", title: "Song", duration: 200 });
    const found = findCanonicalDuplicate(deezer, [spotify]);
    expect(found?.reason).toBe("matcher");
    expect(found?.classification).toBe("strong");
  });

  it("does not merge on `possible`, only on exact|strong", () => {
    // A partial artist overlap plus a close title is `possible`: acting on it
    // is how a different song sharing a title gets dropped.
    const original = track("a", { title: "Hello", artistName: "Nova Vega" });
    const other = track("b", { title: "Hellow", artistName: "Nova" });
    expect(findCanonicalDuplicate(other, [original])).toBeNull();
    expect(AUTO_MERGE_CLASSIFICATIONS).toEqual(["exact", "strong"]);
  });

  it("never reports an uncanonicalizable track as a duplicate", () => {
    // Identical title and artist, so the matcher WOULD reject it had it an
    // identity. Fail open instead.
    const existing = [track("a", { providerTrackId: undefined, title: "Same" })];
    const candidate = track("b", { providerTrackId: undefined, title: "Same" });
    expect(findCanonicalDuplicate(candidate, existing)).toBeNull();
  });

  it("is deterministic: always the first surviving match, in index order", () => {
    const a = track("sp-1", { provider: "spotify", title: "Song", duration: 200 });
    const b = track("sp-2", { provider: "spotify", title: "Song", duration: 200 });
    const candidate = track("dz-1", { provider: "deezer", title: "Song", duration: 200 });
    expect(findCanonicalDuplicate(candidate, [a, b])?.index).toBe(0);
    expect(findCanonicalDuplicate(candidate, [b, a])?.index).toBe(0);
  });

  it("treats a group and one of its members as the same track", () => {
    const group = identityToTrack(
      mergeSourceReference(
        toTrackIdentity(track("sp-1", { provider: "spotify" }), { id: "aurora-1" }),
        { source: "youtube", id: "yt-9" },
      ),
    );
    expect(findCanonicalDuplicate(track("yt-9"), [group])?.reason).toBe("exact-key");
  });
});

describe("dedupeCanonicalTracks", () => {
  it("keeps the first occurrence and preserves relative order", () => {
    const result = dedupeCanonicalTracks([track("a"), track("b"), track("a"), track("c")]);
    expect(result.kept.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(result.keptIndices).toEqual([0, 1, 3]);
    expect(result.duplicates).toHaveLength(1);
  });

  it("resolves every input index, so positional references stay addressable", () => {
    // `resolve` is total: a dropped index points at the survivor that absorbed
    // it, so a startIndex or a persisted cursor never silently shifts.
    const result = dedupeCanonicalTracks([
      track("a"),
      track("b"),
      track("a"),
      track("c"),
      track("b"),
    ]);
    expect(result.resolve).toEqual([0, 1, 0, 2, 1]);
    for (const [index, survivor] of result.resolve.entries()) {
      expect(result.kept[survivor]).toBeDefined();
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it("collapses a cross-provider duplicate to one entry", () => {
    const result = dedupeCanonicalTracks([
      track("sp-1", { provider: "spotify", title: "Song", duration: 200 }),
      track("b", { title: "Other" }),
      track("dz-1", { provider: "deezer", title: "Song", duration: 200 }),
    ]);
    expect(result.kept.map((entry) => entry.id)).toEqual(["sp-1", "b"]);
  });

  it("keeps every uncanonicalizable entry rather than shortening the list", () => {
    const result = dedupeCanonicalTracks([
      track("a", { providerTrackId: undefined }),
      track("b", { providerTrackId: undefined }),
      track("c", { providerTrackId: undefined }),
    ]);
    expect(result.kept).toHaveLength(3);
    expect(result.duplicates).toHaveLength(0);
  });

  it("keeps the whole collection when nothing duplicates", () => {
    const input = [track("a"), track("b"), track("c")];
    const result = dedupeCanonicalTracks(input);
    expect(result.kept).toEqual(input);
    expect(result.resolve).toEqual([0, 1, 2]);
  });
});

describe("CanonicalDuplicateIndex", () => {
  it("grows incrementally without changing its answer", () => {
    const built = new CanonicalDuplicateIndex([track("a"), track("b")]);
    const grown = new CanonicalDuplicateIndex();
    grown.add(track("a"));
    grown.add(track("b"));
    const candidate = track("a");
    expect(built.find(candidate)).toEqual(grown.find(candidate));
    expect(grown.size).toBe(2);
  });

  it("reports the surviving index a key belongs to", () => {
    const index = new CanonicalDuplicateIndex([track("a"), track("b"), track("c")]);
    expect(index.find(track("c"))).toMatchObject({ index: 2, key: "youtube:c" });
  });
});

describe("auto-merge policy", () => {
  it("accepts only exact and strong verdicts", () => {
    const result = (classification: MatchClassification, matched = true) => ({
      matched,
      classification,
      score: 70,
      evidence: [],
      rejectionReasons: [],
    });
    for (const classification of ["exact", "strong", "possible", "rejected"] as const) {
      expect(isAutoMergeable(result(classification, classification !== "rejected"))).toBe(
        classification === "exact" || classification === "strong",
      );
    }
    // Never on a non-match, whatever the classification says.
    expect(isAutoMergeable(result("exact", false))).toBe(false);
    expect(isAutoMergeable(result("strong", false))).toBe(false);
  });
});
