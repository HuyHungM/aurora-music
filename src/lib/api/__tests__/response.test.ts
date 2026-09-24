import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiError, MissingResultsError } from "@/lib/errors";
import type { Track } from "@/lib/domain";
import { getList, unwrapResults } from "@/lib/api";
import type { ApiListEnvelope } from "@/lib/api";

const track: Track = {
  id: "t1",
  provider: "jamendo",
  title: "Interstellar",
  artistId: "a1",
  artistName: "Aurora",
};

describe("unwrapResults", () => {
  it("returns results when present", () => {
    const envelope: ApiListEnvelope<Track[]> = { results: [track] };
    expect(unwrapResults(envelope)).toEqual([track]);
  });

  it("throws MissingResultsError when results is absent", () => {
    const envelope: ApiListEnvelope<Track[]> = {};
    expect(() => unwrapResults(envelope)).toThrow(MissingResultsError);
  });
});

describe("generic list semantics", () => {
  it("keeps T as the final payload type (results?: T, never T[])", () => {
    const envelope: ApiListEnvelope<Track[]> = { results: [track] };
    const result = unwrapResults(envelope);
    expectTypeOf(result).toEqualTypeOf<Track[]>();
    expectTypeOf(envelope.results).toEqualTypeOf<Track[] | undefined>();
  });
});

describe("getList", () => {
  it("fetches and unwraps results as the payload type", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [track], total: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const tracks = await getList<Track[]>("/api/tracks?limit=1");
    expect(tracks).toEqual([track]);
    expect(mockFetch).toHaveBeenCalledWith("/api/tracks?limit=1", undefined);
  });

  it("throws ApiError with status on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await getList<Track[]>("/api/tracks").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBe(500);
      expect(error.message).toContain("boom");
    }
  });
});