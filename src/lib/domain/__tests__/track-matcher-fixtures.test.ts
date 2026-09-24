import { describe, expect, it } from "vitest";
import { createTrackMatcher } from "@/lib/domain/track-matcher";
import { fixtureIdentity, lacTroiPair } from "./matcher-fixtures";

const matcher = createTrackMatcher();

/**
 * Calibration corpus: realistic cross-provider pairs with documented
 * expected outcomes. Must-match pairs prove recall; must-not-match pairs
 * prove false-positive protection (the dangerous direction).
 */

describe("must match", () => {
  it("matches the same song across Spotify and Deezer", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Harder, Better, Faster, Stronger",
      artistName: "Daft Punk",
      durationSeconds: 224,
      isrc: "GBAYE0000563",
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Harder, Better, Faster, Stronger",
      artistName: "Daft Punk",
      durationSeconds: 224,
      isrc: "GBAYE0000563",
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.classification).toBe("exact");
  });

  it("matches YouTube and Spotify without ISRC", () => {
    const left = fixtureIdentity({
      provider: "youtube",
      title: "Lạc Trôi",
      artistName: "Sơn Tùng M-TP",
      durationSeconds: 253,
    });
    const right = fixtureIdentity({
      provider: "spotify",
      title: "Lạc Trôi",
      artistName: "Sơn Tùng M-TP",
      durationSeconds: 253,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(["strong", "exact"]).toContain(result.classification);
  });

  it("matches diacritic and punctuation variants", () => {
    const { left, right } = lacTroiPair();
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
  });

  it("matches album versus single releases", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      albumId: "single-1",
      albumName: "Song - Single",
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 201,
      albumId: "album-9",
      albumName: "Greatest Hits",
    });
    expect(matcher.match(left, right).matched).toBe(true);
  });

  it("matches featured-artist formatting differences", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song (feat. Artist B)",
      artistName: "Artist A",
      durationSeconds: 210,
      artists: [
        { id: "a", name: "Artist A" },
        { id: "b", name: "Artist B" },
      ],
    });
    const right = fixtureIdentity({
      provider: "youtube",
      title: "Song",
      artistName: "Artist A",
      durationSeconds: 210,
      artists: [
        { id: "a", name: "Artist A" },
        { id: "b", name: "Artist B" },
      ],
    });
    expect(matcher.match(left, right).matched).toBe(true);
  });

  it("matches small duration rounding differences", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 202,
    });
    expect(matcher.match(left, right).matched).toBe(true);
  });

  it("matches remaster-compatible pairs without exactness", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song (2024 Remaster)",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(true);
    expect(result.classification).not.toBe("exact");
  });

  it("matches clean metadata variants", () => {
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
    expect(matcher.match(left, right).matched).toBe(true);
  });
});

describe("must not match", () => {
  function studio(variant: string) {
    return {
      left: fixtureIdentity({
        provider: "spotify",
        title: "Song",
        artistName: "Artist",
        durationSeconds: 200,
      }),
      right: fixtureIdentity({
        provider: "youtube",
        title: `Song ${variant}`,
        artistName: "Artist",
        durationSeconds: 205,
      }),
    };
  }

  it.each([
    ["(Live)"],
    ["(Acoustic)"],
    ["(Remix)"],
    ["[Club Mix]"],
    ["- Radio Edit"],
    ["(Instrumental)"],
    ["(Karaoke)"],
    ["(Cover)"],
    ["(Demo)"],
    ["(Sped Up)"],
    ["(Slowed + Reverb)"],
    ["(Nightcore)"],
  ])("rejects studio vs %s", (variant) => {
    const { left, right } = studio(variant);
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("version-mismatch");
  });

  it("rejects unrelated songs sharing a duration", () => {
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

  it("rejects the same title by different artists", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist A",
      durationSeconds: 200,
    });
    const right = fixtureIdentity({
      provider: "youtube",
      title: "Song",
      artistName: "Artist B",
      durationSeconds: 200,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("artist-mismatch");
  });

  it("rejects major title mismatches", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Alpha",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Beta",
      artistName: "Artist",
      durationSeconds: 200,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("title-mismatch");
  });

  it("rejects implausible duration gaps despite agreement", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 180,
    });
    const right = fixtureIdentity({
      provider: "youtube",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 300,
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("duration-mismatch");
  });

  it("rejects same-ISRC live contradictions conservatively", () => {
    const left = fixtureIdentity({
      provider: "spotify",
      title: "Song",
      artistName: "Artist",
      durationSeconds: 200,
      isrc: "USRC17607839",
    });
    const right = fixtureIdentity({
      provider: "deezer",
      title: "Song (Live)",
      artistName: "Artist",
      durationSeconds: 230,
      isrc: "USRC17607839",
    });
    const result = matcher.match(left, right);
    expect(result.matched).toBe(false);
    expect(result.rejectionReasons).toContain("version-mismatch");
  });
});

describe("cross-provider coverage", () => {
  function song(provider: "youtube" | "spotify" | "deezer", title: string, artist: string) {
    return fixtureIdentity({ provider, title, artistName: artist, durationSeconds: 200 });
  }

  it("matches YouTube ↔ Deezer", () => {
    expect(
      matcher.match(song("youtube", "Song", "Artist"), song("deezer", "Song", "Artist")).matched,
    ).toBe(true);
  });

  it("matches Spotify ↔ Deezer", () => {
    expect(
      matcher.match(song("spotify", "Song", "Artist"), song("deezer", "Song", "Artist")).matched,
    ).toBe(true);
  });

  it("matches YouTube ↔ Spotify", () => {
    expect(
      matcher.match(song("youtube", "Song", "Artist"), song("spotify", "Song", "Artist")).matched,
    ).toBe(true);
  });

  it("rejects version variants on every provider pair", () => {
    const pairs = [
      [song("youtube", "Song (Live)", "Artist"), song("spotify", "Song", "Artist")],
      [song("spotify", "Song (Remix)", "Artist"), song("deezer", "Song", "Artist")],
      [song("deezer", "Song (Acoustic)", "Artist"), song("youtube", "Song", "Artist")],
    ] as const;
    for (const [left, right] of pairs) {
      expect(matcher.match(left, right).matched).toBe(false);
    }
  });
});
