"use server";

import { requireUser } from "@/lib/dal/session";
import {
  createPlaylist,
  getPlaylist,
  listUserPlaylists,
  updatePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
} from "@/lib/dal/playlist";
import type { Track } from "@/lib/domain";
import type { TrackRef } from "@/lib/domain";
import {
  createPlaylistSchema,
  updatePlaylistSchema,
  deletePlaylistSchema,
  addTrackSchema,
  removeTrackSchema,
  reorderPlaylistSchema,
} from "@/lib/validation";

export async function createPlaylistAction(input: {
  title: string;
  description?: string;
}): Promise<{ ok: boolean; playlistId?: string; error?: string }> {
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
  input: { title?: string; description?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await requireUser();
    const parsed = updatePlaylistSchema.safeParse({ playlistId, ...input });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await updatePlaylist(user.id, parsed.data.playlistId, {
      title: parsed.data.title,
      description: parsed.data.description,
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to update playlist" };
  }
}

export async function deletePlaylistAction(
  playlistId: string,
): Promise<{ ok: boolean; error?: string }> {
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
): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await requireUser();
    const parsed = addTrackSchema.safeParse({ playlistId, track });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await addTrackToPlaylist(user.id, parsed.data.playlistId, parsed.data.track as Track);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to add track to playlist" };
  }
}

export async function removeTrackFromPlaylistAction(
  playlistId: string,
  trackRef: TrackRef,
): Promise<{ ok: boolean; error?: string }> {
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
  playlist?: Awaited<ReturnType<typeof getPlaylist>>;
  error?: string;
}> {
  try {
    const playlist = await getPlaylist(playlistId);
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
