import { describe, expect, it, vi } from "vitest";
import type { AudioSource } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain/track-normalizer";
import type { Track } from "@/lib/domain/track";
import { createPlaybackResolver } from "@/lib/playback/resolver";
import type { SourcePlaybackResolver } from "@/lib/playback/resolver";

function youtubeTrack(id = "dQw4w9WgXcQ"): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: "Song",
    artistId: "UC1",
    artistName: "Artist",
  };
}

function spotifyTrack(): Track {
  return {
    id: "spotify-1",
    provider: "spotify",
    providerTrackId: "spotify-1",
    title: "Song",
    artistId: "sa-1",
    artistName: "Artist",
  };
}

function youtubeResolver(url = "https://cdn.example/a.m4a"): SourcePlaybackResolver & {
  resolveSource: ReturnType<typeof vi.fn>;
} {
  return {
    source: "youtube",
    resolveSource: vi.fn(async (): Promise<AudioSource> => ({ url })),
  };
}

describe("PlaybackResolver", () => {
  it("resolves youtube identities through the youtube resolver", async () => {
    const backend = youtubeResolver();
    const resolver = createPlaybackResolver([backend]);
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-1" });
    expect(resolver.canResolve(identity)).toBe(true);
    const source = await resolver.resolve(identity);
    expect(source.url).toBe("https://cdn.example/a.m4a");
    expect(backend.resolveSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: "youtube", id: "dQw4w9WgXcQ" }),
    );
  });

  it("rejects spotify-only identities at the match stage", async () => {
    const backend = youtubeResolver();
    const resolver = createPlaybackResolver([backend]);
    const identity = toTrackIdentity(spotifyTrack(), { id: "aurora-2" });
    expect(resolver.canResolve(identity)).toBe(false);
    const error = await resolver.resolve(identity).catch((cause) => cause);
    expect(error).toMatchObject({
      name: "PlaybackResolutionError",
      stage: "match",
      retryable: false,
    });
    expect(backend.resolveSource).not.toHaveBeenCalled();
  });

  it("rejects deezer-only identities without attempting resolution", async () => {
    const backend = youtubeResolver();
    const resolver = createPlaybackResolver([backend]);
    const identity = toTrackIdentity(
      { ...spotifyTrack(), provider: "deezer", providerTrackId: "deezer-9" },
      { id: "aurora-3" },
    );
    await expect(resolver.resolve(identity)).rejects.toMatchObject({ stage: "match" });
    expect(backend.resolveSource).not.toHaveBeenCalled();
  });

  it("selects the youtube source from multi-source identities in order", async () => {
    const backend = youtubeResolver();
    const resolver = createPlaybackResolver([backend]);
    const identity = toTrackIdentity(spotifyTrack(), { id: "aurora-4" });
    const multi = {
      ...identity,
      sources: [
        { source: "spotify" as const, id: "spotify-1" },
        { source: "deezer" as const, id: "deezer-9" },
        { source: "youtube" as const, id: "dQw4w9WgXcQ" },
      ],
    };
    const before = JSON.stringify(multi);
    const source = await resolver.resolve(multi);
    expect(source.url).toBe("https://cdn.example/a.m4a");
    expect(backend.resolveSource).toHaveBeenCalledWith({
      source: "youtube",
      id: "dQw4w9WgXcQ",
    });
    // No merging, no primary changes, no reorder.
    expect(JSON.stringify(multi)).toBe(before);
  });

  it("propagates resolver failures without wrapping the stage", async () => {
    const { PlaybackResolutionError } = await import("@/lib/domain");
    const backend: SourcePlaybackResolver = {
      source: "youtube",
      resolveSource: async () => {
        throw new PlaybackResolutionError(
          { provider: "youtube", providerTrackId: "dQw4w9WgXcQ" },
          "stream",
          "No playable audio format available",
        );
      },
    };
    const resolver = createPlaybackResolver([backend]);
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-5" });
    await expect(resolver.resolve(identity)).rejects.toMatchObject({ stage: "stream" });
  });

  it("uses the first registered resolver per source deterministically", async () => {
    const first = youtubeResolver("https://cdn.example/first.m4a");
    const second = youtubeResolver("https://cdn.example/second.m4a");
    const resolver = createPlaybackResolver([first, second]);
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-6" });
    const source = await resolver.resolve(identity);
    expect(source.url).toBe("https://cdn.example/first.m4a");
    expect(second.resolveSource).not.toHaveBeenCalled();
  });
});
