import { describe, expect, it } from "vitest";
import {
  deezerAlbumUrl,
  deezerArtistUrl,
  deezerTrackUrl,
  isDeezerId,
  isReadableTrack,
  normalizeAlbum,
  normalizeArtist,
  normalizeDeezerId,
  normalizePictures,
  normalizeTrack,
} from "@/lib/providers/deezer/normalize";

const ARTIST = {
  id: 27,
  name: "Daft Punk",
  link: "https://www.deezer.com/artist/27",
  picture_small: "https://pics/p-s.jpg",
  picture_medium: "https://pics/p-m.jpg",
  picture_big: "https://pics/p-b.jpg",
};

const ALBUM = {
  id: 302127,
  title: "Discovery",
  link: "https://www.deezer.com/album/302127",
  cover_small: "https://pics/c-s.jpg",
  cover_medium: "https://pics/c-m.jpg",
  cover_big: "https://pics/c-b.jpg",
  release_date: "2001-03-07",
  artist: ARTIST,
};

const TRACK = {
  id: 3135556,
  title: "Harder, Better, Faster, Stronger",
  link: "https://www.deezer.com/track/3135556",
  duration: 224,
  explicit_lyrics: false,
  preview: "https://cdns-preview/x.mp3",
  readable: true,
  artist: ARTIST,
  album: ALBUM,
};

describe("Deezer ids", () => {
  it("accepts positive integer ids", () => {
    expect(isDeezerId("3135556")).toBe(true);
    expect(isDeezerId("27")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isDeezerId("")).toBe(false);
    expect(isDeezerId("0")).toBe(false);
    expect(isDeezerId("-5")).toBe(false);
    expect(isDeezerId("abc")).toBe(false);
    expect(isDeezerId("12.5")).toBe(false);
    expect(isDeezerId("dQw4w9WgXcQ")).toBe(false);
  });

  it("normalizes numeric and string ids", () => {
    expect(normalizeDeezerId(3135556)).toBe("3135556");
    expect(normalizeDeezerId("3135556")).toBe("3135556");
    expect(normalizeDeezerId(0)).toBeNull();
    expect(normalizeDeezerId(1.5)).toBeNull();
    expect(normalizeDeezerId("abc")).toBeNull();
    expect(normalizeDeezerId(null)).toBeNull();
  });
});

describe("normalizePictures", () => {
  it("maps onto semantic sizes with best resolution", () => {
    expect(
      normalizePictures({ small: "s", medium: "m", big: "b" }),
    ).toEqual({ small: "s", medium: "m", large: "b", best: "b" });
  });

  it("degrades gracefully", () => {
    expect(normalizePictures({})).toEqual({});
    expect(normalizePictures({ small: "" })).toEqual({});
  });
});

describe("normalizeTrack", () => {
  it("normalizes identity, artist, album, duration, artwork, url", () => {
    const result = normalizeTrack(TRACK);
    expect(result?.trackId).toBe("3135556");
    expect(result?.track).toMatchObject({
      id: "3135556",
      provider: "deezer",
      providerTrackId: "3135556",
      title: "Harder, Better, Faster, Stronger",
      artistId: "27",
      artistName: "Daft Punk",
      albumId: "302127",
      albumName: "Discovery",
      duration: 224,
      artworkUrl: "https://pics/c-b.jpg",
      providerUrl: "https://www.deezer.com/track/3135556",
      explicit: false,
      previewUrl: "https://cdns-preview/x.mp3",
    });
  });

  it("returns null without identity or title", () => {
    expect(normalizeTrack({ title: "x" })).toBeNull();
    expect(normalizeTrack({ id: 1 })).toBeNull();
    expect(normalizeTrack(null)).toBeNull();
  });

  it("constructs canonical urls when link is absent", () => {
    const result = normalizeTrack({ id: 5, title: "T" });
    expect(result?.track.providerUrl).toBe(deezerTrackUrl("5"));
    expect(result?.track.artistName).toBe("Unknown artist");
  });

  it("leaves duration undefined when missing", () => {
    const result = normalizeTrack({ id: 5, title: "T" });
    expect(result?.track.duration).toBeUndefined();
  });
});

describe("isReadableTrack", () => {
  it("skips unreadable and malformed entries", () => {
    expect(isReadableTrack(TRACK)).toBe(true);
    expect(isReadableTrack({ ...TRACK, readable: false })).toBe(false);
    expect(isReadableTrack(null)).toBe(false);
  });
});

describe("normalizeArtist", () => {
  it("normalizes identity, name, artwork, and url", () => {
    expect(normalizeArtist(ARTIST)).toMatchObject({
      id: "27",
      provider: "deezer",
      providerArtistId: "27",
      name: "Daft Punk",
      image: "https://pics/p-b.jpg",
    });
  });

  it("returns null without identity or name", () => {
    expect(normalizeArtist({ name: "x" })).toBeNull();
    expect(normalizeArtist({ id: 1 })).toBeNull();
  });

  it("exposes canonical artist urls", () => {
    expect(deezerArtistUrl("27")).toBe("https://www.deezer.com/artist/27");
  });
});

describe("normalizeAlbum", () => {
  it("normalizes identity, artist, artwork, and release date", () => {
    expect(normalizeAlbum(ALBUM)).toMatchObject({
      id: "302127",
      provider: "deezer",
      providerAlbumId: "302127",
      title: "Discovery",
      artistId: "27",
      artistName: "Daft Punk",
      artwork: "https://pics/c-b.jpg",
      releaseDate: "2001-03-07",
    });
  });

  it("returns null without identity or title", () => {
    expect(normalizeAlbum({ title: "x" })).toBeNull();
    expect(normalizeAlbum({ id: 1 })).toBeNull();
  });

  it("exposes canonical album urls", () => {
    expect(deezerAlbumUrl("302127")).toBe("https://www.deezer.com/album/302127");
  });
});
