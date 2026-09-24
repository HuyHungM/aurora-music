import { describe, expect, it } from "vitest";
import type { TrackIdentity } from "@/lib/domain/track-identity";
import {
  MATCH_THRESHOLD_POSSIBLE,
  MATCH_THRESHOLD_STRONG,
  SCORE_SAME_SOURCE,
  createTrackMatcher,
  findBestMatch,
  rankMatches,
} from "@/lib/domain/track-matcher";
import { fixtureIdentity, fixtureTrack } from "./matcher-fixtures";
import { toTrackIdentity } from "@/lib/domain/track-normalizer";

const matcher = createTrackMatcher();

function snapshot(identity: TrackIdentity): string {
  return JSON.stringify(identity);
}

describe("same-source identity", () => {
  it("matches the exact provider source id without fuzzy comparison", () => {
    const left = fixtureIdentity({ provider: "spotify", providerTrackId: "s1", title: "Song" });
    const right = fixtureIdentity({ provider: "spotify", providerTrackId: "s1", title: "Different Title" });
    const result = matcher.match(left, right);
    expect(result).toMatchObject({
      matched: true,
      classification: "exact",
      score: SCORE_SAME_SOURCE,
    });
    expect(result.evidence[0]?.signal).toBe("same-source-id");
  });

  it("never equates raw ids across providers", () => {
    const left = fixtureIdentity({
      provider: "youtube",
      providerTrackId: "123",
      title: "Alpha",
      artistName: "Artist A",
    });
    const right = fixtureIdentity({
      provider: "spotify",
      providerTrackId: "123",
      title: "Beta",
      artistName: "Artist B",
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.classification).not.toBe("exact");
  });

  it("does not auto-reject same-provider different ids", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      providerTrackId: "s1",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const right = fixtureIdentity({
      provider: "spotify",
      providerTrackId: "s2",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
    });
    expect(matcher.match(left, right).matched).toBe(true);
  });
});

describe("ISRC signals", () => {
  function pair(isrcLeft?: string, isrcRight?: string) {
    return {
      left: fixtureIdentity({
        provider: "spotify",
        title: "Song",
        artistName: "Artist",
        durationSeconds: 200,
        ...(isrcLeft !== undefined ? { isrc: isrcLeft } : {}),
      }),
      right: fixtureIdentity({
        provider: "deezer",
        title: "Song",
        artistName: "Artist",
        durationSeconds: 200,
        ...(isrcRight !== undefined ? { isrc: isrcRight } : {}),
      }),
    };
  }

  it("treats exact valid ISRC as very strong evidence", () => {
    const { left, right } = pair("USRC17607839", "usrc-1760-7839");
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.classification).toBe("exact");
  });

  it("lowers confidence materially on ISRC conflict", () => {
    const { left, right } = pair("USRC17607839", "USRC17607840");
    const conflicted = matcher.match(left, right);
    const { left: plainLeft, right: plainRight } = pair();
    const plain = matcher.match(plainLeft, plainRight);
    expect(conflicted.score).toBeLessThan(plain.score);
    expect(conflicted.rejectionReasons).toContain("isrc-conflict");
  });

  it("ignores malformed ISRC strings", () => {
    const { left, right } = pair("not-an-isrc", "also-bad");
    const result = matcher.match(left, right);
    expect(result.evidence.find((entry) => entry.signal === "isrc")).toMatchObject({
      result: "neutral",
      weight: 0,
    });
  });
});

describe("artists", () => {
  it("compares full arrays order-insensitively", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      durationSeconds: 200,
      artists: [
        { id: "a", name: "Artist A" },
        { id: "b", name: "Artist B" },
      ],
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      durationSeconds: 200,
      artists: [
        { id: "b", name: "Artist B" },
        { id: "a", name: "Artist A" },
      ],
    });
    expect(matcher.match(left, right).matched).toBe(true);
  });

  it("rejects disjoint artists", () => {
    const left = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist A" });
    const right = fixtureIdentity({ provider: "deezer", title: "Song", artistName: "Artist B" });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("artist-mismatch");
  });

  it("stays neutral when artists are missing on one side", () => {
    const left = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist" });
    const right = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist" });
    const stripped = { ...right, artists: [] };
    const result = matcher.match(left, stripped);
    expect(result.evidence.find((entry) => entry.signal === "artists")).toMatchObject({
      result: "neutral",
    });
  });
});

describe("duration", () => {
  function pair(leftSeconds?: number, rightSeconds?: number) {
    return {
      left: fixtureIdentity({
        provider: "spotify",
        title: "Song",
        artistName: "Artist",
        ...(leftSeconds !== undefined ? { durationSeconds: leftSeconds } : {}),
      }),
      right: fixtureIdentity({
        provider: "deezer",
        title: "Song",
        artistName: "Artist",
        ...(rightSeconds !== undefined ? { durationSeconds: rightSeconds } : {}),
      }),
    };
  }

  it("accepts exact and rounding differences", () => {
    const exact = pair(200, 200);
    const rounded = pair(200, 201.4);
    expect(matcher.match(exact.left, exact.right).matched).toBe(true);
    expect(matcher.match(rounded.left, rounded.right).matched).toBe(true);
  });

  it("treats missing duration as unknown, not mismatch", () => {
    const { left, right } = pair(200, undefined);
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.evidence.find((entry) => entry.signal === "duration")).toMatchObject({
      result: "neutral",
    });
  });

  it("hard-rejects implausible gaps", () => {
    const { left, right } = pair(200, 300);
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("duration-mismatch");
  });

  it("does not let duration rescue unrelated tracks", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song Alpha",
      artistName: "Artist A",
      durationSeconds: 201,
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Completely Different Song",
      artistName: "Artist B",
      durationSeconds: 201,
    });
    expect(matcher.match(left, right).matched).toBe(false);
  });
});

describe("album and explicit", () => {
  it("treats different albums as weak evidence only", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      albumId: "a1",
      albumName: "Single",
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      albumId: "a2",
      albumName: "Album",
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.evidence.find((entry) => entry.signal === "album")).toMatchObject({
      result: "negative",
    });
  });

  it("never rejects on explicit mismatch alone", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      explicit: true,
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      explicit: false,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.rejectionReasons).not.toContain("artist-mismatch");
  });
});

describe("thresholds and evidence", () => {
  it("exposes score, classification, evidence, and reasons", () => {
    const left = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist" });
    const right = fixtureIdentity({ provider: "deezer", title: "Other", artistName: "Nobody" });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.classification).toBe("rejected");
    expect(result.score).toBeLessThan(MATCH_THRESHOLD_POSSIBLE);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.rejectionReasons.length).toBeGreaterThan(0);
  });

  it("orders thresholds exact > strong > possible", () => {
    expect(MATCH_THRESHOLD_POSSIBLE).toBeLessThan(MATCH_THRESHOLD_STRONG);
    expect(MATCH_THRESHOLD_STRONG).toBeLessThan(120);
  });
});

describe("symmetry and determinism", () => {
  const pairs: Array<[TrackIdentity, TrackIdentity]> = [
    [
      fixtureIdentity({ provider: "spotify", title: "Song (Live)", artistName: "A" }),
      fixtureIdentity({ provider: "youtube", title: "Song", artistName: "A" }),
    ],
    [
      fixtureIdentity({ provider: "spotify", title: "Lạc Trôi", artistName: "Sơn Tùng", durationSeconds: 243 }),
      fixtureIdentity({ provider: "deezer", title: "Lac Troi", artistName: "Son Tung", durationSeconds: 244 }),
    ],
    [
      fixtureIdentity({ provider: "youtube", title: "Song", artistName: "A", isrc: "USRC17607839" }),
      fixtureIdentity({ provider: "deezer", title: "Song", artistName: "A", isrc: "USRC17607839" }),
    ],
  ];

  it("produces identical results regardless of argument order", () => {
    for (const [left, right] of pairs) {
      expect(matcher.match(right, left)).toEqual(matcher.match(left, right));
    }
  });

  it("is deterministic across repeated calls", () => {
    const [left, right] = pairs[1] as [TrackIdentity, TrackIdentity];
    expect(matcher.match(left, right)).toEqual(matcher.match(left, right));
  });

  it("ignores primary source selection", () => {
    const [left, right] = pairs[1] as [TrackIdentity, TrackIdentity];
    const relabeled = {
      ...left,
      primarySource: left.sources[0] as TrackIdentity["primarySource"],
    };
    expect(matcher.match(relabeled, right)).toEqual(matcher.match(left, right));
  });
});

describe("immutability", () => {
  it("never mutates its inputs", () => {
    const left = fixtureIdentity({ provider: "spotify", title: "Song (Remix)", artistName: "A" });
    const right = fixtureIdentity({ provider: "deezer", title: "Song", artistName: "A" });
    const before = [snapshot(left), snapshot(right)];
    matcher.match(left, right);
    rankMatches(left, [right]);
    expect([snapshot(left), snapshot(right)]).toEqual(before);
  });
});

describe("findBestMatch", () => {
  it("returns the best matched candidate", () => {
    const source = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist", durationSeconds: 200 });
    const good = fixtureIdentity({ provider: "youtube", title: "Song", artistName: "Artist", durationSeconds: 200 });
    const bad = fixtureIdentity({ provider: "deezer", title: "Other", artistName: "Nobody" });
    const best = findBestMatch(source, [bad, good]);
    expect(best?.candidate.id).toBe(good.id);
    expect(best?.result.matched).toBe(true);
  });

  it("returns null when every candidate is rejected", () => {
    const source = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist" });
    const bad = fixtureIdentity({ provider: "deezer", title: "Other (Live)", artistName: "Nobody" });
    expect(findBestMatch(source, [bad])).toBeNull();
    expect(findBestMatch(source, [])).toBeNull();
  });

  it("ranks without mutating or merging", () => {
    const source = fixtureIdentity({ provider: "spotify", title: "Song", artistName: "Artist", durationSeconds: 200 });
    const candidates = [
      fixtureIdentity({ provider: "deezer", title: "Nope", artistName: "Nobody" }),
      fixtureIdentity({ provider: "youtube", title: "Song", artistName: "Artist", durationSeconds: 200 }),
    ];
    const before = candidates.map(snapshot);
    const ranked = rankMatches(source, candidates);
    expect(ranked[0]?.candidate.title).toBe("Song");
    expect(ranked[0]?.result.score).toBeGreaterThanOrEqual(ranked[1]?.result.score ?? 0);
    expect(candidates.map(snapshot)).toEqual(before);
    for (const candidate of candidates) {
      expect(candidate.sources).toHaveLength(1);
    }
  });
});

describe("legacy track compatibility", () => {
  it("matches identities built from raw provider tracks", () => {
    const left = toTrackIdentity(
      fixtureTrack({ provider: "spotify", title: "Song", artistName: "Artist", durationSeconds: 200 }),
      { id: "aurora-left" },
    );
    const right = toTrackIdentity(
      fixtureTrack({ provider: "youtube", title: "Song", artistName: "Artist", durationSeconds: 201 }),
      { id: "aurora-right" },
    );
    expect(matcher.match(left, right).matched).toBe(true);
  });
});
