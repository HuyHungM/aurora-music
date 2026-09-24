import { describe, expect, it } from "vitest";
import type { TrackIdentity } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";

function identity(overrides: Partial<TrackIdentity> = {}): TrackIdentity {
  return {
    id: "aurora-1",
    title: "Lạc Trôi",
    artists: [
      { id: "st-1", provider: "spotify", providerArtistId: "st-1", name: "Sơn Tùng M-TP" },
    ],
    durationMs: 243_000,
    artwork: { medium: "https://img/m.jpg" },
    sources: [{ source: "spotify", id: "sp-1", url: "https://open.spotify.com/track/sp-1" }],
    primarySource: { source: "spotify", id: "sp-1", url: "https://open.spotify.com/track/sp-1" },
    ...overrides,
  };
}

describe("identityToTrack", () => {
  it("maps canonical fields onto the row/queue shape", () => {
    const track = identityToTrack(identity());
    expect(track).toMatchObject({
      id: "sp-1",
      provider: "spotify",
      providerTrackId: "sp-1",
      title: "Lạc Trôi",
      artistId: "st-1",
      artistName: "Sơn Tùng M-TP",
      duration: 243,
      artworkUrl: "https://img/m.jpg",
      providerUrl: "https://open.spotify.com/track/sp-1",
    });
    expect(track).not.toHaveProperty("streamUrl");
    expect(track).not.toHaveProperty("previewUrl");
  });

  it("carries merged sources for controller restoration", () => {
    const track = identityToTrack(
      identity({
        sources: [
          { source: "spotify", id: "sp-1" },
          { source: "youtube", id: "yt-1", url: "https://www.youtube.com/watch?v=yt-1" },
        ],
      }),
    );
    expect(track.metadata).toMatchObject({
      sources: [
        { source: "spotify", id: "sp-1" },
        { source: "youtube", id: "yt-1", url: "https://www.youtube.com/watch?v=yt-1" },
      ],
    });
    // Primary stays the row identity.
    expect(track.provider).toBe("spotify");
    expect(track.providerTrackId).toBe("sp-1");
  });

  it("handles sparse identities without fabricating values", () => {
    const track = identityToTrack(
      identity({
        artists: [],
        album: undefined,
        durationMs: undefined,
        artwork: undefined,
        metadata: undefined,
      }),
    );
    expect(track.artistName).toBe("Unknown artist");
    expect(track.duration).toBeUndefined();
    expect(track.artworkUrl).toBeUndefined();
    expect(track.albumName).toBeUndefined();
  });

  it("maps album and explicit state when present", () => {
    const track = identityToTrack(
      identity({
        album: {
          id: "al-1",
          provider: "spotify",
          title: "Album",
          artistId: "st-1",
          artistName: "Sơn Tùng M-TP",
        },
        metadata: { explicit: true },
      }),
    );
    expect(track.albumId).toBe("al-1");
    expect(track.albumName).toBe("Album");
    expect(track.explicit).toBe(true);
  });
});
