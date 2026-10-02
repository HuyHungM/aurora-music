import { describe, expect, it } from "vitest";
import {
  audioExtensionOf,
  isAudioFile,
  localTrack,
  parseFileName,
  stripAudioExtension,
  UNKNOWN_ARTIST,
} from "@/lib/offline/tracks";

describe("offline file recognition", () => {
  it("accepts common audio extensions case-insensitively", () => {
    for (const name of ["a.mp3", "A.MP3", "b.m4a", "c.flac", "d.opus", "e.wav", "f.webm"]) {
      expect(isAudioFile(name), name).toBe(true);
    }
  });

  it("rejects non-audio and unknown extensions", () => {
    for (const name of ["cover.jpg", "notes.txt", "song.mkv", "README", "archive.zip"]) {
      expect(isAudioFile(name), name).toBe(false);
    }
  });

  it("falls back to MIME when there is no usable extension", () => {
    // A File from the File System Access API often reports no type at all, so
    // the extension has to carry recognition; MIME only rescues the rest.
    expect(isAudioFile("track", "audio/ogg")).toBe(true);
    expect(isAudioFile("track", "video/mp4")).toBe(false);
    expect(isAudioFile("track")).toBe(false);
  });

  it("reads and strips only audio extensions", () => {
    expect(audioExtensionOf("a.MP3")).toBe("mp3");
    expect(audioExtensionOf("noext")).toBe("");
    expect(audioExtensionOf("archive.tar.gz")).toBe("gz");
    expect(stripAudioExtension("Song.mp3")).toBe("Song");
    expect(stripAudioExtension("My Song.2024.flac")).toBe("My Song.2024");
    expect(stripAudioExtension("archive.tar.gz")).toBe("archive.tar.gz");
  });
});

describe("offline filename parsing", () => {
  it("splits an artist and title on the FIRST separator", () => {
    expect(parseFileName("Artist - Title.mp3")).toEqual({ title: "Title", artist: "Artist" });
    // Taking the last part would silently rename the track.
    expect(parseFileName("A - B - C.mp3")).toEqual({ title: "B - C", artist: "A" });
  });

  it("strips a leading bracketed track number", () => {
    expect(parseFileName("[03] Artist - Title.mp3")).toEqual({
      title: "Title",
      artist: "Artist",
    });
  });

  it("treats a filename with no separator as the title", () => {
    expect(parseFileName("Moonlight Sonata.mp3")).toEqual({ title: "Moonlight Sonata" });
  });

  it("never yields empty halves", () => {
    // The stem is trimmed, so a leading separator collapses into the title
    // rather than producing an empty artist.
    expect(parseFileName(" - Title.mp3")).toEqual({ title: "- Title" });
    expect(parseFileName("Artist - .mp3")).toEqual({ title: "Artist -" });
  });

  it("treats a bare leading number as the artist, not a track number", () => {
    // KNOWN LIMITATION of the documented heuristic, pinned here on purpose:
    // only BRACKETED numbers ("[03] Artist - Title") are stripped. A file named
    // "01 - Song.mp3" therefore parses its artist as "01". Reading real tags
    // would fix this properly and is deliberately out of scope.
    expect(parseFileName("01 - Song.mp3")).toEqual({ title: "Song", artist: "01" });
  });
});

describe("offline track mapping", () => {
  it("carries the parsed artist and a stable local identity", () => {
    const track = localTrack({
      id: "Album/Song.mp3",
      folder: "Album",
      name: "Song.mp3",
    });
    expect(track.provider).toBe("local");
    expect(track.id).toBe("Album/Song.mp3");
    expect(track.providerTrackId).toBe("Album/Song.mp3");
    expect(track.title).toBe("Song");
    // No separator in the filename, so the containing folder is the artist -
    // which is how music libraries are actually laid out.
    expect(track.artistName).toBe("Album");
  });

  it("prefers the parsed artist over the containing folder", () => {
    const track = localTrack({
      id: "x",
      folder: "Album",
      name: "Artist - Song.mp3",
    });
    expect(track.artistName).toBe("Artist");
  });

  it("falls back to a language-neutral artist rather than translated copy", () => {
    // This value is catalog data that feeds dedupe keys. A string that changed
    // with the UI locale would make one file dedupe differently per language.
    const track = localTrack({ id: "x", folder: null, name: "Untitled.mp3" });
    expect(track.artistName).toBe(UNKNOWN_ARTIST);
  });

  it("never invents a duration it cannot know", () => {
    // A duration needs a media element per file, which for a large folder
    // means thousands of them — and the audio element reports the true value
    // as soon as the track loads. Inventing one here would be a visible lie
    // that cost real work to produce.
    expect(localTrack({ id: "x", folder: null, name: "a.mp3" }).duration).toBeUndefined();
  });
});