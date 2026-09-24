import { describe, expect, it, vi } from "vitest";
import { ExtractorError } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";
import { createYouTubeApiTransport } from "@/lib/providers/youtube/client";
import type { FetchFn } from "@/lib/providers/youtube/client";

function jsonFetch(status: number, body: unknown): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("YouTube API transport", () => {
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
});
