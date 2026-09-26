// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddToPlaylistMenu } from "@/components/tracks/add-to-playlist-menu";
import type { Playlist, Track } from "@/lib/domain";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new-pl" }),
}));

import { listUserPlaylistsAction, addTrackToPlaylistAction } from "@/app/actions/playlist";

const mockTrack: Track = {
  id: "track-1",
  provider: "jamendo",
  providerTrackId: "track-1",
  title: "Test Track",
  artistId: "artist-1",
  artistName: "Test Artist",
};

function makePlaylist(id: string, title: string, trackIds: string[] = []): Playlist {
  return {
    id,
    ownerId: "user-1",
    title,
    items: trackIds.map((trackId, i) => ({
      id: `pi-${id}-${i}`,
      trackId,
      provider: "jamendo",
    })),
  } as Playlist;
}

describe("AddToPlaylistMenu membership + hardening (Phase 39)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("marks playlists already containing the track (non-destructive)", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [
        makePlaylist("pl1", "Favorites Mix", ["track-1"]),
        makePlaylist("pl2", "Chill", []),
      ],
    });
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    const added = await screen.findByRole("menuitem", {
      name: "Favorites Mix, đã có trong playlist",
    });
    expect(added).toHaveProperty("disabled", true);
    expect(screen.getByText("Đã thêm")).toBeTruthy();
    // Untouched playlists stay actionable.
    expect(
      screen.getByRole("menuitem", { name: "Thêm vào Chill" }),
    ).toHaveProperty("disabled", false);
  });

  it("does not match membership across providers", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [makePlaylist("pl1", "Mixed", ["track-1"])],
    });
    const otherProviderTrack: Track = { ...mockTrack, provider: "youtube" };
    render(<AddToPlaylistMenu track={otherProviderTrack} onClose={vi.fn()} />);

    expect(
      await screen.findByRole("menuitem", { name: "Thêm vào Mixed" }),
    ).toBeTruthy();
  });

  it("refreshes membership on an authoritative conflict instead of erroring", async () => {
    vi.mocked(listUserPlaylistsAction)
      .mockResolvedValueOnce({
        ok: true,
        playlists: [makePlaylist("pl1", "Chill", [])],
      })
      .mockResolvedValueOnce({
        ok: true,
        playlists: [makePlaylist("pl1", "Chill", ["track-1"])],
      });
    vi.mocked(addTrackToPlaylistAction).mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: "Already in playlist",
    });
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Thêm vào Chill" }));
    expect(
      await screen.findByRole("menuitem", { name: "Chill, đã có trong playlist" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Đã có trong playlist");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables the row while an add is pending (no double-submit)", async () => {
    let release!: (value: { ok: boolean }) => void;
    const gate = new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    });
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [makePlaylist("pl1", "Chill", [])],
    });
    vi.mocked(addTrackToPlaylistAction).mockReturnValueOnce(gate);
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    const row = await screen.findByRole("menuitem", { name: "Thêm vào Chill" });
    fireEvent.click(row);
    fireEvent.click(row);
    await waitFor(() => expect(addTrackToPlaylistAction).toHaveBeenCalledTimes(1));
    release({ ok: true });
  });

  it("shows playlist search only above the threshold", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      makePlaylist(`pl${i}`, `Playlist ${i}`),
    );
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({ ok: true, playlists: many });
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Tìm playlist")).toBeTruthy();

    cleanup();
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: many.slice(0, 2),
    });
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);
    await screen.findByText("Playlist 0");
    expect(screen.queryByLabelText("Tìm playlist")).toBeNull();
  });

  it("filters playlists by the search query", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      makePlaylist(`pl${i}`, `Playlist ${i}`),
    );
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({ ok: true, playlists: many });
    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    const search = await screen.findByLabelText("Tìm playlist");
    fireEvent.change(search, { target: { value: "playlist 1" } });
    expect(screen.queryByText("Playlist 0")).toBeNull();
    expect(screen.getByText("Playlist 1")).toBeTruthy();
  });
});
