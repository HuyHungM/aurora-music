/**
 * The provider registry must be consulted by CAPABILITY, not by preference.
 *
 * THE DEFECT THIS PINS. `getPreferredProvider()` returns the first non-mock
 * provider in registration order — YouTube, then Deezer, then Spotify. Every
 * caller then asked THAT provider whether it supported the capability it needed.
 * YouTube advertises only `search.tracks`, `tracks.get`, `search.artists`,
 * `artists.get` and `artists.tracks`, so on any deployment with a YouTube key:
 *
 *   - `fetchAlbumDetail` asked YouTube for `albums.get` → `unsupported`
 *     → `/album/[id]/page.tsx` called `notFound()`. The entire album route
 *       404'd while a fully capable Deezer sat registered.
 *   - `fetchHomeSections` gated Popular / Featured / Albums on the same provider,
 *     so those three home sections rendered empty.
 *   - `search/page.tsx` gated its Albums section on `search.albums` from the
 *     preferred provider, so the section was removed outright.
 *
 * `YOUTUBE_API_KEY` is set in this repository's own `.env`, so this is not a
 * hypothetical configuration.
 *
 * These tests register synthetic providers through the real registry rather than
 * mocking it, so they exercise resolution itself — not a stub of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicProvider, ProviderCapability } from "@/lib/providers/types";
import type { Album, Artist, Track } from "@/lib/domain";

/**
 * The registry is replaced wholesale rather than mutated, so registration
 * ORDER — which is the tie-breaker resolution depends on — is under this
 * file's control. `listProviders` is a module-level function in `registry.ts`,
 * not a method on the manager, so the module is what gets mocked.
 */
const mocks = vi.hoisted(() => ({ providers: [] as MusicProvider[] }));

vi.mock("@/lib/providers/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/registry")>();
  return {
    ...actual,
    listProviders: () => mocks.providers,
    // `registerProvider` is deliberately INERT. `getShellProviders()` calls
    // `ensureDeezerProvider()` (Deezer needs no credentials, so it always
    // registers), and if that appended here the real Deezer would join the
    // registry mid-test and quietly satisfy the assertions this file exists to
    // falsify. Each test sets the exact registry through `only()`.
    registerProvider: () => {},
    hasProvider: (id: string) => mocks.providers.some((p) => p.id === id),
  };
});

const {
  fetchAlbumDetail,
  fetchAlbumTracks,
  fetchTrackDetail,
  getProviderForCapability,
  parseProviderScopedId,
  providerScopedId,
} = await import("@/lib/providers/server");

/** A provider advertising exactly `capabilities`, with recording stubs. */
function fakeProvider(
  id: string,
  capabilities: ProviderCapability[],
): MusicProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    name: id,
    capabilities: new Set(capabilities),
    isMock: false,
    calls,
    async searchTracks() {
      calls.push("searchTracks");
      return { items: [] as Track[], total: 0 };
    },
    async searchArtists() {
      calls.push("searchArtists");
      return { items: [] as Artist[], total: 0 };
    },
    async searchAlbums() {
      calls.push("searchAlbums");
      return { items: [] as Album[], total: 0 };
    },
    async getTrack(id: string) {
      calls.push(`getTrack:${id}`);
      return {
        id,
        provider: id,
        providerTrackId: id,
        title: `Track ${id}`,
        artistId: "a1",
        artistName: "Artist",
      } satisfies Track;
    },
    async getArtist(id: string) {
      calls.push(`getArtist:${id}`);
      return { id, provider: id, name: `Artist ${id}` } satisfies Artist;
    },
    async getArtistTracks(id: string) {
      calls.push(`getArtistTracks:${id}`);
      return { items: [] as Track[], total: 0 };
    },
    async getAlbum(id: string) {
      calls.push(`getAlbum:${id}`);
      return {
        id,
        provider: id,
        providerAlbumId: id,
        title: `Album ${id}`,
        artistId: "a1",
        artistName: "Artist",
      } satisfies Album;
    },
    async getAlbumTracks(id: string) {
      calls.push(`getAlbumTracks:${id}`);
      return { items: [] as Track[], total: 0 };
    },
  } as unknown as MusicProvider & { calls: string[] };
}

function only(...providers: (MusicProvider & { calls: string[] })[]) {
  mocks.providers = providers;
  return providers;
}

beforeEach(() => {
  mocks.providers = [];
});

afterEach(() => {
  mocks.providers = [];
});

describe("getProviderForCapability", () => {
  it("selects a capable provider even when it is NOT the preferred one", () => {
    // Exactly the shipped shape: a YouTube-like provider registered first with
    // no album support, and a Deezer-like one behind it that has it.
    const youtube = fakeProvider("youtube", [
      "search.tracks",
      "tracks.get",
      "search.artists",
      "artists.get",
      "artists.tracks",
    ]);
    const deezer = fakeProvider("deezer", [
      "search.tracks",
      "tracks.get",
      "search.artists",
      "artists.get",
      "search.albums",
      "albums.get",
      "albums.tracks",
      "tracks.popular",
    ]);
    only(youtube, deezer);

    expect(getProviderForCapability("albums.get")?.id).toBe("deezer");
    expect(getProviderForCapability("search.albums")?.id).toBe("deezer");
    expect(getProviderForCapability("albums.tracks")?.id).toBe("deezer");
    expect(getProviderForCapability("tracks.popular")?.id).toBe("deezer");
  });

  it("keeps resolving what the FIRST capable provider has", () => {
    // Registration order is still the tie-breaker, so resolution is
    // deterministic: two providers with the same capability must not flip
    // between calls.
    const first = fakeProvider("deezer", ["albums.get"]);
    const second = fakeProvider("spotify", ["albums.get"]);
    only(first, second);

    expect(getProviderForCapability("albums.get")?.id).toBe("deezer");
    expect(getProviderForCapability("albums.get")?.id).toBe("deezer");
  });

  it("returns null when NO registered provider has the capability", () => {
    only(fakeProvider("youtube", ["search.tracks"]));
    expect(getProviderForCapability("albums.get")).toBeNull();
  });

  it("honours preferProviderId when that provider has the capability", () => {
    const youtube = fakeProvider("youtube", ["albums.get"]);
    const deezer = fakeProvider("deezer", ["albums.get"]);
    only(youtube, deezer);

    expect(
      getProviderForCapability("albums.get", { preferProviderId: "deezer" })?.id,
    ).toBe("deezer");
  });

  it("falls back to capability when preferProviderId cannot serve it", () => {
    // A track's `albumId` is scoped to ITS provider. If that provider cannot
    // read albums, the id is useless there and resolution must move on rather
    // than return something that will 404.
    const youtube = fakeProvider("youtube", ["search.tracks"]);
    const deezer = fakeProvider("deezer", ["albums.get"]);
    only(youtube, deezer);

    expect(
      getProviderForCapability("albums.get", { preferProviderId: "youtube" })?.id,
    ).toBe("deezer");
  });
});

describe("deep-link ids name their own provider", () => {
  it("round-trips a provider-scoped id", () => {
    const scoped = providerScopedId("spotify", "4uLU6hMCjMI75M1A2tKUQ3");
    expect(scoped).toBe("spotify:4uLU6hMCjMI75M1A2tKUQ3");
    expect(parseProviderScopedId(scoped)).toEqual({
      providerId: "spotify",
      id: "4uLU6hMCjMI75M1A2tKUQ3",
    });
  });

  it("splits on the FIRST colon only, so a colon in the id survives", () => {
    expect(parseProviderScopedId("youtube:abc:def")).toEqual({
      providerId: "youtube",
      id: "abc:def",
    });
  });

  it("returns null for a bare id, so legacy links still resolve by capability", () => {
    // Every link already in a user's history, a bookmark or a shared playlist
    // is a bare id. These must keep working.
    expect(parseProviderScopedId("abc123")).toBeNull();
    expect(parseProviderScopedId(":leading")).toBeNull();
    expect(parseProviderScopedId("trailing:")).toBeNull();
    expect(parseProviderScopedId("")).toBeNull();
  });
});

describe("entity fetches resolve by capability", () => {
  it("fetches an album from a provider that has albums.get, not the preferred one", async () => {
    const youtube = fakeProvider("youtube", ["search.tracks", "tracks.get"]);
    const deezer = fakeProvider("deezer", ["albums.get", "albums.tracks"]);
    only(youtube, deezer);

    const result = await fetchAlbumDetail(providerScopedId("deezer", "al-1"));

    // Before the fix this returned `unsupported` and the route called
    // notFound(), so `/album/[id]` 404'd for every non-preferred album.
    expect(result.kind).toBe("success");
    expect(deezer.calls).toContain("getAlbum:al-1");
    expect(youtube.calls).toHaveLength(0);
  });

  it("returns unsupported rather than throwing when nobody can serve it", async () => {
    only(fakeProvider("youtube", ["search.tracks"]));
    const result = await fetchAlbumDetail(providerScopedId("deezer", "al-1"));
    expect(result.kind).toBe("unsupported");
  });

  it("resolves a BARE album id by capability, so legacy links work", async () => {
    const youtube = fakeProvider("youtube", ["search.tracks"]);
    const deezer = fakeProvider("deezer", ["albums.get"]);
    only(youtube, deezer);

    const result = await fetchAlbumDetail("al-legacy");
    expect(result.kind).toBe("success");
    expect(deezer.calls).toContain("getAlbum:al-legacy");
  });

  it("routes album tracks to the same provider that served the album", async () => {
    const youtube = fakeProvider("youtube", ["search.tracks", "albums.get"]);
    const deezer = fakeProvider("deezer", ["albums.get", "albums.tracks"]);
    only(youtube, deezer);

    const result = await fetchAlbumTracks(providerScopedId("deezer", "al-1"));
    expect(result.kind).toBe("success");
    expect(deezer.calls).toContain("getAlbumTracks:al-1");
    expect(youtube.calls).toHaveLength(0);
  });

  it("still resolves tracks from the preferred provider when it can", async () => {
    const youtube = fakeProvider("youtube", ["tracks.get"]);
    const deezer = fakeProvider("deezer", ["tracks.get"]);
    only(youtube, deezer);

    const result = await fetchTrackDetail(providerScopedId("youtube", "t-1"));
    expect(result.kind).toBe("success");
    expect(youtube.calls).toContain("getTrack:t-1");
  });

  it("routes a track to its own provider even when it is not preferred", async () => {
    const youtube = fakeProvider("youtube", ["tracks.get"]);
    const deezer = fakeProvider("deezer", ["tracks.get"]);
    only(youtube, deezer);

    const result = await fetchTrackDetail(providerScopedId("deezer", "t-9"));
    expect(result.kind).toBe("success");
    expect(deezer.calls).toContain("getTrack:t-9");
    expect(youtube.calls).toHaveLength(0);
  });
});