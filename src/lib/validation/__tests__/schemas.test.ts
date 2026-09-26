import { describe, expect, it } from "vitest";
import {
  PLAYLIST_ARTWORK_MAX_LENGTH,
  SHARE_TOKEN_LENGTH,
  addTrackSchema,
  createPlaylistSchema,
  deletePlaylistSchema,
  idSchema,
  paginationSchema,
  playlistArtworkSchema,
  playlistVisibilitySchema,
  playlistVisibilityUpdateSchema,
  providerIdSchema,
  reorderPlaylistSchema,
  searchQuerySchema,
  shareTokenSchema,
  updatePlaylistSchema,
} from "@/lib/validation";

describe("providerIdSchema", () => {
  it("accepts any non-empty provider id", () => {
    expect(providerIdSchema.parse("jamendo")).toBe("jamendo");
    expect(providerIdSchema.parse("spotify")).toBe("spotify");
    expect(providerIdSchema.parse("youtube")).toBe("youtube");
  });

  it("rejects empty provider ids", () => {
    expect(() => providerIdSchema.parse("")).toThrow();
    expect(() => providerIdSchema.parse("   ")).toThrow();
  });
});

describe("idSchema", () => {
  it("accepts non-empty ids", () => {
    expect(idSchema.parse("   t1  ")).toBe("t1");
  });

  it("rejects empty ids", () => {
    expect(() => idSchema.parse("   ")).toThrow();
  });
});

describe("paginationSchema", () => {
  it("applies defaults", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it("coerces string values from URL search params", () => {
    expect(paginationSchema.parse({ limit: "50", offset: "5" })).toEqual({
      limit: 50,
      offset: 5,
    });
  });

  it("rejects out-of-range values", () => {
    expect(() => paginationSchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationSchema.parse({ limit: 101 })).toThrow();
    expect(() => paginationSchema.parse({ offset: -1 })).toThrow();
  });
});

describe("searchQuerySchema", () => {
  it("trims the query", () => {
    expect(searchQuerySchema.parse({ query: "  aurora  " }).query).toBe("aurora");
  });

  it("rejects blank queries", () => {
    expect(() => searchQuerySchema.parse({ query: "   " })).toThrow();
  });
});

describe("createPlaylistSchema", () => {
  it("accepts valid title and optional description", () => {
    const result = createPlaylistSchema.parse({ title: "My Playlist", description: "A great mix" });
    expect(result.title).toBe("My Playlist");
    expect(result.description).toBe("A great mix");
  });

  it("accepts title only", () => {
    const result = createPlaylistSchema.parse({ title: "My Playlist" });
    expect(result.title).toBe("My Playlist");
    expect(result.description).toBeUndefined();
  });

  it("trims title whitespace", () => {
    const result = createPlaylistSchema.parse({ title: "  My Playlist  " });
    expect(result.title).toBe("My Playlist");
  });

  it("rejects empty title", () => {
    expect(() => createPlaylistSchema.parse({ title: "" })).toThrow();
  });

  it("rejects whitespace-only title", () => {
    expect(() => createPlaylistSchema.parse({ title: "   " })).toThrow();
  });

  it("rejects title exceeding max length", () => {
    const longTitle = "a".repeat(201);
    expect(() => createPlaylistSchema.parse({ title: longTitle })).toThrow();
  });

  it("rejects description exceeding max length", () => {
    const longDesc = "a".repeat(501);
    expect(() => createPlaylistSchema.parse({ title: "Valid", description: longDesc })).toThrow();
  });
});

describe("updatePlaylistSchema", () => {
  it("accepts valid playlistId and optional title", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", title: "Updated" });
    expect(result.playlistId).toBe("pl1");
    expect(result.title).toBe("Updated");
  });

  it("accepts optional description", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", description: "New desc" });
    expect(result.description).toBe("New desc");
  });

  it("accepts null description to clear it", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", description: null });
    expect(result.description).toBeNull();
  });

  it("requires playlistId", () => {
    expect(() => updatePlaylistSchema.parse({ title: "Test" })).toThrow();
  });

  it("rejects empty title when provided", () => {
    expect(() => updatePlaylistSchema.parse({ playlistId: "pl1", title: "   " })).toThrow();
  });

  it("trims title when provided", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", title: "  Updated  " });
    expect(result.title).toBe("Updated");
  });
});

describe("playlistArtworkSchema", () => {
  it("accepts an https URL and trims it", () => {
    const result = playlistArtworkSchema.parse("  https://img.example/cover.jpg  ");
    expect(result).toBe("https://img.example/cover.jpg");
  });

  it("accepts http as well as https", () => {
    expect(playlistArtworkSchema.parse("http://img.example/cover.jpg")).toBe(
      "http://img.example/cover.jpg",
    );
  });

  // The three states must stay distinguishable: absent means "don't touch
  // it", null means "remove it", and a string means "set it". Collapsing
  // absent into null is what made artwork impossible to remove.
  it("keeps absent distinct from an explicit null", () => {
    expect(playlistArtworkSchema.parse(undefined)).toBeUndefined();
    expect(playlistArtworkSchema.parse(null)).toBeNull();
  });

  it("rejects a script URL", () => {
    expect(playlistArtworkSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("rejects other dangerous or local schemes", () => {
    for (const value of [
      "data:image/png;base64,AAAA",
      "blob:https://example.com/abc",
      "file:///etc/passwd",
      "vbscript:msgbox",
    ]) {
      expect(playlistArtworkSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("rejects a protocol-relative URL with no host", () => {
    expect(playlistArtworkSchema.safeParse("//evil.example/cover.jpg").success).toBe(false);
  });

  it("rejects a scheme with no host at all", () => {
    // `https:///x` normalizes to host "x" and is a legitimate absolute URL,
    // so the meaningful no-host case is a bare scheme, which the URL parser
    // itself rejects.
    expect(playlistArtworkSchema.safeParse("https://").success).toBe(false);
    expect(playlistArtworkSchema.safeParse("https://?q=1").success).toBe(false);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(playlistArtworkSchema.safeParse("").success).toBe(false);
    expect(playlistArtworkSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects a non-URL string", () => {
    expect(playlistArtworkSchema.safeParse("not a url at all").success).toBe(false);
  });

  it("rejects a number or an object", () => {
    expect(playlistArtworkSchema.safeParse(42).success).toBe(false);
    expect(playlistArtworkSchema.safeParse({ url: "https://x/y.jpg" }).success).toBe(false);
    expect(playlistArtworkSchema.safeParse(["https://x/y.jpg"]).success).toBe(false);
  });

  it("rejects a URL longer than the cap", () => {
    const long = `https://img.example/${"a".repeat(PLAYLIST_ARTWORK_MAX_LENGTH)}`;
    expect(playlistArtworkSchema.safeParse(long).success).toBe(false);
  });

  it("accepts a URL exactly at the cap", () => {
    const prefix = "https://img.example/";
    const exact = prefix + "a".repeat(PLAYLIST_ARTWORK_MAX_LENGTH - prefix.length);
    expect(exact).toHaveLength(PLAYLIST_ARTWORK_MAX_LENGTH);
    expect(playlistArtworkSchema.safeParse(exact).success).toBe(true);
  });
});

describe("updatePlaylistSchema artwork", () => {
  it("carries artwork through a title-only edit untouched", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", title: "Updated" });
    expect(result.artwork).toBeUndefined();
  });

  it("accepts an explicit null to remove artwork", () => {
    const result = updatePlaylistSchema.parse({ playlistId: "pl1", artwork: null });
    expect(result.artwork).toBeNull();
  });

  it("accepts a valid URL", () => {
    const result = updatePlaylistSchema.parse({
      playlistId: "pl1",
      artwork: "https://img.example/cover.jpg",
    });
    expect(result.artwork).toBe("https://img.example/cover.jpg");
  });

  it("rejects a dangerous artwork URL in the same shape", () => {
    expect(
      updatePlaylistSchema.safeParse({ playlistId: "pl1", artwork: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});

describe("playlistVisibilitySchema", () => {
  it("accepts only the two reviewed visibilities", () => {
    expect(playlistVisibilitySchema.parse("private")).toBe("private");
    expect(playlistVisibilitySchema.parse("shared")).toBe("shared");
  });

  // §9: the model is deliberately minimal — no public, unlisted,
  // friends-only, collaborative, or password-protected variants.
  it("rejects every visibility outside the reviewed pair", () => {
    for (const value of ["public", "unlisted", "friends", "collaborative", "password"]) {
      expect(playlistVisibilitySchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("rejects a non-string", () => {
    expect(playlistVisibilitySchema.safeParse(1).success).toBe(false);
    expect(playlistVisibilitySchema.safeParse(null).success).toBe(false);
  });
});

describe("playlistVisibilityUpdateSchema", () => {
  it("accepts the two update targets", () => {
    expect(
      playlistVisibilityUpdateSchema.parse({ playlistId: "pl1", visibility: "shared" }),
    ).toEqual({ playlistId: "pl1", visibility: "shared" });
    expect(
      playlistVisibilityUpdateSchema.parse({ playlistId: "pl1", visibility: "private" }),
    ).toEqual({ playlistId: "pl1", visibility: "private" });
  });

  it("rejects a visibility outside the reviewed pair", () => {
    expect(
      playlistVisibilityUpdateSchema.safeParse({ playlistId: "pl1", visibility: "public" })
        .success,
    ).toBe(false);
  });

  it("requires a playlist id", () => {
    expect(playlistVisibilityUpdateSchema.safeParse({ visibility: "shared" }).success).toBe(
      false,
    );
    expect(
      playlistVisibilityUpdateSchema.safeParse({ playlistId: "", visibility: "shared" }).success,
    ).toBe(false);
  });
});

describe("shareTokenSchema", () => {
  // A share token is the ONLY thing standing between a private playlist and
  // the public, so its shape is validated strictly at the route boundary.
  it("accepts a token of the minted length", () => {
    const token = "a".repeat(SHARE_TOKEN_LENGTH);
    expect(shareTokenSchema.parse(token)).toBe(token);
  });

  it("rejects a token of any other length", () => {
    expect(shareTokenSchema.safeParse("a".repeat(SHARE_TOKEN_LENGTH - 1)).success).toBe(false);
    expect(shareTokenSchema.safeParse("a".repeat(SHARE_TOKEN_LENGTH + 1)).success).toBe(false);
    expect(shareTokenSchema.safeParse("").success).toBe(false);
  });

  it("rejects a token with non-base64url characters", () => {
    const token = "a".repeat(SHARE_TOKEN_LENGTH - 1) + "+";
    expect(shareTokenSchema.safeParse(token).success).toBe(false);
    const withSlash = "a".repeat(SHARE_TOKEN_LENGTH - 1) + "/";
    expect(shareTokenSchema.safeParse(withSlash).success).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(shareTokenSchema.safeParse(123).success).toBe(false);
    expect(shareTokenSchema.safeParse(null).success).toBe(false);
  });
});

describe("deletePlaylistSchema", () => {
  it("accepts valid playlistId", () => {
    expect(deletePlaylistSchema.parse({ playlistId: "pl1" })).toEqual({ playlistId: "pl1" });
  });

  it("rejects empty playlistId", () => {
    expect(() => deletePlaylistSchema.parse({ playlistId: "" })).toThrow();
  });
});

describe("reorderPlaylistSchema", () => {
  it("accepts valid playlistId and orderedRefs", () => {
    const input = {
      playlistId: "pl1",
      orderedRefs: [
        { provider: "jamendo", providerTrackId: "t1" },
        { provider: "jamendo", providerTrackId: "t2" },
      ],
    };
    const result = reorderPlaylistSchema.parse(input);
    expect(result.playlistId).toBe("pl1");
    expect(result.orderedRefs).toHaveLength(2);
  });

  it("accepts empty orderedRefs", () => {
    const result = reorderPlaylistSchema.parse({ playlistId: "pl1", orderedRefs: [] });
    expect(result.orderedRefs).toHaveLength(0);
  });

  it("requires provider and providerTrackId in each ref", () => {
    expect(() =>
      reorderPlaylistSchema.parse({ playlistId: "pl1", orderedRefs: [{ provider: "jamendo" }] })
    ).toThrow();
  });
});

/**
 * Phase 49 security regression. A client-supplied Track must not be able to
 * carry a media URL or a free-form metadata blob into the shared, unowned
 * catalog. zod strips unknown keys, so simply not declaring these fields is
 * what enforces it at the action boundary; the DAL refuses them too
 * (`dal/catalog.ts`). Both layers matter: the schema is the untrusted edge.
 */
describe("addTrackSchema", () => {
  const valid = {
    playlistId: "pl1",
    track: {
      id: "t1",
      provider: "youtube",
      title: "Track",
      artistId: "a1",
      artistName: "Artist",
    },
  };

  it("accepts a track reference and keeps the display fields", () => {
    const result = addTrackSchema.parse({
      ...valid,
      track: { ...valid.track, artworkUrl: "https://img/x.jpg", duration: 120 },
    });
    expect(result.track.artworkUrl).toBe("https://img/x.jpg");
    expect(result.track.duration).toBe(120);
  });

  it("strips streamUrl, previewUrl and metadata from the client payload", () => {
    const result = addTrackSchema.parse({
      ...valid,
      track: {
        ...valid.track,
        streamUrl: "https://attacker.example/probe.mp3",
        previewUrl: "https://attacker.example/probe.mp3",
        metadata: { injected: true },
      },
    });
    expect(result.track).not.toHaveProperty("streamUrl");
    expect(result.track).not.toHaveProperty("previewUrl");
    expect(result.track).not.toHaveProperty("metadata");
  });

  it("still requires the identity fields", () => {
    expect(() => addTrackSchema.parse({ playlistId: "pl1", track: { id: "t1" } })).toThrow();
  });
});