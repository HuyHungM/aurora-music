import { describe, expect, it, vi } from "vitest";
import type {
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "@/lib/providers/youtube/playback/types";
import {
  createYouTubeResolver,
  getResolverDedupeSharedCount,
  resetResolverDedupeSharedCount,
} from "@/lib/providers/youtube/playback/youtube-resolver";
import {
  PlaybackResolutionCache,
  configureResolutionCache,
  sharedResolutionCache,
} from "@/lib/providers/youtube/playback/resolution-cache";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";

const VIDEO_ID = "dQw4w9WgXcQ";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function media(overrides: Partial<PlaybackMediaInfo> = {}): PlaybackMediaInfo {
  return {
    videoId: VIDEO_ID,
    title: "Song",
    durationMs: 213_000,
    formats: [
      {
        url: "https://cdn.example/audio.m4a",
        mimeType: "audio/mp4",
        bitrate: 128_000,
        hasAudio: true,
        hasVideo: false,
      },
    ],
    expiresAt: new Date(Date.now() + 6 * 3_600_000),
    ...overrides,
  };
}

function trackingClient(info: PlaybackMediaInfo | Error, latencyMs = 0) {
  const getMediaInfo = vi.fn(async () => {
    if (latencyMs > 0) {
      await delay(latencyMs);
    }
    if (info instanceof Error) {
      throw info;
    }
    return info;
  });
  return { client: { getMediaInfo } as YouTubePlaybackClient, getMediaInfo };
}

function resolverWith(
  client: YouTubePlaybackClient,
  cache: PlaybackResolutionCache | null = new PlaybackResolutionCache(),
  probeLatencyMs = 0,
) {
  return createYouTubeResolver(client, {
    validateFormat: async () => {
      if (probeLatencyMs > 0) {
        await delay(probeLatencyMs);
      }
      return true;
    },
    cache,
  });
}

describe("YouTubeResolver cache + singleflight", () => {
  it("resolves cold, then serves the repeat from cache without upstream work", async () => {
    const { client, getMediaInfo } = trackingClient(media());
    const probe = vi.fn(async () => true);
    const cache = new PlaybackResolutionCache();
    const resolver = createYouTubeResolver(client, { validateFormat: probe, cache });

    const first = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(getMediaInfo).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);

    const second = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(second).toEqual(first);
    expect(getMediaInfo).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("coalesces three concurrent resolutions into one upstream chain", async () => {
    const { client, getMediaInfo } = trackingClient(media(), 40);
    const probe = vi.fn(async () => {
      await delay(10);
      return true;
    });
    const cache = new PlaybackResolutionCache();
    const resolver = createYouTubeResolver(client, { validateFormat: probe, cache });
    resetResolverDedupeSharedCount();

    const [a, b, c] = await Promise.all([
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(getMediaInfo).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(getResolverDedupeSharedCount()).toBe(2);
  });

  it("cleans up the shared promise after failure so the next attempt retries", async () => {
    const failing = trackingClient(new Error("boom"));
    const cache = new PlaybackResolutionCache();
    const first = resolverWith(failing.client, cache);
    await expect(
      first.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toThrow();
    // Retryable failures are never negatively cached: a later attempt with a
    // healthy client must start fresh upstream work, not replay the failure.
    const healthy = trackingClient(media());
    const second = resolverWith(healthy.client, cache);
    const source = await second.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(source.url).toBe("https://cdn.example/audio.m4a");
    expect(healthy.getMediaInfo).toHaveBeenCalledTimes(1);
  });

  it("cools down hard failures briefly, then retries", async () => {
    let now = 1_000_000;
    const cache = new PlaybackResolutionCache({ now: () => now });
    const { client, getMediaInfo } = trackingClient(media({ isPrivate: true }));
    const resolver = resolverWith(client, cache);

    await expect(
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError" });
    expect(getMediaInfo).toHaveBeenCalledTimes(1);

    // Inside the cooldown: refused without upstream work.
    await expect(
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toMatchObject({ retryable: false });
    expect(getMediaInfo).toHaveBeenCalledTimes(1);
    expect(cache.getStats().negativeHits).toBe(1);

    now += 11_000;
    await expect(
      resolver.resolveSource({ source: "youtube", id: VIDEO_ID }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError" });
    expect(getMediaInfo).toHaveBeenCalledTimes(2);
  });

  it("serves stale immediately while refreshing in the background", async () => {
    let now = 1_000_000;
    const cache = new PlaybackResolutionCache({ now: () => now, ttlMs: 1_000, staleGraceMs: 60_000 });
    const first = trackingClient(media());
    const resolver = resolverWith(first.client, cache);
    const fresh = await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(first.getMediaInfo).toHaveBeenCalledTimes(1);

    // Past TTL, inside grace: the stale source returns synchronously while a
    // background refresh re-resolves behind it.
    now += 5_000;
    const second = trackingClient(media());
    const refreshing = resolverWith(second.client, cache);
    const served = await refreshing.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(served).toEqual(fresh);
    await vi.waitFor(() => {
      expect(second.getMediaInfo).toHaveBeenCalledTimes(1);
    });
    // The refreshed entry is fresh again for the next caller.
    now += 500;
    const third = trackingClient(media());
    const afterRefresh = resolverWith(third.client, cache);
    await afterRefresh.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(third.getMediaInfo).not.toHaveBeenCalled();
  });

  it("re-resolves when the cached URL is near expiration", async () => {
    // The fake clock must live in real time here: the resolver's own
    // already-expired guard reads the real clock, so 1970-based dates would
    // fail there instead of exercising the cache's skew policy.
    let now = Date.now();
    const cache = new PlaybackResolutionCache({ now: () => now, expirySkewMs: 30_000 });
    const first = trackingClient(media({ expiresAt: new Date(now + 120_000) }));
    await resolverWith(first.client, cache).resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    expect(first.getMediaInfo).toHaveBeenCalledTimes(1);

    // 100s later the URL dies in 20s — inside the skew window, so unusable.
    now += 100_000;
    const second = trackingClient(media({ expiresAt: new Date(now + 300_000) }));
    await resolverWith(second.client, cache).resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    expect(second.getMediaInfo).toHaveBeenCalledTimes(1);
  });

  it("never logs a signed URL on any cache path", async () => {
    const records: LogRecord[] = [];
    const restoreSink = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      let now = Date.now();
      const cache = new PlaybackResolutionCache({
        now: () => now,
        ttlMs: 1_000,
        staleGraceMs: 60_000,
      });
      const { client, getMediaInfo } = trackingClient(media());
      const resolver = resolverWith(client, cache);
      await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
      await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
      now += 5_000;
      await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
      // The stale serve above triggers a background refresh; wait for it so
      // every log line this flow can emit is captured before asserting.
      await vi.waitFor(() => {
        expect(getMediaInfo).toHaveBeenCalledTimes(2);
      });
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("cdn.example");
      expect(serialized).not.toContain("googlevideo");
      expect(records.length).toBeGreaterThan(0);
    } finally {
      restoreSink();
      setLogLevel("error");
    }
  });

  it("resolves without a cache when disabled", async () => {
    const { client, getMediaInfo } = trackingClient(media());
    const resolver = resolverWith(client, null);
    await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    await resolver.resolveSource({ source: "youtube", id: VIDEO_ID });
    expect(getMediaInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps the shared process cache across resolver instances", async () => {
    // Isolated from every other test: a fresh shared instance, so an entry
    // left here cannot serve a later case (or vice versa).
    configureResolutionCache();
    const first = trackingClient(media());
    await resolverWith(first.client, sharedResolutionCache()).resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    const second = trackingClient(media());
    await resolverWith(second.client, sharedResolutionCache()).resolveSource({
      source: "youtube",
      id: VIDEO_ID,
    });
    // One upstream resolution total: the second resolver instance — as a new
    // server action invocation would construct — still hits the shared cache.
    expect(first.getMediaInfo).toHaveBeenCalledTimes(1);
    expect(second.getMediaInfo).not.toHaveBeenCalled();
    configureResolutionCache();
  });
});
