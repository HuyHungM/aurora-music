import { describe, expect, it } from "vitest";
import { findSourceReference, primaryTrackRef } from "@/lib/domain/track-identity";
import type { TrackIdentity } from "@/lib/domain/track-identity";

function makeIdentity(): TrackIdentity {
  return {
    id: "clx0000000000000000000001",
    title: "Lạc Trôi",
    artists: [
      {
        id: "artist-1",
        provider: "spotify",
        providerArtistId: "s-artist-1",
        name: "Sơn Tùng M-TP",
      },
    ],
    durationMs: 240_000,
    artwork: { medium: "https://cdn.example/m.jpg" },
    sources: [
      { source: "spotify", id: "s-track-1" },
      { source: "deezer", id: "d-track-1" },
      { source: "youtube", id: "yt-video-1" },
    ],
    primarySource: { source: "youtube", id: "yt-video-1" },
  };
}

describe("TrackIdentity", () => {
  it("keeps the Aurora internal id separate from provider ids", () => {
    const identity = makeIdentity();
    expect(identity.id).toBe("clx0000000000000000000001");
    expect(identity.sources.map((s) => s.id)).not.toContain(identity.id);
  });

  it("exposes the primary source as a TrackRef", () => {
    expect(primaryTrackRef(makeIdentity())).toEqual({
      provider: "youtube",
      providerTrackId: "yt-video-1",
    });
  });

  it("finds references per source", () => {
    const identity = makeIdentity();
    expect(findSourceReference(identity, "spotify")).toMatchObject({
      source: "spotify",
      id: "s-track-1",
    });
    expect(findSourceReference(identity, "deezer")).toMatchObject({
      source: "deezer",
      id: "d-track-1",
    });
  });

  it("supports metadata-only identities without a playable source yet", () => {
    const identity = makeIdentity();
    identity.sources = [{ source: "spotify", id: "s-track-1" }];
    identity.primarySource = { source: "spotify", id: "s-track-1" };
    expect(findSourceReference(identity, "youtube")).toBeUndefined();
    expect(primaryTrackRef(identity)).toEqual({
      provider: "spotify",
      providerTrackId: "s-track-1",
    });
  });

  it("preserves version-relevant title information", () => {
    const identity = makeIdentity();
    identity.title = "Lạc Trôi (Remix)";
    expect(identity.title).toContain("Remix");
  });
});
