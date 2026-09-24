import { describe, expect, it } from "vitest";
import {
  SPOTIFY_PROVIDER_ID,
  isSpotifyId,
  normalizeAlbum,
  normalizeArtist,
  normalizeImages,
  normalizeTrack,
} from "@/lib/providers/spotify/normalize";

const ARTIST_REF = {
  id: "0OdUWJ0sBjDrqHygGUXeCF",
  name: "Sơn Tùng M-TP",
  external_urls: { spotify: "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF" },
};

const ALBUM_REF = {
  id: "4uLU6hMCjMI75M1A2tKUQ3",
  name: "Lạc Trôi",
  images: [
    { url: "https://img/640.jpg", width: 640 },
    { url: "https://img/300.jpg", width: 300 },
    { url: "https://img/64.jpg", width: 64 },
  ],
  artists: [ARTIST_REF],
  external_urls: { spotify: "https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQ3" },
};

const TRACK = {
  id: "4uLU6hMCjMI75M1A2tKUQ3",
  type: "track",
  name: "Lạc Trôi",
  duration_ms: 243_000,
  explicit: false,
  preview_url: "https://preview/x.mp3",
  external_ids: { isrc: "USRC17607839" },
  external_urls: { spotify: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3" },
  artists: [ARTIST_REF],
  album: ALBUM_REF,
  disc_number: 1,
  track_number: 3,
};

describe("Spotify ids", () => {
  it("accepts plausible base62 ids", () => {
    expect(isSpotifyId("4uLU6hMCjMI75M1A2tKUQ3")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isSpotifyId("")).toBe(false);
    expect(isSpotifyId("   ")).toBe(false);
    expect(isSpotifyId("with space")).toBe(false);
    expect(isSpotifyId("dQw4w9WgXcQ!")).toBe(false);
  });
});

describe("normalizeImages", () => {
  it("maps widths onto semantic sizes without cropping", () => {
    expect(
      normalizeImages([
        { url: "https://img/640.jpg", width: 640 },
        { url: "https://img/300.jpg", width: 300 },
        { url: "https://img/64.jpg", width: 64 },
      ]),
    ).toEqual({
      small: "https://img/64.jpg",
      medium: "https://img/300.jpg",
      large: "https://img/640.jpg",
      best: "https://img/640.jpg",
    });
  });

  it("degrades gracefully with missing or widthless images", () => {
    expect(normalizeImages(undefined)).toEqual({});
    expect(normalizeImages(null)).toEqual({});
    expect(normalizeImages([{ url: "https://img/x.jpg" }])).toEqual({
      small: "https://img/x.jpg",
      best: "https://img/x.jpg",
    });
    expect(normalizeImages([{ width: 64 }])).toEqual({});
  });
});

describe("normalizeTrack", () => {
  it("normalizes identity, artists, album, duration, artwork, url", () => {
    const result = normalizeTrack(TRACK);
    expect(result?.trackId).toBe("4uLU6hMCjMI75M1A2tKUQ3");
    expect(result?.track).toMatchObject({
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      provider: SPOTIFY_PROVIDER_ID,
      providerTrackId: "4uLU6hMCjMI75M1A2tKUQ3",
      title: "Lạc Trôi",
      artistId: "0OdUWJ0sBjDrqHygGUXeCF",
      artistName: "Sơn Tùng M-TP",
      albumId: "4uLU6hMCjMI75M1A2tKUQ3",
      albumName: "Lạc Trôi",
      duration: 243,
      artworkUrl: "https://img/640.jpg",
      providerUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3",
      explicit: false,
      previewUrl: "https://preview/x.mp3",
    });
    expect(result?.track.metadata).toMatchObject({
      isrc: "USRC17607839",
      discNumber: 1,
      trackNumber: 3,
    });
  });

  it("returns null without identity or title", () => {
    expect(normalizeTrack({ name: "x" })).toBeNull();
    expect(normalizeTrack({ id: "abc" })).toBeNull();
    expect(normalizeTrack(null)).toBeNull();
  });

  it("skips non-track entries such as episodes", () => {
    expect(normalizeTrack({ ...TRACK, type: "episode" })).toBeNull();
  });

  it("tolerates removed 2026 fields", () => {
    const bare = {
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      name: "Song",
      duration_ms: 200_000,
      artists: [{ id: "a1", name: "A" }],
    };
    const result = normalizeTrack(bare);
    expect(result?.track.artistName).toBe("A");
    expect(result?.track.duration).toBe(200);
  });

  it("constructs canonical urls when external urls are absent", () => {
    const result = normalizeTrack({
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      name: "Song",
      artists: [{ id: "a1", name: "A" }],
    });
    expect(result?.track.providerUrl).toBe(
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3",
    );
  });
});

describe("normalizeArtist", () => {
  it("normalizes identity, name, and images", () => {
    expect(
      normalizeArtist({
        id: "0OdUWJ0sBjDrqHygGUXeCF",
        name: "Sơn Tùng M-TP",
        images: [{ url: "https://img/640.jpg", width: 640 }],
      }),
    ).toMatchObject({
      id: "0OdUWJ0sBjDrqHygGUXeCF",
      provider: SPOTIFY_PROVIDER_ID,
      providerArtistId: "0OdUWJ0sBjDrqHygGUXeCF",
      name: "Sơn Tùng M-TP",
      image: "https://img/640.jpg",
    });
  });

  it("returns null without identity or name", () => {
    expect(normalizeArtist({ name: "x" })).toBeNull();
    expect(normalizeArtist({ id: "a1" })).toBeNull();
  });
});

describe("normalizeAlbum", () => {
  it("normalizes identity, artist, artwork, and release date", () => {
    expect(
      normalizeAlbum({
        id: "4uLU6hMCjMI75M1A2tKUQ3",
        name: "Album",
        images: [{ url: "https://img/300.jpg", width: 300 }],
        release_date: "2017",
        release_date_precision: "year",
        album_type: "single",
        artists: [{ id: "a1", name: "A" }],
      }),
    ).toMatchObject({
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      provider: SPOTIFY_PROVIDER_ID,
      providerAlbumId: "4uLU6hMCjMI75M1A2tKUQ3",
      title: "Album",
      artistId: "a1",
      artistName: "A",
      artwork: "https://img/300.jpg",
      releaseDate: "2017",
    });
  });

  it("returns null without identity or title", () => {
    expect(normalizeAlbum({ name: "x" })).toBeNull();
    expect(normalizeAlbum({ id: "a1" })).toBeNull();
  });
});
