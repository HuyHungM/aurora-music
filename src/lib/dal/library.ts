import type { PrismaClient } from "@/generated/prisma/client";
import type { Playlist, Track } from "@/lib/domain";
import { prisma } from "@/lib/db";
import {
  collapsePlaylistMemberships,
  mapPlaylist,
  mapTrackRow,
  playlistTracksInclude,
} from "@/lib/dal/mappers";
import { collapseRecentRows } from "@/lib/dal/recently-played";

export interface LibraryLiked {
  id: string;
  track: Track;
  likedAt: string;
}

export interface LibraryRecent {
  id: string;
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
      include: playlistTracksInclude,
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
      // Over-fetched, because the canonical collapse below can drop rows and
      // the panel should still show the number of DISTINCT tracks requested.
      take: (options.recentLimit ?? 20) * 2,
    }),
  ]);

  return {
    playlists: playlists.map(mapPlaylist),
    liked: likedRows.map((row) => ({
      id: row.id,
      track: mapTrackRow(row.track),
      likedAt: row.createdAt.toISOString(),
    })),
    // The same canonical collapse `listRecent` applies, so the library panel
    // and the home recency list can never disagree about what "recent" means.
    // Rows arrive newest-first, so the survivor is the most recent one. See
    // `recordPlayed` for why a residual cross-provider pair can exist at all.
    recent: collapseRecentRows(recentRows, options.recentLimit ?? recentRows.length).map(
      (row) => ({
        id: row.id,
        track: mapTrackRow(row.track),
        playedAt: row.playedAt.toISOString(),
      }),
    ),
  };
}

export async function getOwnedPlaylist(
  userId: string,
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<Playlist | null> {
  const row = await db.playlist.findUnique({
    where: { id: playlistId },
    include: playlistTracksInclude,
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
    include: playlistTracksInclude,
  });
  if (!row || row.userId !== userId) {
    return null;
  }
  return {
    playlist: mapPlaylist(row),
    // The same collapse `mapPlaylist` applied to `items`, so the rendered list
    // and the count on the library card can never disagree. First position wins,
    // so the arrangement the listener made is what they see.
    tracks: collapsePlaylistMemberships(row.tracks).map((entry) =>
      mapTrackRow(entry.track),
    ),
  };
}