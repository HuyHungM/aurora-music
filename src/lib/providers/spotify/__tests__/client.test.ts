import { describe, expect, it, vi } from "vitest";
import { ExtractorError, TrackNotFoundError } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";
import { createSpotifyApiTransport } from "@/lib/providers/spotify/client";
import type { FetchFn } from "@/lib/providers/spotify/client";
import type { SpotifyTokenSource } from "@/lib/providers/spotify/types";

function tokenSource(token = "tok"): SpotifyTokenSource {
  return {
    getAccessToken: vi.fn(async () => token),
    invalidate: vi.fn(),
  };
}

function jsonFetch(status: number, body: unknown): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("Spotify API transport", () => {
  it("sends bearer tokens", async () => {
    const source = tokenSource("tok-1");
    const fetchFn = jsonFetch(200, { items: [] });
    const transport = createSpotifyApiTransport(source, { fetchFn });
    await transport.search("x", ["track"]);
    const [, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok-1" });
  });

  it("recovers once after a 401 and retries with a fresh token", async () => {
    const source = tokenSource("tok-old");
    let calls = 0;
    const fetchFn: FetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 401, json: async () => ({ error: { message: "expired" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: "t1" }) };
    });
    const transport = createSpotifyApiTransport(source, { fetchFn });
    const result = await transport.getTrack("t1");
    expect(result).toEqual({ id: "t1" });
    expect(source.invalidate).toHaveBeenCalledOnce();
    expect(source.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a second consecutive 401", async () => {
    const source = tokenSource("tok-bad");
    const transport = createSpotifyApiTransport(source, {
      fetchFn: jsonFetch(401, { error: { message: "bad token" } }),
    });
    const error = await transport.getTrack("t1").catch((e) => e);
    expect(error).toBeInstanceOf(InvalidProviderCredentialsError);
    expect(source.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("maps 404 to not-found for tracks", async () => {
    const transport = createSpotifyApiTransport(tokenSource(), {
      fetchFn: jsonFetch(404, { error: { message: "not found" } }),
    });
    await expect(transport.getTrack("t1")).rejects.toBeInstanceOf(TrackNotFoundError);
  });

  it("maps 403 to forbidden failures (never empty)", async () => {
    const transport = createSpotifyApiTransport(tokenSource(), {
      fetchFn: jsonFetch(403, { error: { message: "forbidden" } }),
    });
    const error = await transport.getPlaylistItems("p1").catch((e) => e);
    expect(error).toBeInstanceOf(ExtractorError);
    expect(error).toMatchObject({ retryable: false });
    expect(error.message).toMatch(/forbid/i);
  });

  it("maps 429 and 5xx to retryable failures", async () => {
    const limited = createSpotifyApiTransport(tokenSource(), {
      fetchFn: jsonFetch(429, { error: { message: "slow down" } }),
    });
    await expect(limited.search("x", ["track"])).rejects.toMatchObject({
      retryable: true,
    });
    const down = createSpotifyApiTransport(tokenSource(), {
      fetchFn: jsonFetch(500, {}),
    });
    await expect(down.getTrack("t1")).rejects.toMatchObject({ retryable: true });
  });

  it("maps network failures to retryable failures", async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const transport = createSpotifyApiTransport(tokenSource(), { fetchFn });
    await expect(transport.search("x", ["track"])).rejects.toMatchObject({
      code: "EXTRACTOR_ERROR",
      retryable: true,
    });
  });

  it("rejects malformed envelopes", async () => {
    const transport = createSpotifyApiTransport(tokenSource(), {
      fetchFn: jsonFetch(200, [1, 2]),
    });
    await expect(transport.getTrack("t1")).rejects.toMatchObject({
      name: "ExtractorError",
    });
  });

  it("never serializes tokens or secrets in failures", async () => {
    const transport = createSpotifyApiTransport(tokenSource("tok-secret"), {
      fetchFn: jsonFetch(500, {}),
    });
    const error = await transport.getTrack("t1").catch((e) => e);
    expect(JSON.stringify(error.toJSON())).not.toContain("tok-secret");
  });
});
