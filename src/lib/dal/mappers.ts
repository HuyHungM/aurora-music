import type { Prisma } from "@/generated/prisma/client";
import { CanonicalDuplicateIndex } from "@/lib/domain";
import type {
  Artist,
  Follow,
  Like,
  Playlist,
  PlaylistItem,
  PlaylistVisibility,
  RecentlyPlayed,
  SearchHistory,
  Track,
  User,
} from "@/lib/domain";

/**
 * The narrowest `select` that can still produce a `User`.
 *
 * `User` carries no appearance or locale, so a full row read pulls the
 * `appearance` JSON column (the whole theme) and the locale/account columns
 * to discard them. `getCurrentUser` runs on every authenticated navigation.
 */
export const userColumns = {
  id: true,
  name: true,
  email: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export function mapUser(row: Prisma.UserModel | Prisma.UserGetPayload<{ select: typeof userColumns }>): User {
  return {
    id: row.id,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    image: row.image ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The `include` a playlist read must use to feed `mapPlaylist`.
 *
 * Exported next to the payload type it produces so the two cannot drift: a
 * narrower include here would be a *silent* behaviour change, because the
 * canonical collapse would then run against a track with no artist and
 * `mapTrackRow` would produce `artistName: undefined` — making every row look
 * uncanonicalizable and disabling the collapse with no type error at all.
 */
export const playlistTracksInclude = {
  tracks: {
    include: { track: { include: { artist: true, album: true } } },
    orderBy: { position: "asc" },
  },
} as const;

export function mapPlaylistItem(
  row: Prisma.PlaylistTrackGetPayload<{ include: { track: true } }>,
): PlaylistItem {
  return {
    id: row.id,
    trackId: row.track.providerTrackId,
    provider: row.track.provider as PlaylistItem["provider"],
  };
}

/**
 * Keeps the first membership of each canonical track, in stored position
 * order.
 *
 * Membership uniqueness is enforced on WRITE (`@@unique([playlistId, trackId])`
 * plus the canonical check in `addTrackToPlaylist`), so a playlist this build
 * has written cannot hold a repeat. This exists for the other case: a playlist
 * that predates the canonical check can hold two memberships for one recording,
 * reached through two provider paths. Cleaning that in SQL would mean comparing
 * titles and durations inside the database, which is the fuzzy deletion the
 * migration explicitly refuses; the calibrated matcher lives in TypeScript, so
 * the collapse happens here, in the single place memberships become tracks.
 *
 * FIRST POSITION WINS, so the ordering the listener arranged is preserved and
 * the surviving membership is the row that keeps its own `id`, `position` and
 * `addedAt` — nothing is rewritten, and removing the playlist's other copy
 * afterwards still works because that row is untouched in the database.
 *
 * Deduplicating here rather than in each read path is the point: the library
 * card's count, the detail list, the shared read and the reorder response all
 * derive from this one array, so they cannot disagree about how many songs a
 * playlist has.
 */
export function collapsePlaylistMemberships<
  T extends { position: number; track: Parameters<typeof mapTrackRow>[0] },
>(entries: readonly T[]): T[] {
  if (entries.length < 2) {
    return [...entries];
  }
  const index = new CanonicalDuplicateIndex();
  const kept: T[] = [];
  for (const entry of entries) {
    const track = mapTrackRow(entry.track);
    if (index.find(track)) {
      continue;
    }
    index.add(track);
    kept.push(entry);
  }
  return kept;
}

/**
 * The narrowest `include` that can still produce a `Like`.
 *
 * `Like` carries only the like's own identity plus the provider-scoped track
 * key, so a full `track` row (`metadata`/`streamUrl`/`previewUrl`/`genres`
 * JSON, and the artist's bio through it) is never read here. `listUserLikes`
 * is called with `take: 1000` on every authenticated page render to seed the
 * client like mirror, so the width of this select is a per-navigation cost,
 * not a per-call detail.
 */
export const likeIdentityInclude = {
  track: { select: { provider: true, providerTrackId: true } },
} satisfies Prisma.LikeInclude;

export function mapLike(row: Prisma.LikeGetPayload<{ include: typeof likeIdentityInclude }>): Like {
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

/**
 * Phase 47: a missing or unrecognised `visibility` row fails CLOSED to
 * "private". A private playlist must never become readable because of a
 * corrupt or unexpected stored value.
 */
function mapVisibility(value: string): PlaylistVisibility {
  return value === "shared" ? "shared" : "private";
}

export function mapPlaylist(
  row: Prisma.PlaylistGetPayload<{ include: typeof playlistTracksInclude }>,
): Playlist {
  return {
    id: row.id,
    ownerId: row.userId,
    title: row.title,
    description: row.description ?? undefined,
    artwork: row.artwork ?? undefined,
    visibility: mapVisibility(row.visibility),
    shareToken: row.shareToken ?? undefined,
    // Collapsed here, once, so every playlist read reports the same distinct
    // tracks. See `collapsePlaylistMemberships`.
    items: collapsePlaylistMemberships(row.tracks).map((entry) => ({
      id: entry.id,
      trackId: entry.track.providerTrackId,
      provider: entry.track.provider as PlaylistItem["provider"],
    })),
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
    // Stable provider identity must survive the catalog round trip:
    // without it toTrackIdentity throws, the engine facade drops the
    // row, and the controller reports the track unplayable.
    providerTrackId: row.providerTrackId,
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