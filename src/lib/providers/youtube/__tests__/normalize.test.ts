import { describe, expect, it } from "vitest";
import {
  channelIdFromSearchItem,
  isAvailableVideo,
  isYouTubeVideoId,
  normalizeChannel,
  normalizeSearchItem,
  normalizeThumbnails,
  normalizeVideo,
  parseYouTubeDuration,
  videoIdFromPlaylistItem,
  youTubeWatchUrl,
} from "@/lib/providers/youtube/normalize";

describe("isYouTubeVideoId", () => {
  it("accepts 11-char video ids", () => {
    expect(isYouTubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeVideoId("9bZkp7q19f0")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isYouTubeVideoId("short")).toBe(false);
    expect(isYouTubeVideoId("")).toBe(false);
    expect(isYouTubeVideoId("dQw4w9WgXcQ!")).toBe(false);
    expect(isYouTubeVideoId("dQw4w9WgXcQextra")).toBe(false);
  });
});

describe("parseYouTubeDuration", () => {
  it("parses ISO 8601 durations to seconds", () => {
    expect(parseYouTubeDuration("PT4M13S")).toBe(253);
    expect(parseYouTubeDuration("PT1H2M3S")).toBe(3723);
    expect(parseYouTubeDuration("PT45S")).toBe(45);
    expect(parseYouTubeDuration("P1DT2H")).toBe(93_600);
    expect(parseYouTubeDuration("PT0S")).toBe(0);
  });

  it("returns undefined for missing or malformed input", () => {
    expect(parseYouTubeDuration(undefined)).toBeUndefined();
    expect(parseYouTubeDuration(null)).toBeUndefined();
    expect(parseYouTubeDuration("4:13")).toBeUndefined();
    expect(parseYouTubeDuration("PT")).toBeUndefined();
    expect(parseYouTubeDuration("banana")).toBeUndefined();
    expect(parseYouTubeDuration(253)).toBeUndefined();
  });
});

describe("normalizeThumbnails", () => {
  const thumbs = {
    default: { url: "https://i.ytimg.com/s.jpg" },
    medium: { url: "https://i.ytimg.com/m.jpg" },
    high: { url: "https://i.ytimg.com/l.jpg" },
  };

  it("maps onto semantic sizes with best resolution", () => {
    expect(normalizeThumbnails(thumbs)).toEqual({
      small: "https://i.ytimg.com/s.jpg",
      medium: "https://i.ytimg.com/m.jpg",
      large: "https://i.ytimg.com/l.jpg",
      best: "https://i.ytimg.com/l.jpg",
    });
  });

  it("degrades gracefully with partial artwork", () => {
    expect(normalizeThumbnails({ default: { url: "https://i.ytimg.com/s.jpg" } })).toEqual({
      small: "https://i.ytimg.com/s.jpg",
      best: "https://i.ytimg.com/s.jpg",
    });
    expect(normalizeThumbnails(null)).toEqual({});
    expect(normalizeThumbnails(undefined)).toEqual({});
  });
});

describe("normalizeVideo", () => {
  const video = {
    id: "dQw4w9WgXcQ",
    snippet: {
      title: "Lạc Trôi",
      channelId: "UC123",
      channelTitle: "Sơn Tùng M-TP",
      liveBroadcastContent: "none",
      thumbnails: { high: { url: "https://i.ytimg.com/l.jpg" } },
    },
    contentDetails: { duration: "PT4M13S" },
  };

  it("normalizes identity, artist, duration, artwork, and url", () => {
    const result = normalizeVideo(video);
    expect(result?.videoId).toBe("dQw4w9WgXcQ");
    expect(result?.track).toMatchObject({
      id: "dQw4w9WgXcQ",
      provider: "youtube",
      providerTrackId: "dQw4w9WgXcQ",
      title: "Lạc Trôi",
      artistId: "UC123",
      artistName: "Sơn Tùng M-TP",
      duration: 253,
      artworkUrl: "https://i.ytimg.com/l.jpg",
      providerUrl: youTubeWatchUrl("dQw4w9WgXcQ"),
    });
  });

  it("returns null without identity or title", () => {
    expect(normalizeVideo({ snippet: { title: "x" } })).toBeNull();
    expect(normalizeVideo({ id: "dQw4w9WgXcQ", snippet: {} })).toBeNull();
    expect(normalizeVideo({})).toBeNull();
  });

  it("leaves duration undefined when missing", () => {
    const result = normalizeVideo({
      id: "dQw4w9WgXcQ",
      snippet: { title: "Live soon", channelTitle: "C" },
    });
    expect(result?.track.duration).toBeUndefined();
  });
});

describe("normalizeSearchItem", () => {
  it("normalizes video hits and skips live/upcoming", () => {
    const hit = normalizeSearchItem({
      id: { kind: "youtube#video", videoId: "dQw4w9WgXcQ" },
      snippet: {
        title: "Song",
        channelId: "UC1",
        channelTitle: "Artist",
        liveBroadcastContent: "none",
      },
    });
    expect(hit?.videoId).toBe("dQw4w9WgXcQ");

    expect(
      normalizeSearchItem({
        id: { kind: "youtube#video", videoId: "dQw4w9WgXcQ" },
        snippet: { title: "Live now", liveBroadcastContent: "live" },
      }),
    ).toBeNull();

    expect(
      normalizeSearchItem({
        id: { kind: "youtube#channel", channelId: "UC1" },
        snippet: { title: "Channel" },
      }),
    ).toBeNull();
  });
});

describe("isAvailableVideo", () => {
  it("rejects private, live, and upcoming videos only", () => {
    expect(isAvailableVideo({ status: { privacyStatus: "private" } })).toBe(false);
    expect(
      isAvailableVideo({ snippet: { liveBroadcastContent: "live" } }),
    ).toBe(false);
    expect(
      isAvailableVideo({ snippet: { liveBroadcastContent: "upcoming" } }),
    ).toBe(false);
    expect(
      isAvailableVideo({ snippet: { liveBroadcastContent: "none" } }),
    ).toBe(true);
    expect(isAvailableVideo({})).toBe(true);
  });
});

describe("normalizeChannel", () => {
  it("normalizes channel identity and artwork", () => {
    const artist = normalizeChannel({
      id: "UC123",
      snippet: {
        title: "Sơn Tùng M-TP",
        description: "Official channel",
        thumbnails: { medium: { url: "https://i.ytimg.com/c.jpg" } },
      },
    });
    expect(artist).toMatchObject({
      id: "UC123",
      provider: "youtube",
      providerArtistId: "UC123",
      name: "Sơn Tùng M-TP",
      image: "https://i.ytimg.com/c.jpg",
      bio: "Official channel",
    });
  });

  it("returns null without identity or name", () => {
    expect(normalizeChannel({ snippet: { title: "x" } })).toBeNull();
    expect(normalizeChannel({ id: "UC1", snippet: {} })).toBeNull();
  });
});

describe("playlist item helpers", () => {
  it("extracts channel ids from channel search hits", () => {
    expect(
      channelIdFromSearchItem({ id: { kind: "youtube#channel", channelId: "UC1" } }),
    ).toBe("UC1");
    expect(
      channelIdFromSearchItem({ id: { kind: "youtube#video", videoId: "dQw4w9WgXcQ" } }),
    ).toBeNull();
  });

  it("extracts video ids and skips deleted/private placeholders", () => {
    expect(
      videoIdFromPlaylistItem({
        snippet: { resourceId: { kind: "youtube#video", videoId: "dQw4w9WgXcQ" } },
      }),
    ).toBe("dQw4w9WgXcQ");
    expect(
      videoIdFromPlaylistItem({ contentDetails: { videoId: "dQw4w9WgXcQ" } }),
    ).toBe("dQw4w9WgXcQ");
    expect(
      videoIdFromPlaylistItem({
        snippet: {},
        status: { privacyStatus: "private" },
      }),
    ).toBeNull();
    expect(videoIdFromPlaylistItem({ snippet: { title: "Deleted video" } })).toBeNull();
  });
});
