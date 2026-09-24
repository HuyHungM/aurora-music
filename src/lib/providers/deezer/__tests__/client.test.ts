import { describe, expect, it, vi } from "vitest";
import { ExtractorError, TrackNotFoundError } from "@/lib/domain";
import { createDeezerApiTransport } from "@/lib/providers/deezer/client";
import type { FetchFn } from "@/lib/providers/deezer/client";

function jsonFetch(status: number, body: unknown): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("Deezer API transport", () => {
  it("sends query and paging params", async () => {
    const fetchFn = jsonFetch(200, { data: [], total: 0 });
    const transport = createDeezerApiTransport({ fetchFn });
    await transport.searchTracks("Lạc Trôi", { limit: 5, index: 10 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url] = vi.mocked(fetchFn).mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.deezer.com/search");
    expect(parsed.searchParams.get("q")).toBe("Lạc Trôi");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.get("index")).toBe("10");
  });

  it("maps code 800 to not-found for exact track lookup", async () => {
    const fetchFn = jsonFetch(200, {
      error: { type: "DataException", message: "no data", code: 800 },
    });
    const transport = createDeezerApiTransport({ fetchFn });
    await expect(transport.getTrack("999999999")).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });

  it("maps code 800 to typed not-found failures for other lookups", async () => {
    const fetchFn = jsonFetch(200, {
      error: { type: "DataException", message: "no data", code: 800 },
    });
    const transport = createDeezerApiTransport({ fetchFn });
    await expect(transport.getArtist("1")).rejects.toMatchObject({
      name: "ExtractorError",
      retryable: false,
    });
  });

  it("maps quota envelopes to retryable failures", async () => {
    const fetchFn = jsonFetch(200, {
      error: { type: "QuotaException", message: "quota", code: 4 },
    });
    const transport = createDeezerApiTransport({ fetchFn });
    const error = await transport.searchTracks("x").catch((e) => e);
    expect(error).toMatchObject({ code: "EXTRACTOR_ERROR", retryable: true });
  });

  it("maps HTTP 429 and 5xx to retryable failures", async () => {
    const rateLimited = createDeezerApiTransport({
      fetchFn: jsonFetch(429, {}),
    });
    await expect(rateLimited.searchTracks("x")).rejects.toMatchObject({
      retryable: true,
    });
    const unavailable = createDeezerApiTransport({
      fetchFn: jsonFetch(503, {}),
    });
    await expect(unavailable.getTrack("1")).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("maps network failures to retryable failures", async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const transport = createDeezerApiTransport({ fetchFn });
    const error = await transport.searchTracks("x").catch((e) => e);
    expect(error).toMatchObject({ code: "EXTRACTOR_ERROR", retryable: true });
  });

  it("rejects malformed object responses", async () => {
    const transport = createDeezerApiTransport({
      fetchFn: jsonFetch(200, [1, 2, 3]),
    });
    await expect(transport.getTrack("1")).rejects.toBeInstanceOf(ExtractorError);
  });

  it("serializes failures without secrets", async () => {
    const fetchFn = jsonFetch(200, {
      error: { type: "QuotaException", message: "quota", code: 4 },
    });
    const transport = createDeezerApiTransport({ fetchFn });
    const error = await transport.searchTracks("x").catch((e) => e);
    expect(() => JSON.stringify(error.toJSON())).not.toThrow();
  });
});
