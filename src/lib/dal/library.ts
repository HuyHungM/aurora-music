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
  /**
   * How many of the listener's playlists to load, or `0` to load none.
   *
   * Defaults to EVERY playlist, because the two pages that render playlist
   * cards (`/library` and `/`) genuinely show the whole collection and there is
   * no pagination to reach past a cap - capping here would silently hide
   * playlists with no way to get to them.
   *
   * But loading a playlist means loading every one of its tracks with their
   * artist and album rows, so a caller that reads `recent`/`liked` and never
   * touches `playlists` should pass `0` and skip the query outright. That is
   * what the radio and recommendation readers do; see
   * `getLibraryArtistNames` for the projection they use instead.
   */
  playlistLimit?: number;
}

/**
 * Default liked-track ceiling for callers that pass no limit.
 *
 * Equals the largest limit any production caller asks for (`/library`), so
 * adopting the default cannot silently shorten a real page. It exists to close
 * the unbounded shape: `take: undefined` means "every like the user has ever
 * made", hydrated with artist and album, for any caller that simply omitted
 * the option.
 */
const DEFAULT_LIKED_LIMIT = 50;

/** Default recently-played ceiling. Matches `recent`'s own pre-existing default. */
const DEFAULT_RECENT_LIMIT = 20;

const trackInclude = {
  track: { include: { artist: true, album: true } },
} as const;

export async function getLibraryOverview(
  userId: string,
  options: LibraryOverviewOptions = {},
  db: PrismaClient = prisma,
): Promise<LibraryOverview> {
  const playlistLimit = options.playlistLimit;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  const [playlists, likedRows, recentRows] = await Promise.all([
    // Skipped entirely rather than fetched-and-discarded: this is the most
    // expensive relation in the function (every playlist x every track x
    // artist x album), and two of its four callers never read the result.
    playlistLimit === 0
      ? Promise.resolve([])
      : db.playlist.findMany({
          where: { userId },
          include: playlistTracksInclude,
          orderBy: { createdAt: "desc" },
          take: playlistLimit,
        }),
    db.like.findMany({
      where: { userId },
      include: trackInclude,
      orderBy: { createdAt: "desc" },
      take: options.likedLimit ?? DEFAULT_LIKED_LIMIT,
    }),
    db.recentlyPlayed.findMany({
      where: { userId },
      include: trackInclude,
      orderBy: { playedAt: "desc" },
      // Over-fetched, because the canonical collapse below can drop rows and
      // the panel should still show the number of DISTINCT tracks requested.
      take: recentLimit * 2,
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
    //
    // Collapses to `recentLimit`, which is what `listRecent` collapses to for
    // the same default. It previously collapsed to `recentRows.length` instead,
    // so omitting the option let this path return up to 40 entries where
    // `listRecent` returned 20 - the two disagreeing about the very thing the
    // comment above says they cannot disagree about.
    recent: collapseRecentRows(recentRows, recentLimit).map((row) => ({
      id: row.id,
      track: mapTrackRow(row.track),
      playedAt: row.playedAt.toISOString(),
    })),
  };
}

/** Distinct artists a listener has recently played, newest history first. */
export interface LibraryArtistNames {
  recentArtists: string[];
  likedArtists: string[];
}

/**
 * The projection `getLibraryOverview` is not: just the artist names behind a
 * listener's recent plays and likes.
 *
 * `getLibraryOverview` is a rendering read. It hydrates a full `Track` per row
 * - artist AND album, artwork, duration, genres, the free-form metadata blob -
 * and runs the canonical duplicate collapse, all because the library renders
 * album names and because that collapse matches on title/duration/artist.
 *
 * The radio and recommendation readers want one string per row, so they call
 * this instead: two bounded queries selecting `artist.name` and nothing else.
 * That is the difference between reading ~20 columns across 3 joined tables and
 * reading 1 column across 2, for callers that discard the rest.
 *
 * Deliberately NOT reusing the canonical collapse. It exists to stop a
 * listener seeing the same recording twice in a list they read; here every
 * value is an artist name that both callers immediately de-duplicate, so a
 * collapsed row and an uncollapsed one produce the same string. `library-
 * artist-names.db.test.ts` pins that equivalence against the full read so the
 * shortcut cannot drift from it.
 */
export async function getLibraryArtistNames(
  userId: string,
  options: { likedLimit?: number; recentLimit?: number } = {},
  db: PrismaClient = prisma,
): Promise<LibraryArtistNames> {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  const [likedRows, recentRows] = await Promise.all([
    db.like.findMany({
      where: { userId },
      select: { track: { select: { artist: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: options.likedLimit ?? DEFAULT_LIKED_LIMIT,
    }),
    db.recentlyPlayed.findMany({
      where: { userId },
      select: { track: { select: { artist: { select: { name: true } } } } },
      orderBy: { playedAt: "desc" },
      // Over-read by the same factor the rendering read uses, so both derive
      // their names from the same window of history.
      take: recentLimit * 2,
    }),
  ]);

  return {
    recentArtists: recentRows.map((row) => row.track.artist.name),
    likedArtists: likedRows.map((row) => row.track.artist.name),
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