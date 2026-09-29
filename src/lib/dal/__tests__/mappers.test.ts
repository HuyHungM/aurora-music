import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { toTrackIdentity } from "@/lib/domain/track-normalizer";
import {
  collapsePlaylistMemberships,
  mapFollow,
  mapLike,
  mapPlaylist,
  mapPlaylistItem,
  mapRecentlyPlayed,
  mapSearchHistory,
  mapTrackRow,
  mapUser,
  playlistTracksInclude,
  toProviderId,
} from "@/lib/dal/mappers";

function makeTrackRow(overrides: Partial<Prisma.TrackModel> = {}): Prisma.TrackModel {
  return {
    id: "track-internal",
    provider: "jamendo",
    providerTrackId: "track-1",
    title: "Song",
    artistId: "artist-internal",
    albumId: "album-internal",
    duration: 120,
    artworkUrl: "https://art",
    streamUrl: "https://stream",
    previewUrl: null,
    genres: ["rock"],
    releaseDate: "2026-01-01",
    providerUrl: null,
    explicit: false,
    metadata: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeArtistRow(overrides: Partial<Prisma.ArtistModel> = {}): Prisma.ArtistModel {
  return {
    id: "artist-internal",
    provider: "jamendo",
    providerArtistId: "artist-1",
    name: "The Band",
    image: "https://img",
    bio: null,
    genres: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A user row, built the same way as the other fixtures in this file.
 *
 * Added in Phase 53 because `User.appearance` made the inline literals stop
 * type-checking, which is exactly the signal that the shape of the select has
 * grown. A helper means the next column costs one line here instead of every
 * call site.
 */
function makeUserRow(
  overrides: Partial<Prisma.UserModel> = {},
): Prisma.UserModel {
  return {
    id: "u1",
    email: "a@b.c",
    name: "Alice",
    emailVerified: null,
    image: "https://img",
    locale: null,
    appearance: null,
    keepListening: false,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("mapUser", () => {
  it("maps a full user row", () => {
    const user = mapUser(makeUserRow());
    expect(user).toEqual({
      id: "u1",
      email: "a@b.c",
      name: "Alice",
      image: "https://img",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("omits nullish optional fields", () => {
    const user = mapUser(
      makeUserRow({ email: null, name: null, image: null }),
    );
    expect(user.email).toBeUndefined();
    expect(user.name).toBeUndefined();
    expect(user.image).toBeUndefined();
  });
});

describe("mapLike", () => {
  it("maps a like row to provider-space identifiers", () => {
    const like = mapLike({
      id: "like-1",
      userId: "u1",
      trackId: "track-internal",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      track: makeTrackRow(),
    });
    expect(like).toEqual({
      id: "like-1",
      userId: "u1",
      provider: "jamendo",
      trackId: "track-1",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("mapFollow", () => {
  it("maps a follow row to provider-space identifiers", () => {
    const follow = mapFollow({
      id: "follow-1",
      userId: "u1",
      artistId: "artist-internal",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      artist: makeArtistRow(),
    });
    expect(follow).toEqual({
      id: "follow-1",
      userId: "u1",
      provider: "jamendo",
      artistId: "artist-1",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("mapRecentlyPlayed", () => {
  it("maps a recently played row", () => {
    const row = mapRecentlyPlayed({
      id: "rp-1",
      userId: "u1",
      trackId: "track-internal",
      playedAt: new Date("2026-01-03T00:00:00.000Z"),
      track: makeTrackRow(),
    });
    expect(row).toEqual({
      id: "rp-1",
      userId: "u1",
      provider: "jamendo",
      trackId: "track-1",
      playedAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("mapSearchHistory", () => {
  it("maps a search history row", () => {
    const row = mapSearchHistory({
      id: "sh-1",
      userId: "u1",
      query: "jazz",
      searchedAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(row).toEqual({
      id: "sh-1",
      userId: "u1",
      query: "jazz",
      searchedAt: "2026-01-03T00:00:00.000Z",
    });
  });
});

describe("mapPlaylistItem", () => {
  it("maps a playlist track row", () => {
    const item = mapPlaylistItem({
      id: "pt-1",
      playlistId: "pl-1",
      trackId: "track-internal",
      position: 0,
      addedAt: new Date("2026-01-03T00:00:00.000Z"),
      track: makeTrackRow(),
    });
    expect(item).toEqual({ id: "pt-1", trackId: "track-1", provider: "jamendo" });
  });
});

describe("mapPlaylist", () => {
  it("maps a playlist with items in ordered position sequence", () => {
    const row = {
      id: "pl-1",
      userId: "u1",
      title: "My Playlist",
      description: null,
      artwork: null,
      visibility: "private",
      shareToken: null,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      tracks: [
        {
          id: "pt-1",
          playlistId: "pl-1",
          trackId: "track-internal",
          position: 0,
          addedAt: new Date("2026-01-03T00:00:00.000Z"),
          track: makePodTrackRow({ providerTrackId: "track-1" }),
        },
        {
          id: "pt-2",
          playlistId: "pl-1",
          trackId: "track-internal-2",
          position: 1,
          addedAt: new Date("2026-01-03T00:00:00.000Z"),
          track: makePodTrackRow({ providerTrackId: "track-2" }),
        },
      ],
    } as Prisma.PlaylistGetPayload<{ include: typeof playlistTracksInclude }>;

    const playlist = mapPlaylist(row);
    expect(playlist).toEqual({
      id: "pl-1",
      ownerId: "u1",
      title: "My Playlist",
      visibility: "private",
      items: [
        { id: "pt-1", trackId: "track-1", provider: "jamendo" },
        { id: "pt-2", trackId: "track-2", provider: "jamendo" },
      ],
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
  });

  // Phase 47: a corrupt or unexpected stored visibility must fail CLOSED to
  // private. Anything else would make a private playlist publicly readable
  // because of a bad write.
  it("fails an unrecognised visibility closed to private", () => {
    const playlist = mapPlaylist({
      id: "pl-1",
      userId: "u1",
      title: "My Playlist",
      description: null,
      artwork: "https://img/cover.jpg",
      visibility: "unlisted",
      shareToken: "tok",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      tracks: [],
    } as unknown as Prisma.PlaylistGetPayload<{ include: typeof playlistTracksInclude }>);

    expect(playlist.visibility).toBe("private");
    // Artwork still round-trips: failing the visibility closed must not
    // silently discard other columns.
    expect(playlist.artwork).toBe("https://img/cover.jpg");
  });

  it("carries a shared playlist's token for its owner", () => {
    const playlist = mapPlaylist({
      id: "pl-1",
      userId: "u1",
      title: "Shared",
      description: null,
      artwork: null,
      visibility: "shared",
      shareToken: "abcdefghijklmnopqrstuvwxyz012345",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      tracks: [],
    } as unknown as Prisma.PlaylistGetPayload<{ include: typeof playlistTracksInclude }>);

    expect(playlist.visibility).toBe("shared");
    expect(playlist.shareToken).toBe("abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("collapsePlaylistMemberships", () => {
  const membership = (
    id: string,
    position: number,
    track: Partial<PodTrackRow>,
  ) => ({
    id,
    playlistId: "pl-1",
    trackId: `internal-${id}`,
    position,
    addedAt: new Date("2026-01-03T00:00:00.000Z"),
    track: makePodTrackRow(track),
  });

  const providerTrack = (
    provider: "spotify" | "deezer",
    providerTrackId: string,
    overrides: Partial<PodTrackRow> = {},
  ) =>
    makePodTrackRow({
      provider,
      providerTrackId,
      artist: {
        ...makeArtistRow(),
        provider: provider,
        providerArtistId: "shared-artist",
        name: "Shared Artist",
      },
      ...overrides,
    });

  it("returns a copy without scanning a collection that cannot repeat", () => {
    const entries = [membership("a", 0, { providerTrackId: "a" })];
    const collapsed = collapsePlaylistMemberships(entries);
    expect(collapsed).toEqual(entries);
    // Not the same array: a caller mutating the result must not be able to
    // reach back into what the caller passed in.
    expect(collapsed).not.toBe(entries);
  });

  it("keeps every distinct membership, in stored position order", () => {
    const collapsed = collapsePlaylistMemberships([
      membership("a", 0, { providerTrackId: "a" }),
      membership("b", 1, { providerTrackId: "b" }),
    ]);
    expect(collapsed.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("drops a second membership of the same source, first position wins", () => {
    const collapsed = collapsePlaylistMemberships([
      membership("first", 0, { providerTrackId: "x", title: "Song" }),
      membership("later", 1, { providerTrackId: "x", title: "Song" }),
    ]);
    // The survivor is the EARLIER row, so it keeps its own id, position and
    // addedAt — nothing is rewritten, and the dropped row stays removable.
    expect(collapsed.map((entry) => entry.id)).toEqual(["first"]);
    expect(collapsed[0]?.position).toBe(0);
  });

  it("drops a cross-provider rendering of the same recording", () => {
    const collapsed = collapsePlaylistMemberships([
      membership("spotify", 0, providerTrack("spotify", "sp-1") as Partial<PodTrackRow>),
      membership("deezer", 1, providerTrack("deezer", "dz-1") as Partial<PodTrackRow>),
    ]);
    expect(collapsed.map((entry) => entry.id)).toEqual(["spotify"]);
  });

  it("never drops a membership it cannot canonicalize", () => {
    // An artist row with no name: the track maps, but `toTrackIdentity` refuses
    // it, so the matcher tier is unreachable and the collapse must fail OPEN.
    // Two rows with the SAME title would collapse if they could canonicalize,
    // which is what makes this a real assertion rather than a tautology.
    const nameless = (id: string, position: number) =>
      membership(id, position, {
        providerTrackId: id,
        title: "Same Song",
        artist: { ...makeArtistRow(), name: "" },
      });
    const collapsed = collapsePlaylistMemberships([nameless("a", 0), nameless("b", 1)]);
    expect(collapsed).toHaveLength(2);
  });
});

describe("toProviderId", () => {
  it("narrows a string to a provider id", () => {
    expect(toProviderId("jamendo")).toBe("jamendo");
  });
});

function makeAlbumRow(overrides: Partial<Prisma.AlbumModel> = {}): Prisma.AlbumModel {
  return {
    id: "album-internal",
    provider: "jamendo",
    providerAlbumId: "album-1",
    name: "Album One",
    artistId: "artist-internal",
    image: "https://album-art",
    releaseDate: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

type PodTrackRow = Prisma.TrackGetPayload<{ include: { artist: true; album: true } }>;

function makePodTrackRow(
  overrides: Partial<Omit<PodTrackRow, "artist" | "album">> & {
    artist?: Prisma.ArtistModel;
    album?: Prisma.AlbumModel | null;
  } = {},
): PodTrackRow {
  return {
    ...makeTrackRow(),
    artist: makeArtistRow(),
    album: makeAlbumRow(),
    ...(overrides as Record<string, unknown>),
  } as PodTrackRow;
}

describe("mapTrackRow", () => {
  it("maps an included track row to a displayable Track", () => {
    expect(mapTrackRow(makePodTrackRow())).toEqual({
      id: "track-1",
      provider: "jamendo",
      providerTrackId: "track-1",
      title: "Song",
      artistId: "artist-1",
      artistName: "The Band",
      albumId: "album-1",
      albumName: "Album One",
      artworkUrl: "https://art",
      streamUrl: "https://stream",
      previewUrl: undefined,
      duration: 120,
      genres: ["rock"],
      releaseDate: "2026-01-01",
      providerUrl: undefined,
      explicit: false,
      metadata: undefined,
    });
  });

  it("preserves stable provider identity so rows canonicalize", () => {
    // Regression: without providerTrackId, toTrackIdentity throws, the
    // engine facade drops the row, and playback reports unavailable.
    const track = mapTrackRow(
      makePodTrackRow({ provider: "youtube", providerTrackId: "dQw4w9WgXcQ" }),
    );
    expect(track.providerTrackId).toBe("dQw4w9WgXcQ");
    expect(() => toTrackIdentity(track)).not.toThrow();
  });

  it("handles a track without an album", () => {
    const row = makePodTrackRow({ albumId: null, album: null });
    const mapped = mapTrackRow(row);
    expect(mapped.albumId).toBeUndefined();
    expect(mapped.albumName).toBeUndefined();
  });

  it("keeps JSON metadata when present", () => {
    const row = makePodTrackRow({ metadata: { popularity: 3 } });
    expect(mapTrackRow(row).metadata).toEqual({ popularity: 3 });
  });
});