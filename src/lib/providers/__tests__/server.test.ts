import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderId } from "@/lib/domain";
import type { EnvConfig } from "@/lib/config/env";
import {
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
} from "@/lib/providers/registry";
import {
  fetchHomeSection,
  fetchHomeSections,
  fetchArtistDetail,
  fetchAlbumDetail,
  fetchTrackDetail,
  fetchArtistTracks,
  fetchAlbumTracks,
  fetchRecommendations,
  getPreferredProvider,
  getShellProviders,
} from "@/lib/providers/server";
import type { MusicProvider } from "@/lib/providers/types";
import { ProviderNotFoundError } from "@/lib/errors";

const emptyEnv = {} as EnvConfig;

function makeProvider(
  id: string,
  opts: {
    isMock?: boolean;
    fail?: boolean;
    without?: import("@/lib/providers/types").ProviderCapability[];
  } = {},
): MusicProvider {
  const caps = new Set<
    import("@/lib/providers/types").ProviderCapability
  >([
    "search.tracks",
    "search.artists",
    "search.albums",
    "tracks.get",
    "tracks.popular",
    "tracks.featured",
    "tracks.recommendations",
    "albums.get",
    "albums.tracks",
    "artists.get",
    "artists.tracks",
    "stream",
  ]);
  for (const cap of opts.without ?? []) {
    caps.delete(cap);
  }
  const rejects: () => Promise<never> = async () => {
    throw new Error("provider boom");
  };
  const emptyList = async () => ({ items: [], total: 0 });
  return {
    id: id as ProviderId,
    name: id,
    isMock: opts.isMock,
    capabilities: caps,
    searchTracks: opts.fail ? rejects : emptyList,
    searchArtists: opts.fail ? rejects : emptyList,
    searchAlbums: opts.fail ? rejects : emptyList,
    getTrack: opts.fail
      ? rejects
      : async (trackId: string) => ({
          id: trackId,
          provider: id as ProviderId,
          providerTrackId: trackId,
          title: `Track ${trackId}`,
          artistId: "a1",
          artistName: "A",
        }),
    getArtist: opts.fail
      ? rejects
      : async (artistId: string) => ({
          id: artistId,
          provider: id as ProviderId,
          providerArtistId: artistId,
          name: `Artist ${artistId}`,
        }),
    getAlbum: opts.fail
      ? rejects
      : async (albumId: string) => ({
          id: albumId,
          provider: id as ProviderId,
          providerAlbumId: albumId,
          title: `Album ${albumId}`,
          artistId: "a1",
          artistName: "A",
        }),
    getAlbumTracks: opts.fail ? rejects : emptyList,
    getArtistTracks: opts.fail ? rejects : emptyList,
    getPopularTracks: opts.fail ? rejects : emptyList,
    getFeaturedTracks: opts.fail ? rejects : emptyList,
    getRecommendations: opts.fail ? rejects : emptyList,
    getStreamUrl: opts.fail
      ? rejects
      : async (trackId: string) => `https://stream/${trackId}.mp3`,
  };
}

beforeEach(() => {
  clearProviders();
});

afterEach(() => {
  clearProviders();
});

describe("getShellProviders / getPreferredProvider", () => {
  // Contract change (Phase 04): the keyless Deezer catalog provider is
  // always bootstrapped at the shell layer, so the shell set is never
  // empty. The raw registry itself stays pure: clearProviders() empties it.
  it("keeps the raw registry empty until shell bootstrap runs", () => {
    expect(listProviders()).toEqual([]);
  });

  it("shell providers always include keyless deezer", () => {
    const ids = getShellProviders(emptyEnv).map((provider) => provider.id);
    expect(ids).toContain("deezer");
  });

  it("is idempotent across repeated calls", () => {
    const first = getShellProviders(emptyEnv);
    const second = getShellProviders(emptyEnv);
    expect(second).toEqual(first);
  });

  it("throws ProviderNotFoundError for unknown registry ids", () => {
    expect(() => getProvider("missing")).toThrow(ProviderNotFoundError);
  });

  it("prefers deezer by default when nothing else is registered", () => {
    expect(getPreferredProvider(emptyEnv).id).toBe("deezer");
  });

  it("prefers a registered non-mock provider", () => {
    registerProvider(makeProvider("custom"));
    expect(getPreferredProvider(emptyEnv).id).toBe("custom");
  });

  it("prefers the always-on deezer provider over a mock-only registration", () => {
    registerProvider(makeProvider("mock", { isMock: true }));
    expect(getPreferredProvider(emptyEnv).id).toBe("deezer");
  });
});

describe("fetchHomeSections / fetchHomeSection", () => {
  // Contract change (Phase 04): the shell always bootstraps keyless
  // deezer, so the call resolves instead of throwing. Featured and
  // recommendations are deterministically unsupported; popular depends on
  // live chart access and is asserted only for resolvability.
  it("returns empty sections with only the default provider", async () => {
    const sections = await fetchHomeSections([], [], emptyEnv);
    expect(Array.isArray(sections.popular)).toBe(true);
    expect(sections.featured).toEqual([]);
    expect(sections.recommendations).toEqual([]);
    expect(sections.featuredStatus).toBe("unsupported");
    expect(sections.recommendationsStatus).toBe("unsupported");
  });

  it("returns empty list when the loader throws", async () => {
    registerProvider(makeProvider("custom"));
    const loader = async () => {
      throw new Error("boom");
    };
    await expect(fetchHomeSection(loader, emptyEnv)).resolves.toEqual([]);
  });

  it("returns loader results on success", async () => {
    registerProvider(makeProvider("custom"));
    const loader = async () => [
      {
        id: "t1",
        provider: "custom" as ProviderId,
        title: "T",
        artistId: "a1",
        artistName: "A",
      },
    ];
    const tracks = await fetchHomeSection(loader, emptyEnv);
    expect(tracks).toHaveLength(1);
  });
});

describe("fetchArtistDetail", () => {
  it("returns success with artist from provider", async () => {
    const provider = makeProvider("custom");
    const result = await fetchArtistDetail("a1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchArtistDetail("a1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", { without: ["artists.get"] });
    const result = await fetchArtistDetail("a1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});

describe("fetchAlbumDetail", () => {
  it("returns success with album from provider", async () => {
    const provider = makeProvider("custom");
    const result = await fetchAlbumDetail("al1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchAlbumDetail("al1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", { without: ["albums.get"] });
    const result = await fetchAlbumDetail("al1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});

describe("fetchTrackDetail", () => {
  it("returns success with track from provider", async () => {
    const provider = makeProvider("custom");
    const result = await fetchTrackDetail("t1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchTrackDetail("t1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", { without: ["tracks.get"] });
    const result = await fetchTrackDetail("t1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});

describe("fetchArtistTracks", () => {
  it("returns success with tracks for an artist", async () => {
    const provider = makeProvider("custom");
    const result = await fetchArtistTracks("a1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchArtistTracks("a1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", { without: ["artists.tracks"] });
    const result = await fetchArtistTracks("a1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});

describe("fetchAlbumTracks", () => {
  it("returns success with tracks for an album", async () => {
    const provider = makeProvider("custom");
    const result = await fetchAlbumTracks("al1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchAlbumTracks("al1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", { without: ["albums.tracks"] });
    const result = await fetchAlbumTracks("al1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});

describe("fetchRecommendations", () => {
  it("returns success with recommended tracks", async () => {
    const provider = makeProvider("custom");
    const result = await fetchRecommendations("t1", provider, emptyEnv);
    expect(result.kind).toBe("success");
  });

  it("returns failed when provider fails", async () => {
    const provider = makeProvider("custom", { fail: true });
    const result = await fetchRecommendations("t1", provider, emptyEnv);
    expect(result.kind).toBe("failed");
  });

  it("returns unsupported when capability is absent", async () => {
    const provider = makeProvider("custom", {
      without: ["tracks.recommendations"],
    });
    const result = await fetchRecommendations("t1", provider, emptyEnv);
    expect(result.kind).toBe("unsupported");
  });
});
