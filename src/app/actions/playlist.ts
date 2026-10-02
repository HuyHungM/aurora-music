"use server";

import { requireUser } from "@/lib/dal/session";
import { ConflictError } from "@/lib/errors";
import {
  createPlaylist,
  listUserPlaylists,
  updatePlaylist,
  setPlaylistVisibility,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
  type PlaylistVisibilityResult,
} from "@/lib/dal/playlist";
import { getOwnedPlaylist } from "@/lib/dal/library";
import type { Track } from "@/lib/domain";
import type { PlaylistVisibility, TrackRef } from "@/lib/domain";
import {
  createPlaylistSchema,
  updatePlaylistSchema,
  deletePlaylistSchema,
  addTrackSchema,
  removeTrackSchema,
  reorderPlaylistSchema,
  idSchema,
  playlistVisibilityUpdateSchema,
} from "@/lib/validation";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";
import { isOfflineTrack } from "@/lib/offline/isolation";

/**
 * Playlist writes are the only mutation surface in Aurora that changes durable,
 * user-visible state, so every one of them is budgeted (RULE 12). The ceiling
 * is well above what a person performs - managing a playlist is tens of
 * actions, not hundreds - while still bounding a scripted loop.
 */
async function playlistMutationGuard(): Promise<GuardFailure | null> {
  return guardServerAction({
    featureOffMessage: "Too many playlist changes. Please slow down.",
    bucket: "playlistMutate",
  });
}

export async function createPlaylistAction(input: {
  title: string;
  description?: string;
}): Promise<{ ok: boolean; playlistId?: string; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    const user = await requireUser();
    const parsed = createPlaylistSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    const playlist = await createPlaylist(user.id, parsed.data);
    return { ok: true, playlistId: playlist.id };
  } catch {
    return { ok: false, error: "Failed to create playlist" };
  }
}

export async function updatePlaylistAction(
  playlistId: string,
  input: { title?: string; description?: string | null; artwork?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    const user = await requireUser();
    // `input` first, so the POSITIONAL `playlistId` wins. The reverse order let a
    // `playlistId` key inside the second argument — which arrives as JSON over
    // the wire and is therefore not type-checked — override the id the caller
    // was actually invoked with. Ownership is still re-checked against the
    // effective id, so this was argument confusion rather than an authorization
    // bypass, but a durable write should key off the argument it was given.
    const parsed = updatePlaylistSchema.safeParse({ ...input, playlistId });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    // Only keys actually present are forwarded, so omitting `artwork` in a
    // title-only edit leaves the custom artwork untouched while an explicit
    // `artwork: null` clears it.
    await updatePlaylist(user.id, parsed.data.playlistId, {
      title: parsed.data.title,
      description: parsed.data.description,
      artwork: parsed.data.artwork,
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to update playlist" };
  }
}

export type SetPlaylistVisibilityActionResult =
  | ({ ok: true } & PlaylistVisibilityResult)
  | ({ ok: false; error: string } & Partial<GuardFailure>);

const SHARING_OFF_MESSAGE = "Playlist sharing is unavailable right now.";

/**
 * Phase 47 sharing toggle. Owner-only: authorization lives in
 * `setPlaylistVisibility` (`requirePlaylistOwner`), so a non-owner gets a
 * failure regardless of what the client renders. The share token is
 * returned to the OWNER only, for building the share URL.
 *
 * The `playlistSharing` kill switch is checked only on the way TO shared, never
 * on the way back. That asymmetry is deliberate and load-bearing: a kill switch
 * that also blocked "make private" would leave already-shared playlists
 * publicly reachable with no way for their owner to withdraw them. Revocation
 * must always be available, including while sharing is switched off.
 */
export async function setPlaylistVisibilityAction(
  playlistId: string,
  visibility: unknown,
): Promise<SetPlaylistVisibilityActionResult> {
  const parsed = playlistVisibilityUpdateSchema.safeParse({ playlistId, visibility });
  if (!parsed.success) {
    return { ok: false, error: "Invalid input" };
  }
  if (parsed.data.visibility === "shared") {
    const denied = await guardServerAction({
      feature: "playlistSharing",
      featureOffMessage: SHARING_OFF_MESSAGE,
      bucket: "playlistMutate",
    });
    if (denied) {
      return denied;
    }
  }
  try {
    const user = await requireUser();
    const result = await setPlaylistVisibility(
      user.id,
      parsed.data.playlistId,
      parsed.data.visibility as PlaylistVisibility,
    );
    return { ok: true, ...result };
  } catch {
    return { ok: false, error: "Failed to update sharing" };
  }
}

export async function deletePlaylistAction(
  playlistId: string,
): Promise<{ ok: boolean; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    const user = await requireUser();
    const parsed = deletePlaylistSchema.safeParse({ playlistId });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await deletePlaylist(user.id, parsed.data.playlistId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to delete playlist" };
  }
}

export async function addTrackToPlaylistAction(
  playlistId: string,
  track: Track,
): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    // A playlist entry is catalog data every user of the playlist can read.
    // An offline track has no resolvable identity outside the folder grant it
    // came from, so adding one would publish a permanently broken row.
    if (isOfflineTrack(track)) {
      return { ok: false, error: "Local files cannot be added to a playlist" };
    }
    const user = await requireUser();
    const parsed = addTrackSchema.safeParse({ playlistId, track });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await addTrackToPlaylist(user.id, parsed.data.playlistId, parsed.data.track as Track);
    return { ok: true };
  } catch (error) {
    // Duplicate membership is a domain conflict, not a server failure:
    // surfaced verbatim so the picker can show "Already in playlist".
    if (error instanceof ConflictError) {
      return { ok: false, conflict: true, error: "Already in playlist" };
    }
    return { ok: false, error: "Failed to add track to playlist" };
  }
}

export async function removeTrackFromPlaylistAction(
  playlistId: string,
  trackRef: TrackRef,
): Promise<{ ok: boolean; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    const user = await requireUser();
    const parsed = removeTrackSchema.safeParse({ playlistId, trackRef });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await removeTrackFromPlaylist(user.id, parsed.data.playlistId, parsed.data.trackRef);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to remove track from playlist" };
  }
}

export async function reorderPlaylistAction(
  playlistId: string,
  orderedRefs: TrackRef[],
): Promise<{ ok: boolean; error?: string }> {
  const denied = await playlistMutationGuard();
  if (denied) {
    return { ok: false, error: denied.error };
  }
  try {
    const user = await requireUser();
    const parsed = reorderPlaylistSchema.safeParse({ playlistId, orderedRefs });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await reorderPlaylist(user.id, parsed.data.playlistId, parsed.data.orderedRefs);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to reorder playlist" };
  }
}

export async function getPlaylistAction(
  playlistId: string,
): Promise<{
  ok: boolean;
  playlist?: Awaited<ReturnType<typeof getOwnedPlaylist>>;
  error?: string;
}> {
  try {
    // Phase 47 security fix. This action previously called an ungated
    // by-id DAL read with no session at all, so anyone who knew or guessed
    // a playlist id could read its title, description, artwork and entire
    // track list — including private playlists. The owner-scoped read is
    // now the only path, and an unauthenticated call fails closed.
    const user = await requireUser();
    const parsed = idSchema.safeParse(playlistId);
    if (!parsed.success) {
      return { ok: false, error: "Invalid input" };
    }
    const playlist = await getOwnedPlaylist(user.id, parsed.data);
    return { ok: true, playlist: playlist ?? undefined };
  } catch {
    return { ok: false, error: "Failed to fetch playlist" };
  }
}

export async function listUserPlaylistsAction(): Promise<{
  ok: boolean;
  playlists?: Awaited<ReturnType<typeof listUserPlaylists>>;
  error?: string;
}> {
  try {
    const user = await requireUser();
    const playlists = await listUserPlaylists(user.id);
    return { ok: true, playlists };
  } catch {
    return { ok: false, error: "Failed to fetch playlists" };
  }
}
