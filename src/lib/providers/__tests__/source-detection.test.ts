import { describe, expect, it } from "vitest";
import {
  detectSource,
  isSupportedInput,
  parseDeezerUrl,
  parseSpotifyUrl,
  parseYouTubeUrl,
} from "@/lib/providers/source-detection";

const YT_ID = "dQw4w9WgXcQ";
const SPOTIFY_ID = "4uLU6hMCjMI75M1A2tKUQ3";
const DEEZER_ID = "3135556";

describe("parseYouTubeUrl", () => {
  it("detects youtube.com/watch with query parameters", () => {
    expect(
      parseYouTubeUrl(`https://www.youtube.com/watch?v=${YT_ID}&list=abc&t=42`),
    ).toEqual({
      provider: "youtube",
      kind: "track",
      id: YT_ID,
      url: `https://www.youtube.com/watch?v=${YT_ID}&list=abc&t=42`,
    });
  });

  it("detects youtu.be short links", () => {
    expect(parseYouTubeUrl(`https://youtu.be/${YT_ID}?si=xyz`)).toMatchObject({
      provider: "youtube",
      kind: "track",
      id: YT_ID,
    });
  });

  it("detects music subdomain, embed, and shorts variants", () => {
    expect(
      parseYouTubeUrl(`https://music.youtube.com/watch?v=${YT_ID}`),
    ).toMatchObject({ provider: "youtube", kind: "track", id: YT_ID });
    expect(
      parseYouTubeUrl(`https://www.youtube.com/embed/${YT_ID}`),
    ).toMatchObject({ provider: "youtube", kind: "track", id: YT_ID });
    expect(
      parseYouTubeUrl(`https://www.youtube.com/shorts/${YT_ID}`),
    ).toMatchObject({ provider: "youtube", kind: "track", id: YT_ID });
  });

  it("detects youtube playlists", () => {
    expect(
      parseYouTubeUrl("https://www.youtube.com/playlist?list=PLabc123"),
    ).toEqual({
      provider: "youtube",
      kind: "playlist",
      id: "PLabc123",
      url: "https://www.youtube.com/playlist?list=PLabc123",
    });
  });

  it("rejects malformed youtube urls", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTubeUrl("https://youtu.be/")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/playlist")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/channel/abc")).toBeNull();
  });
});

describe("parseSpotifyUrl", () => {
  it("detects track, album, and playlist urls", () => {
    expect(
      parseSpotifyUrl(`https://open.spotify.com/track/${SPOTIFY_ID}`),
    ).toEqual({
      provider: "spotify",
      kind: "track",
      id: SPOTIFY_ID,
      url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
    });
    expect(
      parseSpotifyUrl(
        `https://open.spotify.com/album/${SPOTIFY_ID}?si=abc`,
      ),
    ).toMatchObject({ provider: "spotify", kind: "album", id: SPOTIFY_ID });
    expect(
      parseSpotifyUrl(`https://open.spotify.com/playlist/${SPOTIFY_ID}`),
    ).toMatchObject({ provider: "spotify", kind: "playlist", id: SPOTIFY_ID });
  });

  it("tolerates locale segments", () => {
    expect(
      parseSpotifyUrl(
        `https://open.spotify.com/intl-de/track/${SPOTIFY_ID}`,
      ),
    ).toMatchObject({ provider: "spotify", kind: "track", id: SPOTIFY_ID });
  });

  it("rejects malformed spotify urls", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/track/")).toBeNull();
    expect(parseSpotifyUrl("https://open.spotify.com/track/short")).toBeNull();
    expect(
      parseSpotifyUrl(`https://open.spotify.com/episode/${SPOTIFY_ID}`),
    ).toBeNull();
    expect(
      parseSpotifyUrl(`https://spotify.com/track/${SPOTIFY_ID}`),
    ).toBeNull();
  });
});

describe("parseDeezerUrl", () => {
  it("detects track, album, and playlist urls", () => {
    expect(
      parseDeezerUrl(`https://www.deezer.com/track/${DEEZER_ID}`),
    ).toEqual({
      provider: "deezer",
      kind: "track",
      id: DEEZER_ID,
      url: `https://www.deezer.com/track/${DEEZER_ID}`,
    });
    expect(parseDeezerUrl(`https://deezer.com/album/${DEEZER_ID}`)).toMatchObject(
      { provider: "deezer", kind: "album", id: DEEZER_ID },
    );
    expect(
      parseDeezerUrl(`https://www.deezer.com/playlist/${DEEZER_ID}`),
    ).toMatchObject({ provider: "deezer", kind: "playlist", id: DEEZER_ID });
  });

  it("rejects malformed deezer urls", () => {
    expect(parseDeezerUrl("https://www.deezer.com/track/")).toBeNull();
    expect(parseDeezerUrl("https://www.deezer.com/track/abc")).toBeNull();
    expect(
      parseDeezerUrl(`https://www.deezer.com/artist/${DEEZER_ID}`),
    ).toBeNull();
  });
});

describe("detectSource", () => {
  it("routes to the owning provider parser", () => {
    expect(
      detectSource(`https://youtu.be/${YT_ID}`)?.provider,
    ).toBe("youtube");
    expect(
      detectSource(`https://open.spotify.com/track/${SPOTIFY_ID}`)?.provider,
    ).toBe("spotify");
    expect(
      detectSource(`https://www.deezer.com/track/${DEEZER_ID}`)?.provider,
    ).toBe("deezer");
  });

  it("returns null for plain text, unsupported domains, and garbage", () => {
    expect(detectSource("Lạc Trôi")).toBeNull();
    expect(detectSource("")).toBeNull();
    expect(detectSource("not a url")).toBeNull();
    expect(detectSource("https://example.com/track/123")).toBeNull();
    expect(detectSource("https://www.jamendo.com/track/123")).toBeNull();
    expect(detectSource("youtu.be/abc")).toBeNull();
  });

  it("isSupportedInput mirrors detection", () => {
    expect(isSupportedInput(`https://youtu.be/${YT_ID}`)).toBe(true);
    expect(isSupportedInput("Lạc Trôi")).toBe(false);
  });
});
