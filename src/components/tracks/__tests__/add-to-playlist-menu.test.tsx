// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddToPlaylistMenu } from "@/components/tracks/add-to-playlist-menu";
import type { Track } from "@/lib/domain";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
}));

import { listUserPlaylistsAction, addTrackToPlaylistAction } from "@/app/actions/playlist";

const mockTrack: Track = {
  id: "track-1",
  provider: "jamendo",
  title: "Test Track",
  artistId: "artist-1",
  artistName: "Test Artist",
};

describe("AddToPlaylistMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders menu with loading state", () => {
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    expect(screen.getByRole("menu", { name: "Add to playlist" })).toBeTruthy();
    expect(screen.getByText("Loading playlists...")).toBeTruthy();
  });

  it("loads and displays playlists", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [
        { id: "pl1", ownerId: "user-1", title: "Playlist 1", items: [] },
        { id: "pl2", ownerId: "user-1", title: "Playlist 2", items: [{ id: "pi1", trackId: "t1", provider: "jamendo" }] },
      ],
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Playlist 1")).toBeTruthy();
      expect(screen.getByText("Playlist 2")).toBeTruthy();
    });
  });

  it("shows error when loading fails", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: false,
      error: "Failed to load playlists",
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load playlists")).toBeTruthy();
    });
  });

  it("adds track to playlist on click", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [{ id: "pl1", ownerId: "user-1", title: "Playlist 1", items: [] }],
    });
    vi.mocked(addTrackToPlaylistAction).mockResolvedValue({ ok: true });

    const onClose = vi.fn();
    render(<AddToPlaylistMenu track={mockTrack} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("Playlist 1")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Playlist 1").closest("[role='menuitem']")!);

    await waitFor(() => {
      expect(addTrackToPlaylistAction).toHaveBeenCalledWith("pl1", mockTrack);
    });
  });

  it("shows error when adding track fails", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [{ id: "pl1", ownerId: "user-1", title: "Playlist 1", items: [] }],
    });
    vi.mocked(addTrackToPlaylistAction).mockResolvedValue({ ok: false, error: "Track already in playlist" });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Playlist 1")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Playlist 1").closest("[role='menuitem']")!);

    await waitFor(() => {
      expect(screen.getByText("Track already in playlist")).toBeTruthy();
    });
  });

  it("shows create new playlist option", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [],
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Create new playlist" })).toBeTruthy();
    });
  });

  it("shows empty state when no playlists exist", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [],
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No playlists yet. Create one to add tracks.")).toBeTruthy();
    });
  });

  it("closes on escape key", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [],
    });

    const onClose = vi.fn();
    render(<AddToPlaylistMenu track={mockTrack} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});