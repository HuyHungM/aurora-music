import { describe, expect, it } from "vitest";
import {
  createPlaylistSchema,
  deletePlaylistSchema,
  idSchema,
  paginationSchema,
  providerIdSchema,
  reorderPlaylistSchema,
  searchQuerySchema,
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