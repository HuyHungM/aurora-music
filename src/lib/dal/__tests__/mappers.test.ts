import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import {
  mapFollow,
  mapLike,
  mapPlaylist,
  mapPlaylistItem,
  mapRecentlyPlayed,
  mapSearchHistory,
  mapTrackRow,
  mapUser,
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

describe("mapUser", () => {
  it("maps a full user row", () => {
    const user = mapUser({
      id: "u1",
      email: "a@b.c",
      name: "Alice",
      emailVerified: null,
      image: "https://img",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
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
    const user = mapUser({
      id: "u1",
      email: null,
      name: null,
      emailVerified: null,
      image: null,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
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
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      tracks: [
        {
          id: "pt-1",
          playlistId: "pl-1",
          trackId: "track-internal",
          position: 0,
          addedAt: new Date("2026-01-03T00:00:00.000Z"),
          track: makeTrackRow({ providerTrackId: "track-1" }),
        },
        {
          id: "pt-2",
          playlistId: "pl-1",
          trackId: "track-internal-2",
          position: 1,
          addedAt: new Date("2026-01-03T00:00:00.000Z"),
          track: makeTrackRow({ providerTrackId: "track-2" }),
        },
      ],
    } as Prisma.PlaylistGetPayload<{
      include: { tracks: { include: { track: true }; orderBy: { position: "asc" } } };
    }>;

    const playlist = mapPlaylist(row);
    expect(playlist).toEqual({
      id: "pl-1",
      ownerId: "u1",
      title: "My Playlist",
      items: [
        { id: "pt-1", trackId: "track-1", provider: "jamendo" },
        { id: "pt-2", trackId: "track-2", provider: "jamendo" },
      ],
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
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