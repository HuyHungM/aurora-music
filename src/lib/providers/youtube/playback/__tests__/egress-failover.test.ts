import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractorError } from "@/lib/domain";
import { setLogLevel, setLogSink, type LogRecord } from "@/lib/diagnostics/logger";
import {
  EGRESS_COOLDOWN_MS,
  createFailoverBreakerState,
  createFailoverYouTubePlaybackClient,
  readFailoverProxyConfig,
  type FailoverBreakerState,
} from "@/lib/providers/youtube/playback/egress-failover";
import type { EnvConfig } from "@/lib/config/env";
import type {
  PlaybackFormatCandidate,
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "@/lib/providers/youtube/playback/types";

const PRIMARY_VIDEO = "BWNkgqKZP0Q";
const LOGIN_VIDEO = "kJQP7kiw5Fk";
const EMPTY_VIDEO = "dQw4w9WgXcQ";
const FAILED_VIDEO = "jNQXAC9IVRw";

function candidate(videoId: string, index: number): PlaybackFormatCandidate {
  return {
    url: `https://cdn.example/${videoId}/${index}.m4a`,
    mimeType: "audio/mp4",
    bitrate: 128_000,
    hasAudio: true,
    hasVideo: false,
  };
}

function media(videoId: string, count: number): PlaybackMediaInfo {
  return {
    videoId,
    title: `Song ${videoId}`,
    formats: Array.from({ length: count }, (_, index) => candidate(videoId, index)),
  };
}

function emptyMedia(videoId: string): PlaybackMediaInfo {
  return { videoId, title: `Song ${videoId}`, formats: [] };
}

function mediaClient(result: PlaybackMediaInfo) {
  const getMediaInfo = vi.fn(async () => result);
  return { client: { getMediaInfo } as YouTubePlaybackClient, getMediaInfo };
}

function throwingClient(error: unknown) {
  const getMediaInfo = vi.fn(async (): Promise<PlaybackMediaInfo> => {
    throw error;
  });
  return { client: { getMediaInfo } as YouTubePlaybackClient, getMediaInfo };
}

function timeoutError(message: string): ExtractorError {
  return new ExtractorError("youtube", "getMediaInfo", message, { retryable: true });
}

function loginError(videoId: string): ExtractorError {
  return new ExtractorError(
    "youtube",
    "getMediaInfo",
    `Video unavailable: ${videoId}`,
    {
      cause: new Error("LOGIN_REQUIRED: Sign in to confirm you are not a bot"),
    },
  );
}

function envWith(overrides: Partial<EnvConfig>): EnvConfig {
  return {
    DATABASE_URL: "postgresql://localhost:5432/aurora_test",
    NODE_ENV: "test",
    ...overrides,
  };
}

describe("temporary YouTube egress failover", () => {
  let records: LogRecord[] = [];
  let restoreSink: (() => void) | null = null;

  beforeEach(() => {
    records = [];
    setLogLevel("debug");
    restoreSink = setLogSink((record) => {
      records.push(record);
    });
  });

  afterEach(() => {
    restoreSink?.();
    restoreSink = null;
    setLogLevel("error");
  });

  function attempts(): LogRecord[] {
    return records.filter((record) => record.event === "youtube.egress_attempt");
  }

  function serializedLogs(): string {
    return JSON.stringify(records);
  }

  it("returns primary candidates without touching secondary", async () => {
    const primary = mediaClient(media(PRIMARY_VIDEO, 7));
    const secondary = mediaClient(media(PRIMARY_VIDEO, 5));
    const breaker = createFailoverBreakerState();
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: primary.client, secondary: secondary.client },
      breaker,
      now: () => 1_000,
    });

    const info = await client.getMediaInfo(PRIMARY_VIDEO);

    expect(info.formats).toHaveLength(7);
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(secondary.getMediaInfo).not.toHaveBeenCalled();
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]?.fields).toMatchObject({
      proxy: "primary",
      videoId: PRIMARY_VIDEO,
      success: true,
      candidateCount: 7,
      failureCategory: "none",
    });
    expect(breaker.primary.consecutiveFailures).toBe(0);
  });

  it("fails over when primary reports LOGIN_REQUIRED", async () => {
    const primary = throwingClient(loginError(LOGIN_VIDEO));
    const secondary = mediaClient(media(LOGIN_VIDEO, 5));
    const breaker = createFailoverBreakerState();
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: primary.client, secondary: secondary.client },
      breaker,
      now: () => 2_000,
    });

    const info = await client.getMediaInfo(LOGIN_VIDEO);

    expect(info.formats).toHaveLength(5);
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(attempts().map((record) => record.fields)).toEqual([
      expect.objectContaining({
        proxy: "primary",
        videoId: LOGIN_VIDEO,
        success: false,
        candidateCount: 0,
        failureCategory: "login_required",
      }),
      expect.objectContaining({
        proxy: "secondary",
        videoId: LOGIN_VIDEO,
        success: true,
        candidateCount: 5,
        failureCategory: "none",
      }),
    ]);
    expect(breaker.primary.consecutiveFailures).toBe(1);
    expect(breaker.secondary.consecutiveFailures).toBe(0);
  });

  it("fails over when primary returns zero candidates", async () => {
    const primary = mediaClient(emptyMedia(EMPTY_VIDEO));
    const secondary = mediaClient(media(EMPTY_VIDEO, 3));
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: primary.client, secondary: secondary.client },
      breaker: createFailoverBreakerState(),
      now: () => 3_000,
    });

    const info = await client.getMediaInfo(EMPTY_VIDEO);

    expect(info.formats).toHaveLength(3);
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(attempts().map((record) => record.fields.failureCategory)).toEqual([
      "zero_candidates",
      "none",
    ]);
  });

  it("tries each egress once when both fail and never logs secrets", async () => {
    const proxySecret = "http://user:pass@primary.example:8080";
    const signedUrl = "https://cdn.example/signed-audio.m4a?sig=secret-signature";
    const primary = throwingClient(timeoutError(`Timed out via ${proxySecret}`));
    const secondary = throwingClient(new TypeError(`fetch failed for ${signedUrl}`));
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: primary.client, secondary: secondary.client },
      breaker: createFailoverBreakerState(),
      now: () => 4_000,
    });

    await expect(client.getMediaInfo(FAILED_VIDEO)).rejects.toThrow("fetch failed");
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(attempts().map((record) => record.fields.failureCategory)).toEqual([
      "timeout",
      "connection",
    ]);
    expect(serializedLogs()).not.toContain("primary.example");
    expect(serializedLogs()).not.toContain("user:pass");
    expect(serializedLogs()).not.toContain("cdn.example");
    expect(serializedLogs()).not.toContain("secret-signature");
  });

  it("rests both egresses after three consecutive failures, then retries", async () => {
    const clock = { now: 0 };
    const primary = throwingClient(timeoutError("primary timed out"));
    const secondary = throwingClient(timeoutError("secondary timed out"));
    const breaker: FailoverBreakerState = createFailoverBreakerState();
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: primary.client, secondary: secondary.client },
      breaker,
      now: () => clock.now,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.getMediaInfo(FAILED_VIDEO)).rejects.toThrow("timed out");
    }
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(3);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(3);
    expect(breaker.primary.cooldownUntil).toBe(EGRESS_COOLDOWN_MS);
    expect(breaker.secondary.cooldownUntil).toBe(EGRESS_COOLDOWN_MS);

    await expect(client.getMediaInfo(FAILED_VIDEO)).rejects.toMatchObject({
      name: "ExtractorError",
      retryable: true,
    });
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(3);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(3);
    expect(
      attempts()
        .slice(-2)
        .map((record) => record.fields.failureCategory),
    ).toEqual(["circuit_open", "circuit_open"]);

    clock.now = EGRESS_COOLDOWN_MS;
    await expect(client.getMediaInfo(FAILED_VIDEO)).rejects.toThrow("timed out");
    expect(primary.getMediaInfo).toHaveBeenCalledTimes(4);
    expect(secondary.getMediaInfo).toHaveBeenCalledTimes(4);
  });

  it("resets consecutive failures after a healthy primary request", async () => {
    const getMediaInfo = vi
      .fn<(_videoId: string) => Promise<PlaybackMediaInfo>>()
      .mockRejectedValueOnce(timeoutError("primary timed out"))
      .mockResolvedValueOnce(media(PRIMARY_VIDEO, 2));
    const breaker = createFailoverBreakerState();
    const client = createFailoverYouTubePlaybackClient({
      clients: { primary: { getMediaInfo } as YouTubePlaybackClient },
      breaker,
      now: () => 5_000,
    });

    await expect(client.getMediaInfo(PRIMARY_VIDEO)).rejects.toThrow("timed out");
    expect(breaker.primary.consecutiveFailures).toBe(1);

    const info = await client.getMediaInfo(PRIMARY_VIDEO);
    expect(info.formats).toHaveLength(2);
    expect(breaker.primary.consecutiveFailures).toBe(0);
    expect(breaker.primary.cooldownUntil).toBe(0);
  });

  it("prefers explicit primary and falls back to the legacy proxy variable", () => {
    expect(
      readFailoverProxyConfig(
        envWith({
          AURORA_YOUTUBE_EGRESS_PROXY: "http://legacy.example:8080",
          AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY: "http://primary.example:8080",
          AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY: "http://secondary.example:8080",
        }),
      ),
    ).toEqual({
      primaryUrl: "http://primary.example:8080",
      secondaryUrl: "http://secondary.example:8080",
    });

    expect(
      readFailoverProxyConfig(
        envWith({
          AURORA_YOUTUBE_EGRESS_PROXY: "http://legacy.example:8080",
          AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY: "http://secondary.example:8080",
        }),
      ),
    ).toEqual({
      primaryUrl: "http://legacy.example:8080",
      secondaryUrl: "http://secondary.example:8080",
    });

    expect(
      readFailoverProxyConfig(
        envWith({ AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY: "http://secondary.example:8080" }),
      ),
    ).toBeNull();
  });
});
