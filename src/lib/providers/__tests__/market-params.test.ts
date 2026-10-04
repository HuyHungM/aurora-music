import { describe, expect, it, vi } from "vitest";
import { createSpotifyApiTransport, type FetchFn } from "@/lib/providers/spotify/client";
import type { SpotifyTokenSource } from "@/lib/providers/spotify/types";
import { createYouTubeApiTransport } from "@/lib/providers/youtube/client";
import type { YouTubeSearchResponse } from "@/lib/providers/youtube/types";

/**
 * Provider request parameters for a market.
 *
 * The contract under test is narrow and load-bearing: a known market is sent,
 * an unknown one is NOT sent, and neither case changes what a provider returns
 * for a query it already answered. A provider that received `regionCode=VN` it
 * cannot honour would be worse than one that received nothing.
 */

function tokenSource(): SpotifyTokenSource {
  return { getAccessToken: vi.fn(async () => "tok"), invalidate: vi.fn() };
}

function jsonFetch(body: unknown = { tracks: { items: [] } }): FetchFn {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

function paramsOf(fetchFn: FetchFn, call = 0): URLSearchParams {
  const [url] = vi.mocked(fetchFn).mock.calls[call] as [string, RequestInit];
  return new URL(url).searchParams;
}

describe("Spotify market parameter", () => {
  it("sends `market` when one is supplied", async () => {
    const fetchFn = jsonFetch();
    const transport = createSpotifyApiTransport(tokenSource(), { fetchFn });
    await transport.search("pop", ["track"], { market: "VN" });
    expect(paramsOf(fetchFn).get("market")).toBe("VN");
  });

  it("sends no `market` when none is supplied", async () => {
    const fetchFn = jsonFetch();
    const transport = createSpotifyApiTransport(tokenSource(), { fetchFn });
    await transport.search("pop", ["track"]);
    expect(paramsOf(fetchFn).has("market")).toBe(false);
  });

  it("leaves the query text untouched", async () => {
    // The brief's explicit prohibition. A market is a request parameter; it is
    // never spliced into what the listener typed.
    const fetchFn = jsonFetch();
    const transport = createSpotifyApiTransport(tokenSource(), { fetchFn });
    await transport.search("Taylor Swift", ["track"], { market: "VN" });
    expect(paramsOf(fetchFn).get("q")).toBe("Taylor Swift");
  });

  it("still sends paging alongside the market", async () => {
    const fetchFn = jsonFetch();
    const transport = createSpotifyApiTransport(tokenSource(), { fetchFn });
    await transport.search("pop", ["track"], { limit: 5, offset: 10, market: "VN" });
    const params = paramsOf(fetchFn);
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("10");
    expect(params.get("market")).toBe("VN");
  });
});

describe("YouTube regionCode parameter", () => {
  function youtubeTransport(fetchFn: FetchFn) {
    return createYouTubeApiTransport("test-key", { fetchFn });
  }

  function body(): YouTubeSearchResponse {
    return { items: [] };
  }

  it("sends `regionCode` on a track search when a market is supplied", async () => {
    const fetchFn = jsonFetch(body());
    const transport = youtubeTransport(fetchFn);
    await transport.searchVideos("pop", { regionCode: "VN" });
    expect(paramsOf(fetchFn).get("regionCode")).toBe("VN");
  });

  it("sends no `regionCode` when none is supplied", async () => {
    const fetchFn = jsonFetch(body());
    const transport = youtubeTransport(fetchFn);
    await transport.searchVideos("pop", {});
    expect(paramsOf(fetchFn).has("regionCode")).toBe(false);
  });

  it("leaves the query text untouched", async () => {
    const fetchFn = jsonFetch(body());
    const transport = youtubeTransport(fetchFn);
    await transport.searchVideos("The Weeknd", { regionCode: "VN" });
    expect(paramsOf(fetchFn).get("q")).toBe("The Weeknd");
  });

  it("sends `regionCode` on a channel search too", async () => {
    const fetchFn = jsonFetch(body());
    const transport = youtubeTransport(fetchFn);
    await transport.searchChannels("Sơn Tùng M-TP", { regionCode: "VN" });
    expect(paramsOf(fetchFn).get("regionCode")).toBe("VN");
  });
});
