import { describe, expect, it } from "vitest";
import type { TrackIdentity } from "@/lib/domain";
import { createPlaybackController } from "@/lib/playback/controller";
import {
  controllableResolver,
  fakeEngine,
  flush,
  sourceFor,
} from "@/lib/playback/__tests__/fake-controller-env";
import { identityToTrack } from "@/lib/music/identity-track";
import type { ControllerError } from "@/lib/playback/controller";

function group(overrides: Partial<TrackIdentity> = {}): TrackIdentity {
  return {
    id: "aurora-1",
    title: "Lạc Trôi",
    artists: [{ id: "st-1", provider: "spotify", providerArtistId: "st-1", name: "Sơn Tùng M-TP" }],
    durationMs: 243_000,
    sources: [
      { source: "spotify", id: "sp-1", url: "https://open.spotify.com/track/sp-1" },
      { source: "youtube", id: "yt-1", url: "https://www.youtube.com/watch?v=yt-1" },
    ],
    primarySource: { source: "spotify", id: "sp-1", url: "https://open.spotify.com/track/sp-1" },
    ...overrides,
  };
}

describe("search result playback handoff", () => {
  it("plays the matched YouTube source through the controller path", async () => {
    const engine = fakeEngine();
    const backend = controllableResolver();
    const errors: ControllerError[] = [];
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: (error) => {
        errors.push(error);
      },
    });
    backend.resolveNextWith(sourceFor("yt-1", "https://cdn.example/yt-1.m4a"));
    controller.loadTrack(identityToTrack(group()));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "youtube", id: "yt-1" }),
    );
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe("https://cdn.example/yt-1.m4a");
    expect(errors).toEqual([]);
    controller.shutdown();
  });

  it("produces unavailable state for groups without a YouTube source", async () => {
    const engine = fakeEngine();
    const backend = controllableResolver();
    const errors: ControllerError[] = [];
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: (error) => {
        errors.push(error);
      },
    });
    const lonely = group({
      sources: [{ source: "spotify", id: "sp-1" }],
      primarySource: { source: "spotify", id: "sp-1" },
    });
    controller.loadTrack(identityToTrack(lonely));
    await flush();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([
      { kind: "unavailable", message: "No playable source in this identity" },
    ]);
    controller.shutdown();
  });
});
