import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain/track";
import { NormalizationError } from "@/lib/domain/errors";
import {
  generateIdentityId,
  isValidTrackIdentity,
  mergeSourceReference,
  toCanonicalSearchResult,
  toTrackIdentity,
  trackToSourceReference,
} from "@/lib/domain/track-normalizer";

function youtubeTrack(): Track {
  return {
    id: "dQw4w9WgXcQ",
    provider: "youtube",
    providerTrackId: "dQw4w9WgXcQ",
    title: "Lạc Trôi",
    artistId: "UC123",
    artistName: "Sơn Tùng M-TP",
    duration: 253,
    artworkUrl: "https://i.ytimg.com/l.jpg",
    providerUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    metadata: { channelId: "UC123", liveBroadcastContent: "none" },
  };
}

function deezerTrack(): Track {
  return {
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
    metadata: { artistId: "27", albumId: "302127" },
  };
}

function spotifyTrack(): Track {
  return {
    id: "4uLU6hMCjMI75M1A2tKUQ3",
    provider: "spotify",
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
    metadata: {
      isrc: "USRC17607839",
      artistId: "0OdUWJ0sBjDrqHygGUXeCF",
      discNumber: 1,
      trackNumber: 3,
    },
  };
}

describe("toTrackIdentity", () => {
  it("converts a YouTube track with channel provenance", () => {
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-1" });
    expect(identity.id).toBe("aurora-1");
    expect(identity.title).toBe("Lạc Trôi");
    expect(identity.artists).toEqual([
      {
        id: "UC123",
        provider: "youtube",
        providerArtistId: "UC123",
        name: "Sơn Tùng M-TP",
      },
    ]);
    expect(identity.album).toBeUndefined();
    expect(identity.durationMs).toBe(253_000);
    expect(identity.artwork).toEqual({ medium: "https://i.ytimg.com/l.jpg" });
    expect(identity.sources).toEqual([
      {
        source: "youtube",
        id: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        metadata: { channelId: "UC123", artistId: "UC123" },
      },
    ]);
    expect(identity.primarySource).toEqual(identity.sources[0]);
    expect(identity.metadata).toMatchObject({ liveBroadcastContent: "none" });
    expect(isValidTrackIdentity(identity)).toBe(true);
  });

  it("converts a Deezer track with album and explicit state", () => {
    const identity = toTrackIdentity(deezerTrack(), { id: "aurora-2" });
    expect(identity.album).toMatchObject({
      id: "302127",
      provider: "deezer",
      providerAlbumId: "302127",
      title: "Discovery",
      artistId: "27",
      artistName: "Daft Punk",
    });
    expect(identity.durationMs).toBe(224_000);
    expect(identity.metadata).toMatchObject({ explicit: false });
    expect(isValidTrackIdentity(identity)).toBe(true);
  });

  it("converts a Spotify track preserving ISRC and disc metadata", () => {
    const identity = toTrackIdentity(spotifyTrack(), { id: "aurora-3" });
    expect(identity.sources[0]).toMatchObject({
      source: "spotify",
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3",
      metadata: { isrc: "USRC17607839" },
    });
    expect(identity.metadata).toMatchObject({ discNumber: 1, trackNumber: 3 });
    expect(isValidTrackIdentity(identity)).toBe(true);
  });

  it("generates unique Aurora ids never derived from providers", () => {
    const first = toTrackIdentity(youtubeTrack());
    const second = toTrackIdentity(youtubeTrack());
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain("dQw4w9WgXcQ");
    expect(generateIdentityId()).not.toBe(generateIdentityId());
  });

  it("rejects tracks without stable provider identity", () => {
    expect(() =>
      toTrackIdentity({ ...youtubeTrack(), provider: "jamendo" }),
    ).toThrow(NormalizationError);
    expect(() =>
      toTrackIdentity({ ...youtubeTrack(), providerTrackId: "" }),
    ).toThrow(NormalizationError);
    expect(() =>
      toTrackIdentity({ ...youtubeTrack(), title: "  " }),
    ).toThrow(NormalizationError);
  });

  it("never copies stream or preview urls into the identity", () => {
    const identity = toTrackIdentity({
      ...youtubeTrack(),
      streamUrl: "https://stream.example/x?expire=1&mime=audio",
      previewUrl: "https://preview.example/x.mp3",
    });
    expect(JSON.stringify(identity)).not.toContain("stream.example");
    expect(JSON.stringify(identity)).not.toContain("preview.example");
    expect(isValidTrackIdentity(identity)).toBe(true);
  });
});

describe("generateIdentityId", () => {
  const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** Runs `run` with `globalThis.crypto` replaced, then restores it exactly. */
  function withCrypto<T>(stub: unknown, run: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: stub,
    });
    try {
      return run();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "crypto", descriptor);
      } else {
        delete (globalThis as { crypto?: Crypto }).crypto;
      }
    }
  }

  it("mints a UUIDv4 in a normal context", () => {
    expect(generateIdentityId()).toMatch(UUID_V4);
  });

  it("keeps working where randomUUID does not exist", () => {
    // The production case this guards: a plain-HTTP LAN origin is not a secure
    // context, so browsers expose `getRandomValues` but not `randomUUID`.
    // Playback, queue and dedupe all route through this id, so a throw here is
    // a product-wide failure, not a local one.
    const real = globalThis.crypto;
    expect(typeof real?.randomUUID).toBe("function");

    const id = withCrypto(
      { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) },
      () => generateIdentityId(),
    );

    expect(id).toMatch(UUID_V4);
  });

  it("never throws when no Web Crypto is reachable", () => {
    // A throw here is swallowed by every caller as "unavailable", which is
    // exactly the silent failure mode the fallback chain removes.
    const id = withCrypto(undefined, () => generateIdentityId());
    expect(id).toMatch(UUID_V4);
    expect(id).not.toBe(withCrypto(undefined, () => generateIdentityId()));
  });
});

describe("artists", () => {
  it("keeps an explicitly supplied multi-artist list", () => {
    const identity = toTrackIdentity(spotifyTrack(), {
      artists: [
        { id: "a1", provider: "spotify", providerArtistId: "a1", name: "A" },
        { id: "a2", provider: "spotify", providerArtistId: "a2", name: "B feat. C" },
      ],
    });
    expect(identity.artists.map((artist) => artist.name)).toEqual(["A", "B feat. C"]);
  });

  it("falls back to the primary artist for empty or invalid lists", () => {
    expect(toTrackIdentity(spotifyTrack(), { artists: [] }).artists).toHaveLength(1);
    expect(
      toTrackIdentity(spotifyTrack(), {
        artists: [{ id: "", provider: "spotify", name: "" }],
      }).artists.map((artist) => artist.name),
    ).toEqual(["Sơn Tùng M-TP"]);
  });
});

describe("album", () => {
  it("omits albums when fully unknown", () => {
    expect(toTrackIdentity(youtubeTrack()).album).toBeUndefined();
  });

  it("refuses to invent titles for bare album ids", () => {
    const track = { ...deezerTrack(), albumName: undefined };
    const identity = toTrackIdentity(track);
    expect(identity.album).toBeUndefined();
    // The bare id survives in source metadata instead.
    expect(identity.sources[0]?.metadata).toMatchObject({ albumId: "302127" });
  });
});

describe("duration", () => {
  it("normalizes seconds to integer milliseconds", () => {
    expect(toTrackIdentity({ ...youtubeTrack(), duration: 4.213 }).durationMs).toBe(4213);
  });

  it("preserves a legitimate zero and drops unknown durations", () => {
    expect(toTrackIdentity({ ...youtubeTrack(), duration: 0 }).durationMs).toBe(0);
    expect(toTrackIdentity({ ...youtubeTrack(), duration: undefined }).durationMs).toBeUndefined();
    expect(toTrackIdentity({ ...youtubeTrack(), duration: -5 }).durationMs).toBeUndefined();
    expect(toTrackIdentity({ ...youtubeTrack(), duration: NaN }).durationMs).toBeUndefined();
  });
});

describe("artwork", () => {
  it("leaves artwork undefined when the provider has none", () => {
    const identity = toTrackIdentity({ ...youtubeTrack(), artworkUrl: undefined });
    expect(identity.artwork).toBeUndefined();
    expect(isValidTrackIdentity(identity)).toBe(true);
  });
});

describe("trackToSourceReference", () => {
  it("returns null for unstable identities", () => {
    expect(trackToSourceReference({ ...youtubeTrack(), provider: "napster" })).toBeNull();
    expect(trackToSourceReference({ ...youtubeTrack(), providerTrackId: undefined })).toBeNull();
  });
});

describe("mergeSourceReference", () => {
  it("adds explicitly supplied sources without touching the primary", () => {
    const identity = toTrackIdentity(spotifyTrack(), { id: "aurora-x" });
    const merged = mergeSourceReference(identity, {
      source: "deezer",
      id: "3135556",
      url: "https://www.deezer.com/track/3135556",
    });
    expect(merged.id).toBe("aurora-x");
    expect(merged.sources).toHaveLength(2);
    expect(merged.primarySource).toEqual(identity.primarySource);
    expect(isValidTrackIdentity(merged)).toBe(true);
    // Immutable: the input is untouched.
    expect(identity.sources).toHaveLength(1);
  });

  it("refreshes duplicate source references instead of duplicating", () => {
    const identity = toTrackIdentity(spotifyTrack(), { id: "aurora-x" });
    const merged = mergeSourceReference(identity, {
      source: "spotify",
      id: "4uLU6hMCjMI75M1A2tKUQ3",
      url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3",
      metadata: { isrc: "USRC17607839" },
    });
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]?.metadata).toMatchObject({ isrc: "USRC17607839" });
    // The refreshed entry was primary, so the primary follows the refresh.
    expect(merged.primarySource).toEqual(merged.sources[0]);
  });

  it("treats same id across providers as distinct references", () => {
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-x" });
    const merged = mergeSourceReference(identity, { source: "spotify", id: "dQw4w9WgXcQ" });
    expect(merged.sources).toHaveLength(2);
  });

  it("rejects unknown sources and empty ids", () => {
    const identity = toTrackIdentity(youtubeTrack(), { id: "aurora-x" });
    expect(() =>
      mergeSourceReference(identity, { source: "napster", id: "1" } as never),
    ).toThrow(NormalizationError);
    expect(() =>
      mergeSourceReference(identity, { source: "deezer", id: "  " }),
    ).toThrow(NormalizationError);
  });
});

describe("negative matching", () => {
  function sameSong(provider: "spotify" | "deezer", id: string): Track {
    return {
      id,
      provider,
      providerTrackId: id,
      title: "Song A",
      artistId: "artist-1",
      artistName: "Artist",
      duration: 200,
      providerUrl: `https://example/${provider}/${id}`,
      metadata: { isrc: "USRC17607839" },
    };
  }

  it("keeps identical songs from different providers independent", () => {
    const fromSpotify = toTrackIdentity(sameSong("spotify", "s1"));
    const fromDeezer = toTrackIdentity(sameSong("deezer", "d1"));
    expect(fromSpotify.id).not.toBe(fromDeezer.id);
    expect(fromSpotify.sources).toHaveLength(1);
    expect(fromDeezer.sources).toHaveLength(1);
    expect(fromSpotify.sources[0]?.source).toBe("spotify");
    expect(fromDeezer.sources[0]?.source).toBe("deezer");
  });

  it("does not merge on identical ISRC alone", () => {
    const first = toTrackIdentity(sameSong("spotify", "s1"));
    const second = toTrackIdentity(sameSong("spotify", "s2"));
    expect(first.id).not.toBe(second.id);
  });
});

describe("toCanonicalSearchResult", () => {
  it("adapts provider results preserving query, provenance, pagination", () => {
    const result = toCanonicalSearchResult(
      { items: [youtubeTrack(), youtubeTrack()], total: 2, nextOffset: null },
      "Lạc Trôi",
      "youtube",
    );
    expect(result.query).toBe("Lạc Trôi");
    expect(result.sources).toEqual(["youtube"]);
    expect(result.total).toBe(2);
    expect(result.nextOffset).toBeNull();
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(isValidTrackIdentity(item)).toBe(true);
    }
  });

  it("never deduplicates, even for repeated provider items", () => {
    const track = deezerTrack();
    const result = toCanonicalSearchResult({ items: [track, track] }, "x", "deezer");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).not.toBe(result.items[1]?.id);
  });

  it("rejects unknown sources", () => {
    expect(() =>
      toCanonicalSearchResult({ items: [] }, "x", "napster" as never),
    ).toThrow(NormalizationError);
  });
});

describe("isValidTrackIdentity", () => {
  it("rejects broken identities", () => {
    const valid = toTrackIdentity(youtubeTrack());
    expect(isValidTrackIdentity({ ...valid, id: "" })).toBe(false);
    expect(isValidTrackIdentity({ ...valid, sources: [] })).toBe(false);
    expect(
      isValidTrackIdentity({
        ...valid,
        primarySource: { source: "deezer", id: "x" },
      }),
    ).toBe(false);
    expect(isValidTrackIdentity({ ...valid, durationMs: -1 })).toBe(false);
    expect(isValidTrackIdentity({ ...valid, artists: [] })).toBe(false);
  });

  it("rejects identities carrying playback urls", () => {
    const valid = toTrackIdentity(youtubeTrack());
    expect(
      isValidTrackIdentity({
        ...valid,
        sources: [{ source: "youtube", id: "x", url: "https://cdn.example/x?expire=1&mime=audio" }],
        primarySource: { source: "youtube", id: "x", url: "https://cdn.example/x?expire=1&mime=audio" },
      }),
    ).toBe(false);
  });
});
