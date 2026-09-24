import type { PrismaClient } from "@/generated/prisma/client";
import type { Playlist, Track } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { mapPlaylist, mapTrackRow } from "@/lib/dal/mappers";

export interface LibraryLiked {
  track: Track;
  likedAt: string;
}

export interface LibraryRecent {
  track: Track;
  playedAt: string;
}

export interface LibraryOverview {
  playlists: Playlist[];
  liked: LibraryLiked[];
  recent: LibraryRecent[];
}

export interface LibraryOverviewOptions {
  likedLimit?: number;
  recentLimit?: number;
}

const trackInclude = {
  track: { include: { artist: true, album: true } },
} as const;

export async function getLibraryOverview(
  userId: string,
  options: LibraryOverviewOptions = {},
  db: PrismaClient = prisma,
): Promise<LibraryOverview> {
  const [playlists, likedRows, recentRows] = await Promise.all([
    db.playlist.findMany({
      where: { userId },
      include: {
        tracks: { include: { track: true }, orderBy: { position: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.like.findMany({
      where: { userId },
      include: trackInclude,
      orderBy: { createdAt: "desc" },
      take: options.likedLimit,
    }),
    db.recentlyPlayed.findMany({
      where: { userId },
      include: trackInclude,
      orderBy: { playedAt: "desc" },
      take: options.recentLimit,
    }),
  ]);

  return {
    playlists: playlists.map(mapPlaylist),
    liked: likedRows.map((row) => ({
      track: mapTrackRow(row.track),
      likedAt: row.createdAt.toISOString(),
    })),
    recent: recentRows.map((row) => ({
      track: mapTrackRow(row.track),
      playedAt: row.playedAt.toISOString(),
    })),
  };
}

export async function getOwnedPlaylist(
  userId: string,
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<Playlist | null> {
  const row = await db.playlist.findUnique({
    where: { id: playlistId },
    include: {
      tracks: { include: { track: true }, orderBy: { position: "asc" } },
    },
  });
  if (!row || row.userId !== userId) {
    return null;
  }
  return mapPlaylist(row);
}

export interface PlaylistDetail {
  playlist: Playlist;
  tracks: Track[];
}

export async function getPlaylistDetail(
  userId: string,
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<PlaylistDetail | null> {
  const row = await db.playlist.findUnique({
    where: { id: playlistId },
    include: {
      tracks: {
        include: { track: { include: { artist: true, album: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!row || row.userId !== userId) {
    return null;
  }
  return {
    playlist: mapPlaylist(row),
    tracks: row.tracks.map((entry) => mapTrackRow(entry.track)),
  };
}