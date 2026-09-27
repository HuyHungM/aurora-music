import { describe, expect, it, vi } from "vitest";
import { track } from "@/lib/music/__tests__/fake-backend";
import type { DetectedSource } from "@/lib/providers/source-detection";
import {
  LINK_COLLECTION_LIMIT,
  LINK_MATCH_CANDIDATES,
  LINK_MATCH_CONCURRENCY,
  SearchLinkError,
  resolveSearchLink,
  type ProviderCollection,
  type SearchLinkDeps,
} from "@/lib/search/resolve-link";

/**
 * The resolution half of the link-search matrix (§15 of the feature report).
 *
 * Every provider operation is injected, so none of this touches the network.
 * What is being locked down is ROUTING: which lookup is called, how many
 * times, with what, and what survives when one of them fails.
 */

const YT_ID = "dQw4w9WgXcQ";
const SPOTIFY_ID = "4uLU6hMCjMI75M1A2tKUQ3";

const YT_SOURCE: DetectedSource = {
  provider: "youtube",
  kind: "track",
  id: YT_ID,
  url: `https://youtu.be/${YT_ID}`,
};

const SPOTIFY_SOURCE: DetectedSource = {
  provider: "spotify",
  kind: "track",
  id: SPOTIFY_ID,
  url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
};

const SPOTIFY_ALBUM_SOURCE: DetectedSource = {
  provider: "spotify",
  kind: "album",
  id: SPOTIFY_ID,
  url: `https://open.spotify.com/album/${SPOTIFY_ID}`,
};

const YT_PLAYLIST_SOURCE: DetectedSource = {
  provider: "youtube",
  kind: "playlist",
  id: "PLabc123",
  url: "https://www.youtube.com/playlist?list=PLabc123",
};

const SPOTIFY_PLAYLIST_SOURCE: DetectedSource = {
  provider: "spotify",
  kind: "playlist",
  id: SPOTIFY_ID,
  url: `https://open.spotify.com/playlist/${SPOTIFY_ID}`,
};

/** The same song, as two providers would describe it (strong match). */
function song(provider: string, id: string) {
  return track(provider, {
    id,
    providerTrackId: id,
    title: "Lạc Trôi",
    artistId: `${provider}-st`,
    artistName: "Sơn Tùng M-TP",
    duration: 243,
    providerUrl: `https://example.invalid/${provider}/${id}`,
  });
}

/**
 * A distinct song per index.
 *
 * `song()` above is deliberately ONE song; a collection of those would
 * canonical-dedupe to a single row, so collection fixtures need rows that are
 * different recordings if a test is going to assert how many rows survive.
 */
function distinctSong(provider: string, id: string, index: number) {
  return track(provider, {
    id,
    providerTrackId: id,
    title: `Track number ${index}`,
    artistId: `${provider}-a${index}`,
    artistName: `Artist ${index}`,
    duration: 180 + index,
    providerUrl: `https://example.invalid/${provider}/${id}`,
  });
}

function deps(overrides: Partial<SearchLinkDeps> = {}): SearchLinkDeps {
  return {
    getTrack: vi.fn(async () => null),
    getCollection: vi.fn(async () => null),
    searchForMatch: vi.fn(async () => []),
    ...overrides,
  };
}

describe("track links", () => {
  it("uses a known YouTube video id directly and never searches for it", async () => {
    const getTrack = vi.fn(async () => song("youtube", YT_ID));
    const searchForMatch = vi.fn(async () => []);
    const result = await resolveSearchLink(YT_SOURCE, deps({ getTrack, searchForMatch }));

    expect(result.kind).toBe("track");
    if (result.kind !== "track") throw new Error("expected a track result");
    // The id came from the URL, so the only provider call is the direct
    // lookup — no `search.list` rediscovery of a video we already know.
    expect(getTrack).toHaveBeenCalledTimes(1);
    expect(getTrack).toHaveBeenCalledWith({ provider: "youtube", id: YT_ID });
    expect(searchForMatch).not.toHaveBeenCalled();
    expect(result.matched).toBe(false);
    expect(result.track.primarySource).toMatchObject({
      source: "youtube",
      id: YT_ID,
    });
  });

  it("resolves a Spotify link by direct metadata lookup plus ONE YouTube match search", async () => {
    const getTrack = vi.fn(async () => song("spotify", SPOTIFY_ID));
    const searchForMatch = vi.fn(async () => [song("youtube", YT_ID)]);
    const result = await resolveSearchLink(SPOTIFY_SOURCE, deps({ getTrack, searchForMatch }));

    // Metadata only: the Spotify URL itself is never text-searched.
    expect(getTrack).toHaveBeenCalledTimes(1);
    expect(getTrack).toHaveBeenCalledWith({
      provider: "spotify",
      id: SPOTIFY_ID,
    });
    expect(searchForMatch).toHaveBeenCalledTimes(1);
    expect(searchForMatch).toHaveBeenCalledWith(
      expect.stringContaining("Lạc Trôi"),
      LINK_MATCH_CANDIDATES,
    );

    expect(result.kind).toBe("track");
    if (result.kind !== "track") throw new Error("expected a track result");
    expect(result.matched).toBe(true);
    expect(result.track.primarySource).toMatchObject({
      source: "spotify",
      id: SPOTIFY_ID,
    });
    expect(result.track.sources.map((entry) => entry.source)).toContain("youtube");
  });

  it("keeps a catalog-only identity when no equivalent video is found", async () => {
    const searchForMatch = vi.fn(async () => []);
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({ getTrack: vi.fn(async () => song("spotify", SPOTIFY_ID)), searchForMatch }),
    );
    if (result.kind !== "track") throw new Error("expected a track result");
    expect(result.matched).toBe(false);
    expect(result.track.sources.map((entry) => entry.source)).toEqual(["spotify"]);
  });

  it("survives a failing candidate search: the link still resolves", async () => {
    const searchForMatch = vi.fn(async () => {
      throw new Error("quota exhausted");
    });
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({ getTrack: vi.fn(async () => song("spotify", SPOTIFY_ID)), searchForMatch }),
    );
    expect(result.kind).toBe("track");
    if (result.kind !== "track") throw new Error("expected a track result");
    expect(result.matched).toBe(false);
    expect(result.track.primarySource.source).toBe("spotify");
  });

  it("does not search at all when the identity already carries a resolvable source", async () => {
    const searchForMatch = vi.fn(async () => [song("youtube", YT_ID)]);
    await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({
        // A Spotify primary that already merged a YouTube source upstream.
        getTrack: vi.fn(async () => song("spotify", SPOTIFY_ID)),
        searchForMatch,
      }),
    );
    expect(searchForMatch).toHaveBeenCalledTimes(1);
    searchForMatch.mockClear();
  });

  it("reports a missing resource as not-found, not as an exception to the page", async () => {
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({ getTrack: vi.fn(async () => null) }),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SearchLinkError);
    expect((result as SearchLinkError).code).toBe("not-found");
  });

  it("reports a provider failure as unavailable and hides its message", async () => {
    const failure = new Error("https://api.example.internal/500 secret=abc");
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({
        getTrack: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SearchLinkError);
    expect((result as SearchLinkError).code).toBe("unavailable");
    expect((result as SearchLinkError).message).not.toContain("secret");
  });

  it("passes an explicit unsupported error through untouched", async () => {
    const original = new SearchLinkError("unsupported", "no playlist here");
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({
        getTrack: vi.fn(async () => {
          throw original;
        }),
      }),
    ).catch((error: unknown) => error);
    expect(result).toBe(original);
  });

  it("reports a provider that cannot serve the resource as unsupported", async () => {
    const original = new SearchLinkError("unsupported", "Provider is not registered");
    const result = await resolveSearchLink(
      SPOTIFY_ALBUM_SOURCE,
      deps({
        getCollection: vi.fn(async () => {
          throw original;
        }),
      }),
    ).catch((error: unknown) => error);
    expect((result as SearchLinkError).code).toBe("unsupported");
  });
});

describe("collection links", () => {
  function collection(tracks: ReturnType<typeof track>[]): ProviderCollection {
    return {
      id: "PL1",
      title: "Aurora Mix",
      description: "for testing",
      artworkUrl: "https://cdn.invalid/art.jpg",
      total: tracks.length,
      tracks,
    };
  }

  it("loads a bounded number of tracks and asks for that bound explicitly", async () => {
    const many = Array.from({ length: LINK_COLLECTION_LIMIT + 5 }, (_, index) =>
      distinctSong("youtube", `yt-${index}a`, index),
    );
    const getCollection = vi.fn(async () => collection(many));
    const searchForMatch = vi.fn(async () => []);
    const result = await resolveSearchLink(
      YT_PLAYLIST_SOURCE,
      deps({ getCollection, searchForMatch }),
    );

    expect(getCollection).toHaveBeenCalledTimes(1);
    expect(getCollection).toHaveBeenCalledWith(YT_PLAYLIST_SOURCE, LINK_COLLECTION_LIMIT);
    expect(result.kind).toBe("collection");
    if (result.kind !== "collection") throw new Error("expected a collection result");
    expect(result.tracks).toHaveLength(LINK_COLLECTION_LIMIT);
    // Native YouTube resources are already resolvable: one fetch, zero searches.
    expect(searchForMatch).not.toHaveBeenCalled();
    expect(result.playable).toBe(LINK_COLLECTION_LIMIT);
    expect(result.title).toBe("Aurora Mix");
    expect(result.total).toBe(many.length);
  });

  it("passes an album link through as an album", async () => {
    const getCollection = vi.fn(async () => collection([song("spotify", SPOTIFY_ID)]));
    await resolveSearchLink(
      SPOTIFY_ALBUM_SOURCE,
      deps({ getCollection, searchForMatch: vi.fn(async () => []) }),
    );
    expect(getCollection).toHaveBeenCalledWith(SPOTIFY_ALBUM_SOURCE, LINK_COLLECTION_LIMIT);
  });

  it("reports a missing collection as not-found", async () => {
    const error = await resolveSearchLink(
      SPOTIFY_PLAYLIST_SOURCE,
      deps({ getCollection: vi.fn(async () => null) }),
    ).catch((caught: unknown) => caught);
    expect((error as SearchLinkError).code).toBe("not-found");
  });

  it("cross-source matches a Spotify playlist within the concurrency bound", async () => {
    const tracks = Array.from({ length: LINK_COLLECTION_LIMIT }, (_, index) =>
      distinctSong("spotify", `sp-${index}`, index),
    );
    let inFlight = 0;
    let peak = 0;
    const searchForMatch = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });
    const result = await resolveSearchLink(
      SPOTIFY_PLAYLIST_SOURCE,
      deps({ getCollection: vi.fn(async () => collection(tracks)), searchForMatch }),
    );

    expect(searchForMatch).toHaveBeenCalledTimes(LINK_COLLECTION_LIMIT);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LINK_MATCH_CONCURRENCY);
    expect(result.kind).toBe("collection");
    if (result.kind !== "collection") throw new Error("expected a collection result");
    expect(result.tracks).toHaveLength(LINK_COLLECTION_LIMIT);
    expect(result.playable).toBe(0);
  });

  it("isolates a per-track search failure: one bad row never sinks the resource", async () => {
    const tracks = Array.from({ length: 4 }, (_, index) =>
      distinctSong("spotify", `sp-${index}`, index),
    );
    const searchForMatch = vi.fn(async (query: string) => {
      if (query.includes("Artist 2")) {
        throw new Error("one row blew up");
      }
      return [];
    });
    const result = await resolveSearchLink(
      SPOTIFY_PLAYLIST_SOURCE,
      deps({ getCollection: vi.fn(async () => collection(tracks)), searchForMatch }),
    );
    if (result.kind !== "collection") throw new Error("expected a collection result");
    expect(result.tracks).toHaveLength(4);
  });

  it("deduplicates on canonical identity after matching, keeping first-seen order", async () => {
    // Two catalogue entries for the same song: after matching they are one
    // logical track (SPEC §17), and the playlist sequence is otherwise intact.
    const tracks = [
      song("spotify", "sp-a"),
      track("spotify", { id: "sp-b", providerTrackId: "sp-b", title: "Chạy Ngay Đi" }),
      song("spotify", "sp-dup"),
    ];
    const result = await resolveSearchLink(
      SPOTIFY_PLAYLIST_SOURCE,
      deps({
        getCollection: vi.fn(async () => collection(tracks)),
        searchForMatch: vi.fn(async () => []),
      }),
    );

    if (result.kind !== "collection") throw new Error("expected a collection result");
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks.map((entry) => entry.primarySource.id)).toEqual([
      "sp-a",
      "sp-b",
    ]);
  });

  it("drops rows that cannot be canonicalized instead of failing the link", async () => {
    const tracks = [
      song("spotify", "sp-ok"),
      // No title at all: `toTrackIdentity` refuses it.
      track("spotify", { id: "sp-bad", providerTrackId: "sp-bad", title: "" }),
    ];
    const result = await resolveSearchLink(
      SPOTIFY_PLAYLIST_SOURCE,
      deps({
        getCollection: vi.fn(async () => collection(tracks)),
        searchForMatch: vi.fn(async () => []),
      }),
    );
    if (result.kind !== "collection") throw new Error("expected a collection result");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.primarySource.id).toBe("sp-ok");
  });
});

describe("what a link resolution must never do", () => {
  it("returns data only: no playback, queue or persistence is triggered", async () => {
    // The resolver is a pure read over injected seams. Asserting the shape is
    // the structural half; the behavioural half (pasting changes nothing
    // until an action is pressed) is covered by the E2E flows.
    const result = await resolveSearchLink(
      SPOTIFY_SOURCE,
      deps({
        getTrack: vi.fn(async () => song("spotify", SPOTIFY_ID)),
        searchForMatch: vi.fn(async () => [song("youtube", YT_ID)]),
      }),
    );
    expect(Object.keys(result).sort()).toEqual([
      "id",
      "kind",
      "matched",
      "provider",
      "resourceKind",
      "track",
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
