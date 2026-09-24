import { describe, expect, it, vi } from "vitest";
import { PlaybackResolutionError } from "@/lib/domain";
import type {
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "@/lib/providers/youtube/playback/types";
import { createYouTubeResolver as createYouTubeResolverImpl } from "@/lib/providers/youtube/playback/youtube-resolver";
import type { YouTubeResolver } from "@/lib/providers/youtube/playback/youtube-resolver";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";
import { toTrackIdentity } from "@/lib/domain/track-normalizer";
import type { Track } from "@/lib/domain/track";

/**
 * Test-local factory: validation is stubbed to accept every format, so
 * these policy tests stay hermetic (no network). Format-validation
 * fallback has its own cases below using the real factory.
 */
function createYouTubeResolver(client: YouTubePlaybackClient): YouTubeResolver {
  return createYouTubeResolverImpl(client, {
    validateFormat: async () => true,
  });
}

const VIDEO_ID = "dQw4w9WgXcQ";

function media(overrides: Partial<PlaybackMediaInfo> = {}): PlaybackMediaInfo {
  return {
    videoId: VIDEO_ID,
    title: "Song",
    durationMs: 213_000,
    formats: [
      {
        url: "https://cdn.example/audio.m4a",
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
        hasAudio: true,
        hasVideo: false,
      },
    ],
    ...overrides,
  };
}

function clientWith(info: PlaybackMediaInfo | Error): YouTubePlaybackClient {
  return {
    getMediaInfo: vi.fn(async () => {
      if (info instanceof Error) {
        throw info;
      }
      return info;
    }),
  };
}

function resolverWith(
  info: PlaybackMediaInfo | Error,
  validateFormat: (url: string) => Promise<boolean> = async () => true,
) {
  return createYouTubeResolverImpl(clientWith(info), { validateFormat });
}

function youtubeTrack(): Track {
  return {
    id: VIDEO_ID,
    provider: "youtube",
    providerTrackId: VIDEO_ID,
    title: "Song",
    artistId: "UC123",
    artistName: "Artist",
    duration: 213,
  };
}

describe("YouTubeResolver", () => {
  it("resolves the exact video id into an AudioSource", async () => {
    const resolver = createYouTubeResolver(clientWith(media()));
    const source = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(source).toMatchObject({
      url: "https://cdn.example/audio.m4a",
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 128_000,
      durationMs: 213_000,
    });
  });

  it("rejects malformed ids before any client call", async () => {
    const client = clientWith(media());
    const resolver = createYouTubeResolver(client);
    await expect(
      resolver.resolveSource({ source: "youtube", id: "nope" }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError", stage: "resolve" });
    expect(client.getMediaInfo).not.toHaveBeenCalled();
  });

  it("refuses non-youtube sources", async () => {
    const resolver = createYouTubeResolver(clientWith(media()));
    await expect(
      resolver.resolveSource({ source: "spotify", id: VIDEO_ID } as never),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError" });
  });

  it("never substitutes another video", async () => {
    const resolver = createYouTubeResolver(clientWith(media({ videoId: "other0000000" })));
    await expect(
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toMatchObject({ stage: "resolve" });
  });

  it("rejects private, live, and upcoming videos by policy", async () => {
    for (const flags of [{ isPrivate: true }, { isLiveContent: true }, { isUpcoming: true }]) {
      const resolver = createYouTubeResolver(clientWith(media(flags)));
      await expect(
        resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
      ).rejects.toMatchObject({ stage: "resolve" });
    }
  });

  it("fails the stream stage when no audio format exists", async () => {
    const resolver = createYouTubeResolver(
      clientWith(media({ formats: [{ url: "https://cdn.example/v", hasAudio: false, hasVideo: true }] })),
    );
    await expect(
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError", stage: "stream" });
  });

  it("rejects already-expired sources as fresh results", async () => {
    const resolver = createYouTubeResolver(
      clientWith(media({ expiresAt: new Date(Date.now() - 1000) })),
    );
    const error = await resolver
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(PlaybackResolutionError);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("preserves authoritative expiry when present", async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const resolver = createYouTubeResolver(clientWith(media({ expiresAt })));
    const source = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(source.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("leaves expiry undefined when the source exposes none", async () => {
    const info = media();
    delete info.expiresAt;
    const resolver = createYouTubeResolver(clientWith(info));
    const source = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(source.expiresAt).toBeUndefined();
  });

  it("maps client failures to resolve-stage errors without leaking urls", async () => {
    const resolver = createYouTubeResolver(
      clientWith(new Error("fetch failed: https://cdn.example/secret")),
    );
    const error = await resolver
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ name: "PlaybackResolutionError", stage: "resolve" });
    expect(JSON.stringify(error.toJSON())).not.toContain("cdn.example");
  });

  it("resolves identities carrying a youtube source without mutating them", async () => {
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-1" });
    const before = JSON.stringify(identity);
    const resolver = createYouTubeResolver(clientWith(media()));
    const source = await resolver.resolveIdentity(identity);
    expect(source.url).toBe("https://cdn.example/audio.m4a");
    expect(JSON.stringify(identity)).toBe(before);
  });

  it("fails identities without a youtube source", async () => {
    const identity = toTrackIdentity({
      ...youtubeTrack(),
      provider: "spotify",
      providerTrackId: "spotify-1",
    });
    const resolver = createYouTubeResolver(clientWith(media()));
    await expect(resolver.resolveIdentity(identity)).rejects.toMatchObject({
      stage: "resolve",
    });
  });
});

describe("YouTubeResolver format validation", () => {
  const POISONED_AUDIO = "https://cdn.example/poisoned.m4a";
  const GOOD_MUXED = "https://cdn.example/good.mp4";

  function mixedFormats(): PlaybackMediaInfo {
    return media({
      formats: [
        {
          url: POISONED_AUDIO,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 130_000,
          hasAudio: true,
          hasVideo: false,
        },
        {
          url: GOOD_MUXED,
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          bitrate: 360_000,
          hasAudio: true,
          hasVideo: true,
        },
      ],
    });
  }

  it("falls through to muxed when the top-ranked audio probe fails", async () => {
    const resolver = resolverWith(mixedFormats(), async (url) =>
      url === GOOD_MUXED,
    );
    const source = await resolver.resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    expect(source.url).toBe(GOOD_MUXED);
    expect(source.mimeType).toContain("video/mp4");
  });

  it("keeps the top-ranked format when its probe passes", async () => {
    const seen: string[] = [];
    const resolver = resolverWith(mixedFormats(), async (url) => {
      seen.push(url);
      return true;
    });
    const source = await resolver.resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    expect(source.url).toBe(POISONED_AUDIO);
    // Winner validated first; no fallthrough probing needed.
    expect(seen).toEqual([POISONED_AUDIO]);
  });

  it("validates in rank order (audio-only before muxed)", async () => {
    const seen: string[] = [];
    const resolver = resolverWith(mixedFormats(), async (url) => {
      seen.push(url);
      return url === GOOD_MUXED;
    });
    await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(seen).toEqual([POISONED_AUDIO, GOOD_MUXED]);
  });

  it("fails the stream stage when every candidate probe fails", async () => {
    const resolver = resolverWith(mixedFormats(), async () => false);
    const error = await resolver
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({
      name: "PlaybackResolutionError",
      stage: "stream",
    });
    expect(JSON.stringify(error.toJSON())).not.toContain("cdn.example");
  });

  it("treats validator errors as skips, not resolution failures", async () => {
    const resolver = resolverWith(mixedFormats(), async (url) => {
      if (url === POISONED_AUDIO) {
        throw new Error("probe exploded");
      }
      return true;
    });
    const source = await resolver.resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    expect(source.url).toBe(GOOD_MUXED);
  });

  it("never logs playback URLs while skipping candidates", async () => {
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      const resolver = resolverWith(mixedFormats(), async (url) =>
        url === GOOD_MUXED,
      );
      await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    } finally {
      restore();
      setLogLevel("error");
    }
    expect(
      records.filter((record) => record.event === "playback_format_skipped")
        .length,
    ).toBeGreaterThan(0);
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("cdn.example");
      expect(serialized).not.toMatch(/https?:\/\//);
    }
  });
});
