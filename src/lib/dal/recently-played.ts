import type { PrismaClient } from "@/generated/prisma/client";
import type { Track } from "@/lib/domain";
import { CanonicalDuplicateIndex } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack } from "@/lib/dal/catalog";
import { mapRecentlyPlayed, mapTrackRow } from "@/lib/dal/mappers";
import type { RecentlyPlayed } from "@/lib/domain";

/**
 * How many distinct tracks one listener's recency list retains.
 *
 * This is a per-user RING of current state, not a play log: the bound is on
 * how many distinct tracks are remembered, not on how many plays are counted.
 */
const RECENT_LIMIT = 50;

/**
 * Over-read headroom for `listRecent`, so a collapsed pair still leaves `limit`
 * distinct rows to return. A repeat ratio far above this cannot survive the
 * write path, and the window is clamped so a hostile `limit` cannot turn the
 * read into a full table scan of a user's history.
 */
const RECENT_OVERREAD = 2;
const RECENT_MAX_FETCH = RECENT_LIMIT * 2;

/** Row shape `collapseRecentRows` needs, so it works for any caller. */
interface CollapsibleRecentRow {
  track: unknown;
}

/** The catalog row shape `mapTrackRow` accepts, as a named alias. */
type CatalogRow = Parameters<typeof mapTrackRow>[0];

/**
 * One row per (user, track), and one row per CANONICAL track.
 *
 * Two different guarantees, handled at two different layers, because they are
 * two different kinds of identity:
 *
 * 1. SAME SOURCE, repeated play. A Spotify row played ten times is the same
 *    `(userId, trackId)`. The `@@unique([userId, trackId])` constraint
 *    settles this atomically, so this is an `upsert` - never `create`, and
 *    never a read-then-write existence check that two concurrent requests
 *    could both pass. The replay moves the row to the newest position.
 *
 * 2. DIFFERENT SOURCE, same recording. Spotify:X and Deezer:Y for one song are
 *    two `Track` rows and so two distinct `trackId` values, which the
 *    constraint cannot see. Collapsing them needs the canonical matcher, and
 *    the matcher lives in TypeScript, not in a unique index - so it runs here,
 *    against at most `RECENT_LIMIT` rows, and points the write at the
 *    surviving row rather than creating a second one.
 *
 * A race can still leave two matcher-equivalent rows behind: two concurrent
 * plays of two provider renderings of one song can each miss the other's row
 * and both insert. The constraint still guarantees one row per exact
 * `(userId, trackId)`, so the exposure is bounded to cross-provider pairs, and
 * `collapseRecentRows` removes any residual pair on read, which is why a
 * listener never observes it.
 *
 * NOT ANALYTICS. This table stores current recency state and nothing else: its
 * only consumers are the recency list in the UI, radio seeding, and the
 * recommendation affinity signal. No consumer counts plays, and there is no
 * separate play-event table in Aurora, so collapsing repeats here discards no
 * event data. Were a per-play event log ever introduced it would be a new
 * model beside this one, never a relaxation of this constraint.
 */
export async function recordPlayed(
  userId: string,
  track: Track,
  db: PrismaClient = prisma,
  playedAt: Date = new Date(),
): Promise<void> {
  const trackId = await upsertTrack(db, track);

  // Bounded to RECENT_LIMIT rows, and read BEFORE the write so two concurrent
  // plays of the same source still land on the unique index rather than on a
  // stale read. The matcher cost is at most 50 cheap comparisons on a path
  // that already performs a track upsert and is rate limited to 300/minute by
  // `recordPlayedAction`.
  const existing = await db.recentlyPlayed.findMany({
    where: { userId },
    include: { track: { include: { artist: true, album: true } } },
    orderBy: { playedAt: "desc" },
    take: RECENT_LIMIT,
  });

  const duplicate = findRecentDuplicate(existing, track);
  const survivorTrackId = duplicate?.trackId ?? trackId;

  await db.recentlyPlayed.upsert({
    where: { userId_trackId: { userId, trackId: survivorTrackId } },
    create: { userId, trackId: survivorTrackId, playedAt },
    update: { playedAt },
  });

  const count = await db.recentlyPlayed.count({ where: { userId } });
  if (count > RECENT_LIMIT) {
    const oldest = await db.recentlyPlayed.findMany({
      where: { userId },
      orderBy: { playedAt: "desc" },
      select: { id: true },
      skip: RECENT_LIMIT,
    });
    if (oldest.length > 0) {
      await db.recentlyPlayed.deleteMany({
        where: { userId, id: { in: oldest.map((row) => row.id) } },
      });
    }
  }
}

/**
 * The existing row `track` duplicates, if any, plus that row's `trackId`.
 *
 * Built on the shared domain index rather than a local comparison, so the
 * write-side and read-side policies here cannot drift from the queue's or the
 * playlist's: same key format, same matcher, same classifications.
 */
function findRecentDuplicate(
  existing: readonly { trackId: string; track: CatalogRow }[],
  track: Track,
): { trackId: string } | null {
  const index = new CanonicalDuplicateIndex(existing.map((row) => mapTrackRow(row.track)));
  const duplicate = index.find(track);
  if (!duplicate) {
    return null;
  }
  const row = existing[duplicate.index];
  return row ? { trackId: row.trackId } : null;
}

export async function listRecent(
  userId: string,
  limit = 20,
  db: PrismaClient = prisma,
): Promise<RecentlyPlayed[]> {
  const rows = await db.recentlyPlayed.findMany({
    where: { userId },
    include: { track: { include: { artist: true, album: true } } },
    orderBy: { playedAt: "desc" },
    take: Math.min(Math.max(limit, 1) * RECENT_OVERREAD, RECENT_MAX_FETCH),
  });
  return collapseRecentRows(rows, limit).map(mapRecentlyPlayed);
}

/**
 * Final read-side net: one entry per canonical track, newest first.
 *
 * `recordPlayed` already enforces this and the unique constraint enforces its
 * exact-source half, so this is a safety net rather than the mechanism. It
 * exists because the residual cross-provider race documented on
 * `recordPlayed` is real, and a listener must never see the same song twice in
 * a list whose entire purpose is to be a recency list.
 *
 * FIRST occurrence wins, and rows arrive newest-first, so the survivor is the
 * most recent one. The `trackId` a caller receives is always the survivor's own
 * - a dropped row is never reported, so nothing downstream can address a row
 * that this function decided against.
 */
export function collapseRecentRows<T extends CollapsibleRecentRow>(
  rows: readonly T[],
  limit: number,
): T[] {
  const index = new CanonicalDuplicateIndex();
  const kept: T[] = [];
  for (const row of rows) {
    const track = mapTrackRow(row.track as CatalogRow);
    if (index.find(track)) {
      continue;
    }
    index.add(track);
    kept.push(row);
  }
  return kept.slice(0, Math.max(limit, 0));
}
