import { describe, expect, it, vi } from "vitest";
import { ExtractorError } from "@/lib/domain";
import { setLogLevel, setLogSink, type LogRecord } from "@/lib/diagnostics/logger";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";

const VIDEO_ID = "dQw4w9WgXcQ";

interface FakeFormat {
  has_audio: boolean;
  has_video: boolean;
  url?: string;
  signature_cipher?: string;
  cipher?: string;
  mime_type?: string;
  bitrate?: number;
  approx_duration_ms?: number;
  decipher?: (player?: unknown) => Promise<string>;
}

function format(overrides: Partial<FakeFormat> = {}): FakeFormat {
  return {
    has_audio: true,
    has_video: false,
    url: "https://cdn.example/sig.m4a",
    mime_type: "audio/mp4",
    bitrate: 128_000,
    approx_duration_ms: 213_000,
    decipher: async () => "https://cdn.example/deciphered.m4a",
    ...overrides,
  };
}

function sessionWith(options: {
  details?: Record<string, unknown>;
  formats?: FakeFormat[];
  expires?: Date;
  getInfoError?: Error;
}) {
  return {
    player: {},
    getInfo: vi.fn(async () => {
      if (options.getInfoError) {
        throw options.getInfoError;
      }
      return {
        basic_info: {
          title: "Song",
          duration: 213,
          is_private: false,
          is_live_content: false,
          is_upcoming: false,
          ...(options.details ?? {}),
        },
        streaming_data: {
          expires: options.expires ?? new Date(Date.now() + 3600_000),
          adaptive_formats: options.formats ?? [format()],
        },
      };
    }),
  };
}

describe("Innertube playback client", () => {
  it("maps player info to normalized media info with deciphered urls", async () => {
    const session = sessionWith({});
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(info.videoId).toBe(VIDEO_ID);
    expect(info.title).toBe("Song");
    expect(info.durationMs).toBe(213_000);
    expect(info.isPrivate).toBe(false);
    expect(info.expiresAt).toBeInstanceOf(Date);
    expect(info.formats).toEqual([
      {
        url: "https://cdn.example/deciphered.m4a",
        mimeType: "audio/mp4",
        bitrate: 128_000,
        durationMs: 213_000,
        hasAudio: true,
        hasVideo: false,
      },
    ]);
    expect(session.getInfo).toHaveBeenCalledWith(VIDEO_ID, { client: "MWEB" });
  });

  it("requests the MWEB player context that materializes adaptive audio", async () => {
    // Runtime finding: the default WEB context withholds all stream URL
    // material (direct + cipher) for adaptive formats, so resolution
    // fails with zero candidates. MWEB materializes them.
    const session = sessionWith({});
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    await client.getMediaInfo(VIDEO_ID);
    expect(session.getInfo).toHaveBeenNthCalledWith(1, VIDEO_ID, {
      client: "MWEB",
    });
  });

  it("skips cipher formats whose deciphering yields no url", async () => {
    const session = sessionWith({
      formats: [
        format({
          url: undefined,
          signature_cipher: "s=abc&sp=sig",
          decipher: async () => "",
        }),
        format({ has_audio: false, has_video: true }),
      ],
    });
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(info.formats).toEqual([]);
  });

  it("deciphers ciphered formats that carry no direct url", async () => {
    // Real YouTube responses serve `signature_cipher` + decipher hook with
    // `url` undefined (Phase 17 runtime finding). Gating on a present URL
    // dropped every such format before deciphering was ever attempted.
    const session = sessionWith({
      formats: [
        format({
          url: undefined,
          signature_cipher: "s=abc&sp=sig",
          decipher: async () => "https://cdn.example/ciphered.m4a",
        }),
      ],
    });
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(info.formats).toEqual([
      {
        url: "https://cdn.example/ciphered.m4a",
        mimeType: "audio/mp4",
        bitrate: 128_000,
        durationMs: 213_000,
        hasAudio: true,
        hasVideo: false,
      },
    ]);
  });

  it("falls back to the explicit IOS context when MWEB yields no usable candidates", async () => {
    // A format with neither a URL nor a cipher payload is not usable; if MWEB
    // materializes only those, extraction is empty and the explicit fallback
    // (never the session-default WEB via `undefined`) is used.
    const cipherless = format({
      url: undefined,
      signature_cipher: undefined,
      cipher: undefined,
    });
    const muxed = format({
      has_video: true,
      url: undefined,
      signature_cipher: "s=abc&sp=sig",
      mime_type: "video/mp4",
      decipher: async () => "https://cdn.example/muxed.mp4",
    });
    const streaming = (formats: FakeFormat[]) => ({
      basic_info: {
        title: "Song",
        duration: 213,
        is_private: false,
        is_live_content: false,
        is_upcoming: false,
      },
      streaming_data: {
        expires: new Date(Date.now() + 3600_000),
        adaptive_formats: formats,
      },
    });
    const getInfo = vi.fn(
      async (_videoId: unknown, options?: { client?: string }) =>
        options?.client === "MWEB"
          ? streaming([cipherless])
          : streaming([muxed]),
    );
    const session = { player: {}, getInfo };
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(getInfo).toHaveBeenNthCalledWith(1, VIDEO_ID, { client: "MWEB" });
    // The fallback is an explicit verified client, never `undefined` (WEB).
    expect(getInfo).toHaveBeenNthCalledWith(2, VIDEO_ID, { client: "IOS" });
    expect(info.formats).toEqual([
      {
        url: "https://cdn.example/muxed.mp4",
        mimeType: "video/mp4",
        bitrate: 128_000,
        durationMs: 213_000,
        hasAudio: true,
        hasVideo: true,
      },
    ]);
  });

  it("does not fall back when MWEB reports the video unavailable", async () => {
    const getInfo = vi.fn(async () => {
      throw new Error("Video unavailable");
    });
    const session = { player: {}, getInfo };
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const error = await client.getMediaInfo(VIDEO_ID).catch((cause) => cause);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(error).toMatchObject({ retryable: false });
    expect(getInfo).toHaveBeenCalledTimes(1);
  });

  it("falls back when the MWEB request fails retryably", async () => {
    const getInfo = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        basic_info: {
          title: "Song",
          duration: 213,
          is_private: false,
          is_live_content: false,
          is_upcoming: false,
        },
        streaming_data: {
          expires: new Date(Date.now() + 3600_000),
          adaptive_formats: [format()],
        },
      });
    const session = { player: {}, getInfo };
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(info.formats).toHaveLength(1);
  });

  it("flags private, live, and upcoming videos", async () => {
    for (const details of [
      { is_private: true },
      { is_live_content: true },
      { is_upcoming: true },
    ]) {
      const session = sessionWith({ details });
      const client = createInnertubePlaybackClient({
        sessionFactory: async () => session as never,
      });
      const info = await client.getMediaInfo(VIDEO_ID);
      expect(
        info.isPrivate || info.isLiveContent || info.isUpcoming,
      ).toBe(true);
    }
  });

  it("maps unavailable videos to non-retryable failures", async () => {
    const session = sessionWith({ getInfoError: new Error("Video unavailable") });
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const error = await client.getMediaInfo(VIDEO_ID).catch((cause) => cause);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(error).toMatchObject({ retryable: false });
    expect(String(error.message)).not.toContain("cdn.example");
  });

  it("maps network failures to retryable failures", async () => {
    const session = sessionWith({ getInfoError: new TypeError("fetch failed") });
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    await expect(client.getMediaInfo(VIDEO_ID)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("shares one in-flight request for simultaneous resolutions", async () => {
    const session = sessionWith({});
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const [first, second] = await Promise.all([
      client.getMediaInfo(VIDEO_ID),
      client.getMediaInfo(VIDEO_ID),
    ]);
    expect(session.getInfo).toHaveBeenCalledTimes(1);
    expect(first.title).toBe(second.title);
  });

  it("never caches results: re-resolution refetches", async () => {
    const session = sessionWith({});
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    await client.getMediaInfo(VIDEO_ID);
    await client.getMediaInfo(VIDEO_ID);
    expect(session.getInfo).toHaveBeenCalledTimes(2);
  });
});

describe("format gate and extraction diagnostics", () => {
  it("rejects a format whose decipher method exists but that carries no URL or cipher payload", async () => {
    // `decipher` is a prototype method on every Format, so its existence says
    // nothing about this entry. With no url and no cipher it must be rejected.
    const session = sessionWith({
      formats: [
        format({ url: undefined, signature_cipher: undefined, cipher: undefined }),
      ],
    });
    const client = createInnertubePlaybackClient({
      sessionFactory: async () => session as never,
    });
    const info = await client.getMediaInfo(VIDEO_ID);
    expect(info.formats).toEqual([]);
  });

  it("records a thrown decipher failure in structured diagnostics", async () => {
    const records: LogRecord[] = [];
    setLogLevel("debug");
    const restore = setLogSink((record) => records.push(record));
    try {
      const session = sessionWith({
        formats: [
          format({
            url: undefined,
            signature_cipher: "s=abc&sp=sig",
            decipher: async () => {
              throw new Error("No valid URL to decipher");
            },
          }),
        ],
      });
      const client = createInnertubePlaybackClient({
        sessionFactory: async () => session as never,
      });
      const info = await client.getMediaInfo(VIDEO_ID);
      expect(info.formats).toEqual([]);
    } finally {
      restore();
      setLogLevel("error");
    }
    const failure = records.find(
      (record) => record.event === "playback_decipher_failed",
    );
    expect(failure).toBeDefined();
    expect(failure?.fields).toMatchObject({
      client: "MWEB",
      directUrlPresent: false,
      cipherPresent: true,
      reason: "decipher_threw",
    });
    expect(String(failure?.fields.errorMessage)).toContain("No valid URL");
    // No signed media URL may reach the log.
    expect(JSON.stringify(records)).not.toContain("cdn.example");
  });

  it("summarizes an empty extraction with counts, not a bare zero", async () => {
    const records: LogRecord[] = [];
    setLogLevel("debug");
    const restore = setLogSink((record) => records.push(record));
    try {
      const session = sessionWith({
        formats: [
          format({
            url: undefined,
            signature_cipher: "s=abc&sp=sig",
            decipher: async () => "",
          }),
          format({ has_audio: false, has_video: true }),
        ],
      });
      const client = createInnertubePlaybackClient({
        sessionFactory: async () => session as never,
      });
      await client.getMediaInfo(VIDEO_ID);
    } finally {
      restore();
      setLogLevel("error");
    }
    const summary = records.find(
      (record) => record.event === "playback_extraction_empty",
    );
    expect(summary).toBeDefined();
    expect(summary?.fields).toMatchObject({
      client: "MWEB",
      formatsSeen: 2,
      formatsWithPlayablePayload: 1,
      decipherAttempts: 1,
      decipherSuccesses: 0,
      decipherFailures: 1,
    });
  });
});
