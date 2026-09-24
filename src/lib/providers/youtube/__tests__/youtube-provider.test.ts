import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExtractorError,
  NormalizationError,
  TrackNotFoundError,
} from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import { asExtractor } from "@/lib/providers/extractor";
import { createYouTubeProvider } from "@/lib/providers/youtube/youtube-provider";
import type { YouTubeApiTransport } from "@/lib/providers/youtube/types";

const VIDEO_ID = "dQw4w9WgXcQ";

afterEach(() => {
  vi.unstubAllGlobals();
});

function videoItem(videoId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: videoId,
    snippet: {
      title: `Song ${videoId}`,
      channelId: "UC123",
      channelTitle: "Artist",
      liveBroadcastContent: "none",
      thumbnails: { high: { url: "https://i.ytimg.com/l.jpg" } },
      ...((overrides.snippet ?? {}) as Record<string, unknown>),
    },
    contentDetails: { duration: "PT3M30S" },
    status: { privacyStatus: "public" },
  };
}

function searchHit(videoId: string) {
  return {
    id: { kind: "youtube#video", videoId },
    snippet: {
      title: `Song ${videoId}`,
      channelId: "UC123",
      channelTitle: "Artist",
      liveBroadcastContent: "none",
    },
  };
}

function makeTransport(
  overrides: Partial<YouTubeApiTransport> = {},
): YouTubeApiTransport {
  return {
    searchVideos: async () => ({ items: [] }),
    searchChannels: async () => ({ items: [] }),
    getVideos: async () => ({ items: [] }),
    searchChannelVideos: async () => ({ items: [] }),
    getChannels: async () => ({ items: [] }),
    getPlaylist: async () => null,
    getPlaylistItems: async () => ({ items: [] }),
    ...overrides,
  };
}

describe("YouTube provider identity", () => {
  it("uses the canonical youtube id and adapts to Extractor", () => {
    const provider = createYouTubeProvider(makeTransport());
    expect(provider.id).toBe("youtube");
    expect(provider.isMock).toBeUndefined();
    expect(asExtractor(provider).name).toBe("youtube");
    expect(asExtractor(provider).validate(`https://youtu.be/${VIDEO_ID}`)).toBe(
      true,
    );
  });

  it("advertises only implemented capabilities", () => {
    const provider = createYouTubeProvider(makeTransport());
    expect(provider.capabilities.has("search.tracks")).toBe(true);
    expect(provider.capabilities.has("tracks.get")).toBe(true);
    expect(provider.capabilities.has("search.artists")).toBe(true);
    expect(provider.capabilities.has("artists.get")).toBe(true);
    expect(provider.capabilities.has("artists.tracks")).toBe(true);
    expect(provider.capabilities.has("search.albums")).toBe(false);
    expect(provider.capabilities.has("albums.get")).toBe(false);
    expect(provider.capabilities.has("tracks.popular")).toBe(false);
    expect(provider.capabilities.has("tracks.recommendations")).toBe(false);
    expect(provider.capabilities.has("stream")).toBe(false);
  });
});

describe("YouTube search", () => {
  it("returns normalized tracks", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        searchVideos: async () => ({
          items: [searchHit("dQw4w9WgXcQ"), searchHit("9bZkp7q19f0")],
          pageInfo: { totalResults: 2 },
        }),
      }),
    );
    const result = await provider.searchTracks({ query: "Lạc Trôi" });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      provider: "youtube",
      providerTrackId: "dQw4w9WgXcQ",
    });
    expect(result.total).toBe(2);
  });

  it("returns empty results for valid queries with no hits", async () => {
    const provider = createYouTubeProvider(makeTransport());
    const result = await provider.searchTracks({ query: "zzz-no-match" });
    expect(result.items).toEqual([]);
  });

  it("skips malformed items without failing", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        searchVideos: async () => ({
          items: [null, { nope: true }, searchHit("dQw4w9WgXcQ")],
        }),
      }),
    );
    const result = await provider.searchTracks({ query: "x" });
    expect(result.items).toHaveLength(1);
  });

  it("rejects blank queries before any remote call", async () => {
    const searchVideos = vi.fn(async () => ({ items: [] }));
    const provider = createYouTubeProvider(makeTransport({ searchVideos }));
    await expect(provider.searchTracks({ query: "   " })).rejects.toBeInstanceOf(
      NormalizationError,
    );
    expect(searchVideos).not.toHaveBeenCalled();
  });

  it("propagates transport failures unwrapped in message but typed", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        searchVideos: async () => {
          throw new ExtractorError("youtube", "search", "quota exceeded");
        },
      }),
    );
    await expect(provider.searchTracks({ query: "x" })).rejects.toMatchObject({
      code: "EXTRACTOR_ERROR",
    });
  });
});

describe("YouTube track lookup", () => {
  it("returns the exact video, never a substitute", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        getVideos: async () => ({ items: [videoItem(VIDEO_ID)] }),
      }),
    );
    const track = await provider.getTrack(VIDEO_ID);
    expect(track.providerTrackId).toBe(VIDEO_ID);
    expect(track.duration).toBe(210);
  });

  it("throws not-found for empty results", async () => {
    const provider = createYouTubeProvider(makeTransport());
    await expect(provider.getTrack(VIDEO_ID)).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });

  it("rejects malformed ids before any remote call", async () => {
    const getVideos = vi.fn(async () => ({ items: [] }));
    const provider = createYouTubeProvider(makeTransport({ getVideos }));
    await expect(provider.getTrack("not-an-id")).rejects.toBeInstanceOf(
      NormalizationError,
    );
    expect(getVideos).not.toHaveBeenCalled();
  });

  it("treats private videos as not-found", async () => {
    // Private videos come back with an id but no snippet/title.
    const provider = createYouTubeProvider(
      makeTransport({
        getVideos: async () => ({
          items: [{ id: VIDEO_ID, status: { privacyStatus: "private" } }],
        }),
      }),
    );
    await expect(provider.getTrack(VIDEO_ID)).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });
});

describe("YouTube artist lookup", () => {
  it("returns normalized artists", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        searchChannels: async () => ({
          items: [{ id: { kind: "youtube#channel", channelId: "UC123" } }],
        }),
        getChannels: async () => ({
          items: [
            {
              id: "UC123",
              snippet: { title: "Artist", thumbnails: null },
            },
          ],
        }),
      }),
    );
    const result = await provider.searchArtists({ query: "Sơn Tùng" });
    expect(result.items).toEqual([
      { id: "UC123", provider: "youtube", providerArtistId: "UC123", name: "Artist" },
    ]);
  });

  it("reports unsupported album and recommendation capabilities", async () => {
    const provider = createYouTubeProvider(makeTransport());
    await expect(provider.searchAlbums({ query: "x" })).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getAlbum("a")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getRecommendations("t")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getStreamUrl("t")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
  });
});

describe("YouTube playlist lookup", () => {
  function playlistTransport() {
    return makeTransport({
      getPlaylist: async () => ({
        id: "PL123",
        snippet: {
          title: "Mix",
          description: "desc",
          channelId: "UC1",
          channelTitle: "Chan",
          thumbnails: { medium: { url: "https://i.ytimg.com/p.jpg" } },
        },
        contentDetails: { itemCount: 2 },
      }),
      getPlaylistItems: async () => ({
        items: [
          { snippet: { resourceId: { videoId: "dQw4w9WgXcQ" } } },
          { snippet: { title: "Deleted video" } },
          { snippet: { resourceId: { videoId: "9bZkp7q19f0" } } },
        ],
        pageInfo: { totalResults: 3 },
      }),
      getVideos: async (ids: string[]) => ({
        items: ids.map((id) => videoItem(id)),
      }),
    });
  }

  it("returns ordered tracks, skipping unavailable items", async () => {
    const provider = createYouTubeProvider(playlistTransport());
    const playlist = await provider.getPlaylist("PL123");
    expect(playlist.providerPlaylistId).toBe("PL123");
    expect(playlist.title).toBe("Mix");
    expect(playlist.tracks.map((track) => track.providerTrackId)).toEqual([
      "dQw4w9WgXcQ",
      "9bZkp7q19f0",
    ]);
    expect(playlist.total).toBe(3);
  });

  it("distinguishes empty playlists from failures", async () => {
    const provider = createYouTubeProvider(
      makeTransport({
        getPlaylist: async () => ({
          id: "PLEMPTY",
          snippet: { title: "Empty" },
          contentDetails: { itemCount: 0 },
        }),
      }),
    );
    const playlist = await provider.getPlaylist("PLEMPTY");
    expect(playlist.tracks).toEqual([]);
  });

  it("throws a typed error for missing playlists", async () => {
    const provider = createYouTubeProvider(makeTransport());
    await expect(provider.getPlaylist("PLMISSING")).rejects.toMatchObject({
      name: "ExtractorError",
    });
  });
});

describe("YouTube stream adapter (Phase 08)", () => {
  it("stays unsupported without an injected playback client", async () => {
    const provider = createYouTubeProvider(makeTransport());
    expect(provider.capabilities.has("stream")).toBe(false);
    await expect(provider.getStreamUrl(VIDEO_ID)).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
  });

  it("resolves bare urls through the injected playback client", async () => {
    // The resolver validates the winning format with an open-ended range
    // probe; stub fetch so this hermetic test never touches the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 206, body: null })),
    );
    const playback = {
      getMediaInfo: vi.fn(async () => ({
        videoId: VIDEO_ID,
        formats: [
          {
            url: "https://cdn.example/audio.m4a",
            mimeType: "audio/mp4",
            hasAudio: true,
            hasVideo: false,
          },
        ],
      })),
    };
    const provider = createYouTubeProvider(makeTransport(), { playback });
    expect(provider.capabilities.has("stream")).toBe(true);
    await expect(provider.getStreamUrl(VIDEO_ID)).resolves.toBe(
      "https://cdn.example/audio.m4a",
    );
    expect(playback.getMediaInfo).toHaveBeenCalledWith(VIDEO_ID);
  });
});
