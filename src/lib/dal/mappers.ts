import type { Prisma } from "@/generated/prisma/client";
import type {
  Artist,
  Follow,
  Like,
  Playlist,
  PlaylistItem,
  RecentlyPlayed,
  SearchHistory,
  Track,
  User,
} from "@/lib/domain";

export function mapUser(row: Prisma.UserModel): User {
  return {
    id: row.id,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    image: row.image ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapPlaylistItem(
  row: Prisma.PlaylistTrackGetPayload<{ include: { track: true } }>,
): PlaylistItem {
  return {
    id: row.id,
    trackId: row.track.providerTrackId,
    provider: row.track.provider as PlaylistItem["provider"],
  };
}

export function mapLike(row: Prisma.LikeGetPayload<{ include: { track: true } }>): Like {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.track.provider as Like["provider"],
    trackId: row.track.providerTrackId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapFollow(row: Prisma.FollowGetPayload<{ include: { artist: true } }>): Follow {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.artist.provider as Follow["provider"],
    artistId: row.artist.providerArtistId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapRecentlyPlayed(
  row: Prisma.RecentlyPlayedGetPayload<{ include: { track: true } }>,
): RecentlyPlayed {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.track.provider as RecentlyPlayed["provider"],
    trackId: row.track.providerTrackId,
    playedAt: row.playedAt.toISOString(),
  };
}

export function mapSearchHistory(row: Prisma.SearchHistoryModel): SearchHistory {
  return {
    id: row.id,
    userId: row.userId,
    query: row.query,
    searchedAt: row.searchedAt.toISOString(),
  };
}

export function mapPlaylist(
  row: Prisma.PlaylistGetPayload<{
    include: { tracks: { include: { track: true }; orderBy: { position: "asc" } } };
  }>,
): Playlist {
  return {
    id: row.id,
    ownerId: row.userId,
    title: row.title,
    description: row.description ?? undefined,
    artwork: row.artwork ?? undefined,
    items: row.tracks.map(mapPlaylistItem),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProviderId(value: string) {
  return value as Artist["provider"];
}

type TrackRow = Prisma.TrackGetPayload<{ include: { artist: true; album: true } }>;

export function mapTrackRow(row: TrackRow): Track {
  const genres = Array.isArray(row.genres)
    ? (row.genres.filter((genre): genre is string => typeof genre === "string"))
    : undefined;
  return {
    id: row.providerTrackId,
    provider: row.provider as Track["provider"],
    title: row.title,
    artistId: row.artist.providerArtistId,
    artistName: row.artist.name,
    albumId: row.album?.providerAlbumId,
    albumName: row.album?.name,
    artworkUrl: row.artworkUrl ?? undefined,
    streamUrl: row.streamUrl ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    duration: row.duration ?? undefined,
    genres,
    releaseDate: row.releaseDate ?? undefined,
    providerUrl: row.providerUrl ?? undefined,
    explicit: row.explicit ?? undefined,
    metadata:
      row.metadata != null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : undefined,
  };
}