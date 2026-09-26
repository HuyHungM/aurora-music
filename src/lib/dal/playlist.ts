import { randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { Playlist, PlaylistVisibility, SharedPlaylist, Track } from "@/lib/domain";
import { findCanonicalDuplicate } from "@/lib/domain";
import { prisma } from "@/lib/db";
import { upsertTrack, findTrackInternalId } from "@/lib/dal/catalog";
import { isUniqueViolation } from "@/lib/dal/like";
import {
  collapsePlaylistMemberships,
  mapPlaylist,
  mapTrackRow,
  playlistTracksInclude,
} from "@/lib/dal/mappers";
import {
  AuthorizationError,
  ConflictError,
  ResourceNotFoundError,
} from "@/lib/errors";
import type { TrackRef } from "@/lib/domain";

/**
 * The canonical collapse in `mapPlaylist` needs a mapped `Track`, which needs
 * the artist (always) and the album (optional). Loading them here rather than
 * per call site is what keeps one implementation instead of five.
 */
const playlistInclude = playlistTracksInclude;

export async function createPlaylist(
  userId: string,
  input: { title: string; description?: string; artwork?: string },
  db: PrismaClient = prisma,
): Promise<Playlist> {
  const row = await db.playlist.create({
    data: {
      userId,
      title: input.title,
      description: input.description,
      artwork: input.artwork,
    },
    include: playlistInclude,
  });
  return mapPlaylist(row);
}

/**
 * Phase 47 share token.
 *
 * 24 cryptographically random bytes encoded base64url: 192 bits of
 * entropy, always exactly 32 characters from `[A-Za-z0-9_-]`. It
 * encodes nothing — no primary key, no owner id, no provider id, no
 * counter — so a leaked link reveals nothing about the database and
 * cannot be walked. Enumeration is infeasible (2^192 guesses), and the
 * `visibility = "shared"` check on every read is what actually
 * authorizes access, not the token's shape.
 */
export function mintShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function listUserPlaylists(
  userId: string,
  db: PrismaClient = prisma,
): Promise<Playlist[]> {
  const rows = await db.playlist.findMany({
    where: { userId },
    include: playlistInclude,
    // Multi-field orderBy must be an ARRAY. The object form is rejected by
    // the generated client ("Expected PlaylistOrderByWithRelationInput[]"),
    // which made every signed-in listener's playlist list fail outright.
    // `id` is the tie-break so the order is total and stable.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(mapPlaylist);
}

async function requirePlaylistOwner(
  ownerId: string,
  playlistId: string,
  db: PrismaClient,
) {
  const row = await db.playlist.findUnique({ where: { id: playlistId } });
  if (!row) {
    throw new ResourceNotFoundError(`Playlist ${playlistId} was not found`, "playlist");
  }
  if (row.userId !== ownerId) {
    throw new AuthorizationError("You do not own this playlist");
  }
  return row;
}

/**
 * Owner-gated partial update.
 *
 * Absent and explicit-null are different intents and are preserved
 * separately: `title` absent leaves it alone, while `description: null` or
 * `artwork: null` CLEARS the column (Phase 47 needs that to remove custom
 * artwork and fall back to the default). Collapsing both with `?? undefined`
 * — as this used to — silently dropped every clear, so "remove artwork"
 * would have reported success and changed nothing.
 */
export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: { title?: string; description?: string | null; artwork?: string | null },
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const data: Prisma.PlaylistUpdateInput = {};
  if (input.title !== undefined) {
    data.title = input.title;
  }
  if (input.description !== undefined) {
    data.description = input.description;
  }
  if (input.artwork !== undefined) {
    data.artwork = input.artwork;
  }
  const row = await db.playlist.update({
    where: { id: playlistId },
    data,
    include: playlistInclude,
  });
  return mapPlaylist(row);
}

export interface PlaylistVisibilityResult {
  visibility: PlaylistVisibility;
  /** Present only while shared; null once sharing is revoked. */
  shareToken: string | null;
}

/**
 * Phase 47 sharing toggle (owner-only).
 *
 * Going shared mints a token if the playlist does not already have one,
 * so re-sharing an already-shared playlist is idempotent and an existing
 * link keeps working. Going private CLEARS the token, which is what makes
 * revocation real: the old URL stops resolving immediately.
 */
export async function setPlaylistVisibility(
  userId: string,
  playlistId: string,
  visibility: PlaylistVisibility,
  db: PrismaClient = prisma,
): Promise<PlaylistVisibilityResult> {
  await requirePlaylistOwner(userId, playlistId, db);
  if (visibility === "private") {
    await db.playlist.update({
      where: { id: playlistId },
      data: { visibility: "private", shareToken: null },
      select: { visibility: true, shareToken: true },
    });
    return { visibility: "private", shareToken: null };
  }

  const current = await db.playlist.findUniqueOrThrow({
    where: { id: playlistId },
    select: { shareToken: true },
  });
  if (current.shareToken) {
    const row = await db.playlist.update({
      where: { id: playlistId },
      data: { visibility: "shared" },
      select: { visibility: true, shareToken: true },
    });
    return { visibility: "shared", shareToken: row.shareToken };
  }

  // A unique collision on a 192-bit random token is not physically
  // reachable, but retrying once keeps a theoretical collision from
  // surfacing as a raw Prisma error to the owner.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const row = await db.playlist.update({
        where: { id: playlistId },
        data: { visibility: "shared", shareToken: mintShareToken() },
        select: { visibility: true, shareToken: true },
      });
      return { visibility: "shared", shareToken: row.shareToken };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) {
        throw error;
      }
    }
  }
  throw new ConflictError("Could not create a share link. Try again.");
}

const sharedPlaylistInclude = {
  user: { select: { name: true } },
  // Same include as an owner read, so the canonical membership collapse in
  // `mapPlaylist` applies to a public playlist exactly as it does to a
  // private one. A share link must not be a way to see duplicates the owner
  // cannot.
  ...playlistTracksInclude,
} as const;

/**
 * Phase 47 public read, by share token only.
 *
 * Two independent conditions must hold, and they are enforced in the query
 * rather than in application code: the row must carry this exact token AND
 * `visibility` must be "shared". Revoking sharing nulls the token, so a
 * revoked link and a private playlist are both simply absent here.
 *
 * Returns `SharedPlaylist`, which has no `ownerId` and no `shareToken`
 * field, so nothing downstream — including metadata and JSON payloads —
 * can leak the owner's identity or the reusable token. Owner attribution
 * is a display name only, and a playlist whose owner has no name falls
 * back to a neutral label rather than exposing the account email.
 */
export async function getSharedPlaylistByToken(
  shareToken: string,
  db: PrismaClient = prisma,
): Promise<SharedPlaylist | null> {
  const row = await db.playlist.findFirst({
    where: { shareToken, visibility: "shared" },
    include: sharedPlaylistInclude,
  });
  if (!row) {
    return null;
  }
  const name = row.user.name?.trim();
  return {
    title: row.title,
    description: row.description ?? undefined,
    artwork: row.artwork ?? undefined,
    ownerDisplayName: name && name.length > 0 ? name : "Aurora",
    items: row.tracks.map((track) => ({
      id: track.id,
      trackId: track.track.providerTrackId,
      provider: track.track.provider as SharedPlaylist["items"][number]["provider"],
    })),
  };
}

/**
 * Resolves the ordered display tracks of a shared playlist for the public
 * route. Reads through the same token+visibility gate as
 * `getSharedPlaylistByToken` so a private playlist's track list is
 * unreachable even by racing a second query.
 */
export async function getSharedPlaylistTracks(
  shareToken: string,
  db: PrismaClient = prisma,
): Promise<Track[]> {
  const row = await db.playlist.findFirst({
    where: { shareToken, visibility: "shared" },
    include: {
      tracks: {
        include: { track: { include: { artist: true, album: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!row) {
    return [];
  }
  return row.tracks.map((entry) => mapTrackRow(entry.track));
}

export async function deletePlaylist(
  userId: string,
  playlistId: string,
  db: PrismaClient = prisma,
): Promise<void> {
  await requirePlaylistOwner(userId, playlistId, db);
  await db.playlist.delete({ where: { id: playlistId } });
}

export async function addTrackToPlaylist(
  userId: string,
  playlistId: string,
  track: Track,
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const trackId = await upsertTrack(db, track);
  let result;
  try {
    result = await db.$transaction(async (tx) => {
      // ONE MEMBERSHIP PER CANONICAL TRACK. `@@unique([playlistId, trackId])`
      // already rejects the same source twice, atomically, which is the exact
      // half of the rule and the reason two concurrent adds of one track can
      // never both commit. The check below covers the half the constraint
      // cannot see: Spotify:X and Deezer:Y for one recording are two `Track`
      // rows and two `trackId` values.
      //
      // It runs through the same domain detector the queue and the recency
      // list use - same key format, same matcher, same exact|strong policy -
      // so "already in this playlist" means the same thing on every surface.
      // A user choosing to add a track they can already see listed gets the
      // existing, tested conflict response rather than a silent second copy.
      const members = await tx.playlistTrack.findMany({
        where: { playlistId },
        include: { track: { include: { artist: true, album: true } } },
        orderBy: { position: "asc" },
      });
      const duplicate = findCanonicalDuplicate(
        track,
        members.map((member) => mapTrackRow(member.track)),
      );
      if (duplicate) {
        throw new ConflictError("This track is already in the playlist");
      }
      const aggregate = await tx.playlistTrack.aggregate({
        where: { playlistId },
        _max: { position: true },
      });
      const nextPosition = (aggregate._max.position ?? -1) + 1;
      await tx.playlistTrack.create({
        data: { playlistId, trackId, position: nextPosition },
      });
      return tx.playlist.findUniqueOrThrow({
        where: { id: playlistId },
        include: playlistInclude,
      });
    });
  } catch (error) {
    // Lost a concurrent-insert race after passing the membership check:
    // re-read once to report the duplicate correctly instead of leaking
    // a raw unique violation. A position-slot collision (different track)
    // rethrows untouched — still a safe failure, retried by the user.
    //
    // The re-read is exact on purpose. The residual race the canonical check
    // cannot close is two CONCURRENT adds of two provider renderings of one
    // song: both miss each other and both commit, because only
    // `@@unique([playlistId, trackId])` arbitrates and it cannot see that the
    // two rows are one song. Re-running the matcher here would still be a
    // plain read racing the other transaction, so it would convert a correct
    // insert into a spurious failure instead of preventing anything. Bounding
    // that case to concurrent cross-provider adds is a deliberate trade for
    // never rejecting a legitimate distinct song.
    if (isUniqueViolation(error)) {
      const current = await db.playlistTrack.findFirst({
        where: { playlistId, trackId },
      });
      if (current) {
        throw new ConflictError("This track is already in the playlist");
      }
    }
    throw error;
  }
  return mapPlaylist(result);
}

export async function removeTrackFromPlaylist(
  userId: string,
  playlistId: string,
  ref: TrackRef,
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  const trackId = await findTrackInternalId(db, ref);
  return db.$transaction(async (tx) => {
    const row = await tx.playlistTrack.findFirst({
      where: { playlistId, trackId: trackId ?? undefined },
    });
    if (!row) {
      throw new ResourceNotFoundError("This track is not in the playlist", "playlistTrack");
    }
    await tx.playlistTrack.delete({ where: { id: row.id } });
    await compactPositions(tx, playlistId);
    const updated = await tx.playlist.findUniqueOrThrow({
      where: { id: playlistId },
      include: playlistInclude,
    });
    return mapPlaylist(updated);
  });
}

export async function reorderPlaylist(
  userId: string,
  playlistId: string,
  orderedRefs: TrackRef[],
  db: PrismaClient = prisma,
): Promise<Playlist> {
  await requirePlaylistOwner(userId, playlistId, db);
  return db.$transaction(async (tx) => {
    const rows = await tx.playlistTrack.findMany({
      where: { playlistId },
      include: { track: { include: { artist: true, album: true } } },
      orderBy: { position: "asc" },
    });
    // The client orders what it was SHOWN, and what it was shown is the
    // canonical collapse (see `mapPlaylist`). Validating against the raw row
    // count instead would make a playlist that predates the canonical
    // membership check un-reorderable: the user sees one track and sends one
    // ref, and the extra hidden row would look like a mismatch.
    const visible = collapsePlaylistMemberships(rows);
    if (visible.length !== orderedRefs.length) {
      throw new ConflictError(
        "Order must contain exactly one entry per track currently in the playlist",
      );
    }
    const byRef = new Map(
      rows.map((row) => [
        `${row.track.provider}:${row.track.providerTrackId}`,
        row.id,
      ]),
    );
    const missing = orderedRefs.some((ref) => !byRef.has(`${ref.provider}:${ref.providerTrackId}`));
    if (missing) {
      throw new ConflictError("Order references a track that is not in the playlist");
    }
    // Free the target slots first: shifting every row out of 0..n-1 avoids
    // stepping on temporarily occupied positions while applying the new order.
    // Every row is shifted, including any membership the collapse hid, so a
    // hidden row lands beyond the ordered range instead of colliding with
    // `@@unique([playlistId, position])` or reappearing mid-sequence.
    const shift = rows.length;
    for (const row of rows) {
      await tx.playlistTrack.update({
        where: { id: row.id },
        data: { position: row.position + shift },
      });
    }
    for (let index = 0; index < orderedRefs.length; index += 1) {
      const ref = orderedRefs[index];
      const rowId = byRef.get(`${ref.provider}:${ref.providerTrackId}`);
      if (rowId) {
        await tx.playlistTrack.update({
          where: { id: rowId },
          data: { position: index },
        });
      }
    }
    const updated = await tx.playlist.findUniqueOrThrow({
      where: { id: playlistId },
      include: playlistInclude,
    });
    return mapPlaylist(updated);
  });
}

async function compactPositions(
  db: Prisma.TransactionClient,
  playlistId: string,
): Promise<void> {
  const rows = await db.playlistTrack.findMany({
    where: { playlistId },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.position !== index) {
      await db.playlistTrack.update({
        where: { id: row.id },
        data: { position: index },
      });
    }
  }
}