import { describe, expect, it, vi } from "vitest";
import { PlaybackResolutionError } from "@/lib/domain";
import type {
  PlaybackFormatCandidate,
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "@/lib/providers/youtube/playback/types";
import { createYouTubeResolver as createYouTubeResolverImpl } from "@/lib/providers/youtube/playback/youtube-resolver";
import type { YouTubeResolver } from "@/lib/providers/youtube/playback/youtube-resolver";
import type { FormatProbeVerdict } from "@/lib/providers/youtube/playback/format-validation";
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
  validateFormat: (
    url: string,
  ) => Promise<boolean | FormatProbeVerdict> = async () => true,
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

describe("YouTubeResolver format diagnostics", () => {
  const GOOD_MUXED = "https://cdn.example/good.mp4";

  function aac(url: string, itag: number): PlaybackFormatCandidate {
    return {
      url,
      itag,
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 131_115,
      hasAudio: true,
      hasVideo: false,
    };
  }

  function opus(url: string, itag: number): PlaybackFormatCandidate {
    return {
      url,
      itag,
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 180_658,
      hasAudio: true,
      hasVideo: false,
    };
  }

  /** The measured production shape: an audio ladder then one progressive muxed. */
  function adaptiveLadder(): PlaybackMediaInfo {
    return media({
      formats: [
        opus("https://cdn.example/opus-high.webm", 251),
        aac("https://cdn.example/aac.m4a", 140),
        opus("https://cdn.example/opus-low.webm", 249),
        {
          url: GOOD_MUXED,
          itag: 18,
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          bitrate: 255_920,
          hasAudio: true,
          hasVideo: true,
        },
      ],
    });
  }

  async function capture(
    run: () => Promise<unknown>,
  ): Promise<{ records: LogRecord[]; error: unknown }> {
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      const error = await run().catch((cause) => cause);
      return { records, error };
    } finally {
      restore();
      setLogLevel("error");
    }
  }

  it("reports itag and a stable reason for every skipped candidate", async () => {
    const { records } = await capture(async () => {
      const resolver = resolverWith(adaptiveLadder(), async (url) => url === GOOD_MUXED);
      return await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    });
    const skips = records.filter((r) => r.event === "playback_format_skipped");
    expect(skips).toHaveLength(3);
    // Rank order is preserved (audio/mp4 outranks audio/webm per the selection
    // policy) and each line identifies the exact rendition by itag.
    expect(skips.map((r) => r.fields.itag)).toEqual([140, 251, 249]);
    for (const skip of skips) {
      expect(skip.fields.reason).toBe("validator_injected");
      expect(skip.fields.mimeType).toBeTypeOf("string");
      expect(skip.fields.bitrate).toBeTypeOf("number");
    }
  });

  it("emits one playback_resolution_failed summary when every candidate fails", async () => {
    const { records, error } = await capture(async () =>
      resolverWith(adaptiveLadder(), async () => false).resolveSource({
        source: "youtube",
        id: VIDEO_ID,
      }),
    );
    expect(error).toMatchObject({ name: "PlaybackResolutionError", stage: "stream" });
    const summaries = records.filter((r) => r.event === "playback_resolution_failed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({
      candidateCount: 4,
      validCount: 0,
      rejectedCount: 4,
    });
    expect(summaries[0]?.fields.topRejectionReasons).toBe("validator_injected=4");
  });

  it("reports a zero-candidate resolution instead of failing silently", async () => {
    const { records, error } = await capture(async () =>
      resolverWith(media({ formats: [] }), async () => true).resolveSource({
        source: "youtube",
        id: VIDEO_ID,
      }),
    );
    expect(error).toMatchObject({ stage: "stream" });
    const summary = records.find((r) => r.event === "playback_resolution_failed");
    expect(summary?.fields).toMatchObject({ candidateCount: 0, rejectedCount: 0 });
    expect(summary?.fields.topRejectionReasons).toBe("");
  });

  it("records the fallthrough so a later candidate is not a silent downgrade", async () => {
    const { records } = await capture(async () => {
      const resolver = resolverWith(adaptiveLadder(), async (url) => url === GOOD_MUXED);
      return await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    });
    const fallbacks = records.filter((r) => r.event === "playback_format_fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.fields).toMatchObject({ rejectedCount: 3, selectedItag: 18 });
  });

  it("emits no fallthrough record when the first candidate passes", async () => {
    const { records } = await capture(async () => {
      const seen: string[] = [];
      const resolver = resolverWith(adaptiveLadder(), async (url) => {
        seen.push(url);
        return true;
      });
      const source = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
      expect(source.url).toBe("https://cdn.example/aac.m4a");
      return source;
    });
    expect(records.filter((r) => r.event === "playback_format_fallback")).toHaveLength(0);
  });

  it("keeps a validator that throws visible as a reason, not a silent skip", async () => {
    const { records } = await capture(async () =>
      resolverWith(adaptiveLadder(), async () => {
        throw new Error("probe exploded");
      }).resolveSource({ source: "youtube", id: VIDEO_ID }),
    );
    const skips = records.filter((r) => r.event === "playback_format_skipped");
    expect(skips).toHaveLength(4);
    for (const skip of skips) {
      expect(skip.fields.reason).toBe("validator_injected");
    }
    expect(records.some((r) => r.event === "playback_resolution_failed")).toBe(true);
  });

  it("never leaks a URL through the new diagnostic fields", async () => {
    const { records } = await capture(async () =>
      resolverWith(adaptiveLadder(), async () => false).resolveSource({
        source: "youtube",
        id: VIDEO_ID,
      }),
    );
    const blob = JSON.stringify(records);
    expect(blob).not.toContain("cdn.example");
    expect(blob).not.toMatch(/https?:\/\//);
  });
});

/**
 * M3-02: "no consumable format" is two failures, not one.
 *
 * Measured on 2026-09-27: an 8-minute burst of live-playback tests drove all
 * seven candidates of one video to `probe_status_403` - including the
 * progressive format that had answered 206 on every candidate minutes earlier -
 * while a bounded read on each still succeeded. The media existed; the CDN was
 * declining the browser's whole-body read. That was reported as
 * `retryable: false`, so `classifyFailure` called it permanent and recovery
 * never re-resolved: the user had to press play again by hand after the
 * throttle cleared.
 *
 * The classification now keys on the probe's own evidence rather than on the
 * status code alone. These cases pin both directions, because the safe
 * failure here is the wrong one: an over-broad retryable rule would re-resolve
 * genuinely dead sources forever (bounded, but pointless), and a too-narrow one
 * leaves the throttle case broken.
 */
describe("YouTubeResolver alive-but-refused classification", () => {
  const MUXED = "https://cdn.example/muxed.mp4";

  function ladder(): PlaybackMediaInfo {
    return media({
      formats: [
        {
          url: "https://cdn.example/opus.webm",
          itag: 251,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 180_658,
          hasAudio: true,
          hasVideo: false,
        },
        {
          url: MUXED,
          itag: 18,
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          bitrate: 255_920,
          hasAudio: true,
          hasVideo: true,
        },
      ],
    });
  }

  const refusedWholeBody: FormatProbeVerdict = {
    consumable: false,
    reason: "probe_status_403",
    status: 403,
    boundedRangeOk: true,
  };

  it("marks an all-refused-but-alive source retryable", async () => {
    const error = await resolverWith(ladder(), async () => refusedWholeBody)
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({
      name: "PlaybackResolutionError",
      stage: "stream",
      retryable: true,
    });
  });

  it("keeps a dead source permanent", async () => {
    const error = await resolverWith(ladder(), async () => ({
      consumable: false,
      reason: "probe_status_404",
      status: 404,
    }))
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("keeps a refused source permanent when one candidate is genuinely dead", async () => {
    // A single 404 means the media is gone, so the surviving 403-alive URLs are
    // signed links to nothing. Retrying would re-resolve a deleted video.
    const error = await resolverWith(ladder(), async (url) =>
      url === MUXED
        ? { consumable: false, reason: "probe_status_404", status: 404 }
        : refusedWholeBody,
    )
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("keeps a 403 with no bounded confirmation permanent", async () => {
    // No bounded read means the URL proved nothing, which is the expired
    // signature case the confirmation exists to tell apart.
    const error = await resolverWith(ladder(), async () => ({
      consumable: false,
      reason: "probe_status_403",
      status: 403,
    }))
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("keeps a timeout permanent", async () => {
    const error = await resolverWith(ladder(), async () => ({
      consumable: false,
      reason: "probe_timeout",
    }))
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("keeps a zero-candidate resolution permanent", async () => {
    const error = await resolverWith(media({ formats: [] }), async () => true)
      .resolveSource({ source: "youtube", id: VIDEO_ID })
      .catch((cause) => cause);
    expect(error).toMatchObject({ stage: "stream", retryable: false });
  });

  it("logs the verdict so the retry decision is diagnosable", async () => {
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      await resolverWith(ladder(), async () => refusedWholeBody)
        .resolveSource({ source: "youtube", id: VIDEO_ID })
        .catch(() => undefined);
    } finally {
      restore();
      setLogLevel("error");
    }
    const summary = records.find((r) => r.event === "playback_resolution_failed");
    expect(summary?.fields).toMatchObject({
      candidateCount: 2,
      rejectedCount: 2,
      topRejectionReasons: "probe_status_403=2",
      aliveButRefused: true,
    });
    // The new field is a boolean verdict, never evidence about the URL.
    expect(JSON.stringify(records)).not.toContain("cdn.example");
  });
});
