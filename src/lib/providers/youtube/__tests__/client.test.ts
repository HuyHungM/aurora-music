import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractorError } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";
import { createYouTubeApiTransport } from "@/lib/providers/youtube/client";
import type { FetchFn } from "@/lib/providers/youtube/client";
import { dataApiCircuit, DataApiCircuit } from "@/lib/providers/youtube/innertube/data-api-circuit";
import { resetYouTubeMetrics } from "@/lib/providers/youtube/innertube/metrics";

function jsonFetch(status: number, body: unknown): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("YouTube API transport", () => {
  /**
   * The quota breaker is process state BY DESIGN — one quota budget, one
   * breaker — so a test that trips it would otherwise suppress calls in every
   * later test in this file. Resetting between tests keeps each assertion
   * about the failure it names, rather than about whichever test ran first.
   */
  beforeEach(() => {
    dataApiCircuit.reset();
    resetYouTubeMetrics();
  });

  it("sends key, parts, and query params", async () => {
    const fetchFn = jsonFetch(200, { items: [] });
    const transport = createYouTubeApiTransport("k123", { fetchFn });
    await transport.searchVideos("Lạc Trôi", { limit: 5 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url] = vi.mocked(fetchFn).mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/youtube/v3/search");
    expect(parsed.searchParams.get("key")).toBe("k123");
    expect(parsed.searchParams.get("type")).toBe("video");
    expect(parsed.searchParams.get("q")).toBe("Lạc Trôi");
    expect(parsed.searchParams.get("maxResults")).toBe("5");
  });

  it("maps quota errors to non-retryable extractor failures", async () => {
    const fetchFn = jsonFetch(403, {
      error: {
        code: 403,
        message: "quota exceeded",
        errors: [{ reason: "quotaExceeded" }],
      },
    });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    const error = await transport.searchVideos("x").catch((e) => e);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(error).toMatchObject({
      code: "EXTRACTOR_ERROR",
      retryable: false,
    });
  });

  it("maps rate-limit errors to retryable failures", async () => {
    const fetchFn = jsonFetch(403, {
      error: {
        errors: [{ reason: "rateLimitExceeded" }],
      },
    });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    const error = await transport.searchVideos("x").catch((e) => e);
    expect(error).toMatchObject({ retryable: true });
  });

  it("maps invalid keys to credential errors", async () => {
    const fetchFn = jsonFetch(400, {
      error: {
        errors: [{ reason: "API_KEY_INVALID" }],
      },
    });
    const transport = createYouTubeApiTransport("bad", { fetchFn });
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InvalidProviderCredentialsError,
    );
  });

  it("maps server errors to retryable failures", async () => {
    const fetchFn = jsonFetch(500, { error: { message: "backend error" } });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    const error = await transport.getVideos(["dQw4w9WgXcQ"]).catch((e) => e);
    expect(error).toMatchObject({ retryable: true });
  });

  it("maps network failures to retryable failures", async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    const error = await transport.searchVideos("x").catch((e) => e);
    expect(error).toMatchObject({
      code: "EXTRACTOR_ERROR",
      retryable: true,
    });
  });

  it("rejects malformed envelopes instead of returning garbage", async () => {
    const fetchFn = jsonFetch(200, { items: "not-an-array" });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    await expect(transport.searchVideos("x")).rejects.toMatchObject({
      name: "ExtractorError",
    });
  });

  it("returns null for missing playlists", async () => {
    const fetchFn = jsonFetch(200, { items: [] });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    await expect(transport.getPlaylist("PL123")).resolves.toBeNull();
  });

  it("serializes every failure without secrets", async () => {
    const fetchFn = jsonFetch(403, {
      error: { errors: [{ reason: "quotaExceeded" }] },
    });
    const transport = createYouTubeApiTransport("k", { fetchFn });
    const error = await transport.searchVideos("x").catch((e) => e);
    const payload = JSON.stringify(error.toJSON());
    expect(payload).not.toContain("k");
  });

  describe("quota circuit (§37, §38)", () => {
    it("stops calling the API once a daily limit is reported", async () => {
      const fetchFn = jsonFetch(403, {
        error: { errors: [{ reason: "dailyLimitExceeded" }] },
      });
      const transport = createYouTubeApiTransport("k", { fetchFn });

      await expect(transport.searchVideos("first")).rejects.toBeInstanceOf(ExtractorError);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // The call-per-request problem: without this, every subsequent user
      // request would spend a round-trip to be told the same thing.
      const second = await transport.searchVideos("second").catch((e: unknown) => e);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(second).toBeInstanceOf(ExtractorError);
      expect((second as InstanceType<typeof ExtractorError>).message).toMatch(
        /Data API is paused/,
      );
    });

    it("recovers by a half-open probe once the window passes, not by a success", async () => {
      // A circuit that refuses every call can never SEE a success, so success
      // cannot be the recovery mechanism. Recovery is the window expiring and
      // the next call going out as a probe. Probing a knowingly-exhausted
      // daily budget every few seconds would be the retry storm this whole
      // phase exists to prevent.
      vi.useFakeTimers();
      try {
        const fetchFn = jsonFetch(403, {
          error: { errors: [{ reason: "quotaExceeded" }] },
        });
        const transport = createYouTubeApiTransport("k", { fetchFn });
        await transport.searchVideos("x").catch(() => undefined);
        await transport.searchVideos("y").catch(() => undefined);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Just before the window closes: still refused, still no traffic.
        vi.advanceTimersByTime(22 * 60 * 60_000);
        await transport.searchVideos("y2").catch(() => undefined);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // After it: the probe goes out.
        vi.advanceTimersByTime(2 * 60 * 60_000);
        (fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        });
        await expect(transport.searchVideos("z")).resolves.toMatchObject({ items: [] });
        expect(fetchFn).toHaveBeenCalledTimes(2);

        // And the successful probe closed it for good, so the next request is
        // a normal call rather than another probe.
        await expect(transport.searchVideos("w")).resolves.toMatchObject({ items: [] });
        expect(fetchFn).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT open the circuit for a non-quota server error", async () => {
      // A 500 is an upstream fault. Opening here would disable the fallback
      // path during exactly the incident the fallback exists for.
      const fetchFn = jsonFetch(500, { error: { message: "backend error" } });
      const transport = createYouTubeApiTransport("k", { fetchFn });
      await transport.searchVideos("a").catch(() => undefined);
      await transport.searchVideos("b").catch(() => undefined);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("accepts an injected breaker so one test cannot poison another", async () => {
      const own = new DataApiCircuit();
      const fetchFn = jsonFetch(403, {
        error: { errors: [{ reason: "quotaExceeded" }] },
      });
      const transport = createYouTubeApiTransport("k", { fetchFn, circuit: own });
      await transport.searchVideos("x").catch(() => undefined);
      expect(own.isOpen()).toBe(true);
      // The process-wide breaker is untouched.
      expect(dataApiCircuit.isOpen()).toBe(false);
    });
  });

  describe("request economy (§27, §29)", () => {
    it("requests only the parts the normalizer actually reads", async () => {
      const fetchFn = jsonFetch(200, { items: [] });
      const transport = createYouTubeApiTransport("k", { fetchFn });
      await transport.getVideos(["dQw4w9WgXcQ"]);
      const [url] = vi.mocked(fetchFn).mock.calls[0] as [string];
      const parsed = new URL(url);
      // `status` was previously requested and never read; `isAvailableVideo`
      // is the only consumer of `privacyStatus` and the provider never calls it.
      expect(parsed.searchParams.get("part")).toBe("snippet,contentDetails");
      expect(parsed.searchParams.get("part")).not.toContain("status");
    });

    it("never asks for more ids than the endpoint accepts", async () => {
      const ids = Array.from({ length: 60 }, (_, index) =>
        `videoId${String(index).padStart(3, "0")}`.slice(0, 11),
      );
      const fetchFn = jsonFetch(200, { items: [] });
      const transport = createYouTubeApiTransport("k", { fetchFn });
      await transport.getVideos(ids);
      const [url] = vi.mocked(fetchFn).mock.calls[0] as [string];
      // `videos.list` caps at 50 ids; sending 60 would have the API silently
      // drop the tail, producing a track list that is quietly incomplete.
      expect(new URL(url).searchParams.get("maxResults")).toBe("50");
    });
  });
});
