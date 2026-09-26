import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import {
  collectionPlayability,
  trackCapabilities,
  trackPlayability,
} from "@/lib/player/track-capabilities";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    provider: "youtube",
    providerTrackId: "yt1",
    title: "Track",
    artistId: "a1",
    artistName: "Artist",
    ...overrides,
  };
}

function withSources(primary: Partial<Track>, sources: Array<{ source: string; id: string }>): Track {
  return makeTrack({
    ...primary,
    metadata: { sources: sources.map((s) => ({ ...s })) },
  });
}

describe("trackPlayability (Phase 37 capability model)", () => {
  it("treats a YouTube-primary track as playable", () => {
    expect(trackPlayability(makeTrack())).toBe("playable");
  });

  it("treats a Spotify-primary track WITH a merged YouTube source as playable", () => {
    const track = withSources(
      { provider: "spotify", providerTrackId: "sp1", id: "sp1" },
      [
        { source: "spotify", id: "sp1" },
        { source: "youtube", id: "yt1" },
      ],
    );
    expect(trackPlayability(track)).toBe("playable");
    expect(trackCapabilities(track).canPlay).toBe(true);
  });

  it("treats a Deezer-primary track WITH a merged YouTube source as playable", () => {
    const track = withSources(
      { provider: "deezer", providerTrackId: "dz1", id: "dz1" },
      [
        { source: "deezer", id: "dz1" },
        { source: "youtube", id: "yt1" },
      ],
    );
    expect(trackPlayability(track)).toBe("playable");
  });

  it("treats a Spotify-only track as catalog-only (never invents playback)", () => {
    const track = withSources(
      { provider: "spotify", providerTrackId: "sp1", id: "sp1" },
      [{ source: "spotify", id: "sp1" }],
    );
    expect(trackPlayability(track)).toBe("catalog-only");
    const caps = trackCapabilities(track);
    expect(caps.canPlay).toBe(false);
    // Library/queue/details stay available: provider-agnostic concepts.
    expect(caps.canQueue).toBe(true);
    expect(caps.canLike).toBe(true);
    expect(caps.canAddToPlaylist).toBe(true);
    expect(caps.canOpenDetails).toBe(true);
  });

  it("treats a Deezer-only track as catalog-only", () => {
    const track = makeTrack({ provider: "deezer", providerTrackId: "dz1", id: "dz1" });
    expect(trackPlayability(track)).toBe("catalog-only");
  });

  it("never treats a Deezer preview URL as playback capability", () => {
    const track = makeTrack({
      provider: "deezer",
      providerTrackId: "dz1",
      id: "dz1",
      previewUrl: "https://cdn.example/preview.mp3",
      streamUrl: "https://cdn.example/stream.mp3",
    });
    // Frozen descriptive fields are never playback input.
    expect(trackPlayability(track)).toBe("catalog-only");
  });

  it("ignores malformed carried sources instead of failing open or closed", () => {
    const track = makeTrack({
      provider: "spotify",
      providerTrackId: "sp1",
      id: "sp1",
      metadata: { sources: [{ source: "youtube" }, null, "yt1"] },
    });
    // Well-formed entries: none with youtube → spotify-only → catalog-only.
    expect(trackPlayability(track)).toBe("catalog-only");
  });

  it("keeps unknown/test sources attemptable (never invents unplayability)", () => {
    expect(trackPlayability(makeTrack({ provider: "mock" }))).toBe("playable");
  });
});

describe("collectionPlayability", () => {
  it("reports empty for no tracks", () => {
    expect(collectionPlayability([])).toBe("empty");
  });

  it("reports playable when ANY member can play", () => {
    const playable = makeTrack();
    const catalogOnly = makeTrack({ provider: "spotify", providerTrackId: "sp1", id: "sp1" });
    expect(collectionPlayability([catalogOnly, playable])).toBe("playable");
  });

  it("reports catalog-only when no member can play", () => {
    const only = makeTrack({ provider: "deezer", providerTrackId: "dz1", id: "dz1" });
    expect(collectionPlayability([only])).toBe("catalog-only");
  });
});
