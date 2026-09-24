import { describe, expect, it, vi } from "vitest";
import { ExtractorError } from "@/lib/domain";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";

const VIDEO_ID = "dQw4w9WgXcQ";

interface FakeFormat {
  has_audio: boolean;
  has_video: boolean;
  url?: string;
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

  it("skips formats that cannot produce a url", async () => {
    const session = sessionWith({
      formats: [
        format({ url: undefined, decipher: async () => "" }),
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

  it("falls back to the default context when MWEB yields no usable candidates", async () => {
    // Cipherless adaptive formats carry no url and no decipher hook, so
    // toCandidate drops them before deciphering is ever attempted.
    const cipherless = format({ url: undefined, decipher: undefined });
    const muxed = format({
      has_video: true,
      url: undefined,
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
    // Fallback uses the bare call: byte-for-byte previous behavior.
    expect(getInfo.mock.calls[1]).toEqual([VIDEO_ID]);
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

describe("player script evaluator", () => {
  it("evaluates extracted scripts in an isolated context", async () => {
    const { evaluatePlayerScript } = await import(
      "@/lib/providers/youtube/playback/innertube-client"
    );
    expect(
      evaluatePlayerScript({ output: "return { sig: 'abc', n: '1' };" }, { s: "x" }),
    ).toEqual({ sig: "abc", n: "1" });
  });

  it("fails closed on non-object or throwing scripts", async () => {
    const { evaluatePlayerScript } = await import(
      "@/lib/providers/youtube/playback/innertube-client"
    );
    expect(evaluatePlayerScript({ output: "(() => { throw new Error('x'); })()" }, {})).toBeUndefined();
    expect(evaluatePlayerScript({ output: "42" }, {})).toBeUndefined();
  });

  it("reads the nested session player without touching internals blindly", async () => {
    const { sessionPlayer } = await import(
      "@/lib/providers/youtube/playback/innertube-client"
    );
    const player = { signature_timestamp: 1 };
    expect(sessionPlayer({ session: { player } })).toBe(player);
    expect(sessionPlayer({})).toBeUndefined();
    expect(sessionPlayer(null)).toBeUndefined();
  });

  it("installs the evaluator idempotently", async () => {
    const { ensureJsEvaluator } = await import(
      "@/lib/providers/youtube/playback/innertube-client"
    );
    expect(() => {
      ensureJsEvaluator();
      ensureJsEvaluator();
    }).not.toThrow();
  });
});
