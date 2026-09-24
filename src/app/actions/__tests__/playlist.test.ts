import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/dal/playlist", () => ({
  createPlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  listUserPlaylists: vi.fn(),
  updatePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addTrackToPlaylist: vi.fn(),
  removeTrackFromPlaylist: vi.fn(),
  reorderPlaylist: vi.fn(),
}));

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
import {
  createPlaylistAction,
  updatePlaylistAction,
  deletePlaylistAction,
  addTrackToPlaylistAction,
  removeTrackFromPlaylistAction,
  reorderPlaylistAction,
  getPlaylistAction,
  listUserPlaylistsAction,
} from "../playlist";

const mockUser = { id: "user-1" } as never;

const mockTrack: Track = {
  id: "track-1",
  provider: "jamendo",
  title: "Test Track",
  artistId: "artist-1",
  artistName: "Test Artist",
  albumId: "album-1",
  albumName: "Test Album",
  duration: 180,
};

const mockPlaylist = {
  id: "pl1",
  ownerId: "user-1",
  title: "My Playlist",
  description: "A great mix",
  items: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("createPlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates playlist for authenticated user", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(createPlaylist).mockResolvedValue(mockPlaylist);

    const result = await createPlaylistAction({ title: "My Playlist" });

    expect(result).toEqual({ ok: true, playlistId: "pl1" });
    expect(createPlaylist).toHaveBeenCalledWith("user-1", { title: "My Playlist", description: undefined });
  });

  it("creates playlist with description", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(createPlaylist).mockResolvedValue(mockPlaylist);

    const result = await createPlaylistAction({ title: "My Playlist", description: "A great mix" });

    expect(result).toEqual({ ok: true, playlistId: "pl1" });
    expect(createPlaylist).toHaveBeenCalledWith("user-1", { title: "My Playlist", description: "A great mix" });
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await createPlaylistAction({ title: "My Playlist" });

    expect(result.ok).toBe(false);
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid title", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await createPlaylistAction({ title: "" });

    expect(result).toEqual({ ok: false, error: "Playlist name is required" });
  });

  it("returns ok:false when title is whitespace only", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await createPlaylistAction({ title: "   " });

    expect(result).toEqual({ ok: false, error: "Playlist name is required" });
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(createPlaylist).mockRejectedValue(new Error("DB error"));

    const result = await createPlaylistAction({ title: "My Playlist" });

    expect(result.ok).toBe(false);
  });
});

describe("updatePlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates playlist title", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(updatePlaylist).mockResolvedValue(mockPlaylist);

    const result = await updatePlaylistAction("pl1", { title: "Updated" });

    expect(result).toEqual({ ok: true });
    expect(updatePlaylist).toHaveBeenCalledWith("user-1", "pl1", { title: "Updated", description: undefined });
  });

  it("updates playlist description", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(updatePlaylist).mockResolvedValue(mockPlaylist);

    const result = await updatePlaylistAction("pl1", { description: "New desc" });

    expect(result).toEqual({ ok: true });
    expect(updatePlaylist).toHaveBeenCalledWith("user-1", "pl1", { title: undefined, description: "New desc" });
  });

  it("clears playlist description with null", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(updatePlaylist).mockResolvedValue(mockPlaylist);

    const result = await updatePlaylistAction("pl1", { description: null });

    expect(result).toEqual({ ok: true });
    expect(updatePlaylist).toHaveBeenCalledWith("user-1", "pl1", { title: undefined, description: null });
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await updatePlaylistAction("pl1", { title: "Updated" });

    expect(result.ok).toBe(false);
    expect(updatePlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid playlistId", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await updatePlaylistAction("", { title: "Updated" });

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when title is whitespace only", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await updatePlaylistAction("pl1", { title: "   " });

    expect(result).toEqual({ ok: false, error: "Playlist name is required" });
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(updatePlaylist).mockRejectedValue(new Error("DB error"));

    const result = await updatePlaylistAction("pl1", { title: "Updated" });

    expect(result.ok).toBe(false);
  });
});

describe("deletePlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes playlist", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(deletePlaylist).mockResolvedValue(undefined);

    const result = await deletePlaylistAction("pl1");

    expect(result).toEqual({ ok: true });
    expect(deletePlaylist).toHaveBeenCalledWith("user-1", "pl1");
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await deletePlaylistAction("pl1");

    expect(result.ok).toBe(false);
    expect(deletePlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid playlistId", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await deletePlaylistAction("");

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(deletePlaylist).mockRejectedValue(new Error("DB error"));

    const result = await deletePlaylistAction("pl1");

    expect(result.ok).toBe(false);
  });
});

describe("addTrackToPlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds track to playlist", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(addTrackToPlaylist).mockResolvedValue(mockPlaylist);

    const result = await addTrackToPlaylistAction("pl1", mockTrack);

    expect(result).toEqual({ ok: true });
    expect(addTrackToPlaylist).toHaveBeenCalledWith("user-1", "pl1", mockTrack);
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await addTrackToPlaylistAction("pl1", mockTrack);

    expect(result.ok).toBe(false);
    expect(addTrackToPlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid playlistId", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);

    const result = await addTrackToPlaylistAction("", mockTrack);

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(addTrackToPlaylist).mockRejectedValue(new Error("DB error"));

    const result = await addTrackToPlaylistAction("pl1", mockTrack);

    expect(result.ok).toBe(false);
  });
});

describe("removeTrackFromPlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes track from playlist", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(removeTrackFromPlaylist).mockResolvedValue(mockPlaylist);
    const trackRef = { provider: "jamendo", providerTrackId: "track-1" };

    const result = await removeTrackFromPlaylistAction("pl1", trackRef);

    expect(result).toEqual({ ok: true });
    expect(removeTrackFromPlaylist).toHaveBeenCalledWith("user-1", "pl1", trackRef);
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));
    const trackRef = { provider: "jamendo", providerTrackId: "track-1" };

    const result = await removeTrackFromPlaylistAction("pl1", trackRef);

    expect(result.ok).toBe(false);
    expect(removeTrackFromPlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid playlistId", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    const trackRef = { provider: "jamendo", providerTrackId: "track-1" };

    const result = await removeTrackFromPlaylistAction("", trackRef);

    expect(result.ok).toBe(false);
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(removeTrackFromPlaylist).mockRejectedValue(new Error("DB error"));
    const trackRef = { provider: "jamendo", providerTrackId: "track-1" };

    const result = await removeTrackFromPlaylistAction("pl1", trackRef);

    expect(result.ok).toBe(false);
  });
});

describe("reorderPlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reorders playlist", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(reorderPlaylist).mockResolvedValue(mockPlaylist);
    const orderedRefs = [
      { provider: "jamendo", providerTrackId: "track-1" },
      { provider: "jamendo", providerTrackId: "track-2" },
    ];

    const result = await reorderPlaylistAction("pl1", orderedRefs);

    expect(result).toEqual({ ok: true });
    expect(reorderPlaylist).toHaveBeenCalledWith("user-1", "pl1", orderedRefs);
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));
    const orderedRefs = [{ provider: "jamendo", providerTrackId: "track-1" }];

    const result = await reorderPlaylistAction("pl1", orderedRefs);

    expect(result.ok).toBe(false);
    expect(reorderPlaylist).not.toHaveBeenCalled();
  });

  it("returns ok:false for invalid playlistId", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    const orderedRefs = [{ provider: "jamendo", providerTrackId: "track-1" }];

    const result = await reorderPlaylistAction("", orderedRefs);

    expect(result.ok).toBe(false);
  });

  it("returns ok:true for empty orderedRefs", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(reorderPlaylist).mockResolvedValue(mockPlaylist);

    const result = await reorderPlaylistAction("pl1", []);

    expect(result.ok).toBe(true);
    expect(reorderPlaylist).toHaveBeenCalledWith("user-1", "pl1", []);
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(reorderPlaylist).mockRejectedValue(new Error("DB error"));
    const orderedRefs = [{ provider: "jamendo", providerTrackId: "track-1" }];

    const result = await reorderPlaylistAction("pl1", orderedRefs);

    expect(result.ok).toBe(false);
  });
});

describe("getPlaylistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns playlist", async () => {
    vi.mocked(getPlaylist).mockResolvedValue(mockPlaylist);

    const result = await getPlaylistAction("pl1");

    expect(result).toEqual({ ok: true, playlist: mockPlaylist });
    expect(getPlaylist).toHaveBeenCalledWith("pl1");
  });

  it("returns ok:false when playlist not found", async () => {
    vi.mocked(getPlaylist).mockResolvedValue(null);

    const result = await getPlaylistAction("nonexistent");

    expect(result).toEqual({ ok: true, playlist: undefined });
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(getPlaylist).mockRejectedValue(new Error("DB error"));

    const result = await getPlaylistAction("pl1");

    expect(result.ok).toBe(false);
  });
});

describe("listUserPlaylistsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user playlists", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(listUserPlaylists).mockResolvedValue([mockPlaylist]);

    const result = await listUserPlaylistsAction();

    expect(result).toEqual({ ok: true, playlists: [mockPlaylist] });
    expect(listUserPlaylists).toHaveBeenCalledWith("user-1");
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await listUserPlaylistsAction();

    expect(result.ok).toBe(false);
    expect(listUserPlaylists).not.toHaveBeenCalled();
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(listUserPlaylists).mockRejectedValue(new Error("DB error"));

    const result = await listUserPlaylistsAction();

    expect(result.ok).toBe(false);
  });
});