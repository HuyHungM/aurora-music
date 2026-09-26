// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlaylistActions, PlaylistTrackActions } from "@/components/playlist/playlist-actions";
import type { Playlist, Track } from "@/lib/domain";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  updatePlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  deletePlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  reorderPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
}));

import { updatePlaylistAction, deletePlaylistAction, reorderPlaylistAction } from "@/app/actions/playlist";
import { useRouter } from "next/navigation";

const mockPlaylist: Playlist = {
  id: "pl1",
  ownerId: "user-1",
  title: "My Playlist",
  description: "A great mix",
  visibility: "private" as const,
  items: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockTracks: Track[] = [
  { id: "t1", provider: "jamendo", title: "Track 1", artistId: "a1", artistName: "Artist 1" },
  { id: "t2", provider: "jamendo", title: "Track 2", artistId: "a2", artistName: "Artist 2" },
  { id: "t3", provider: "jamendo", title: "Track 3", artistId: "a3", artistName: "Artist 3" },
];

describe("PlaylistActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders rename and delete buttons", () => {
    render(<PlaylistActions playlist={mockPlaylist} />);

    expect(screen.getByRole("button", { name: "Đổi tên playlist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Xóa playlist" })).toBeTruthy();
  });

  it("opens rename dialog when rename is clicked", async () => {
    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Đổi tên playlist" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Đổi tên playlist" })).toBeTruthy();
    });
  });

  it("opens delete dialog when delete is clicked", async () => {
    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Xóa playlist" }));

    await waitFor(() => {
      expect(screen.getByText("Xóa playlist")).toBeTruthy();
      expect(screen.getByText(/Bạn có chắc muốn xóa/)).toBeTruthy();
    });
  });

  it("renames playlist on success", async () => {
    vi.mocked(updatePlaylistAction).mockResolvedValue({ ok: true });

    render(<PlaylistActions playlist={mockPlaylist} onPlaylistUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Đổi tên playlist" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Đổi tên playlist" })).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Tên"), { target: { value: "Updated Playlist" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", {
        title: "Updated Playlist",
        description: "A great mix",
      });
    });
  });

  it("deletes playlist and navigates to library", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    vi.mocked(deletePlaylistAction).mockResolvedValue({ ok: true });

    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Xóa playlist" }));
    await waitFor(() => {
      expect(screen.getByText("Xóa playlist")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));

    await waitFor(() => {
      expect(deletePlaylistAction).toHaveBeenCalledWith("pl1");
      expect(push).toHaveBeenCalledWith("/library");
    });
  });

  it("closes rename dialog on cancel", async () => {
    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Đổi tên playlist" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Đổi tên playlist" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hủy" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Đổi tên playlist" })).toBeNull();
    });
  });

  it("closes delete dialog on cancel", async () => {
    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Xóa playlist" }));
    await waitFor(() => {
      expect(screen.getByText("Xóa playlist")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hủy" }));

    await waitFor(() => {
      expect(screen.queryByText("Xóa playlist")).toBeNull();
    });
  });

  it("shows error when rename fails", async () => {
    vi.mocked(updatePlaylistAction).mockResolvedValue({ ok: false, error: "Failed to update" });

    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Đổi tên playlist" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Đổi tên playlist" })).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Tên"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() => {
      expect(screen.getByText("Không cập nhật được playlist")).toBeTruthy();
    });
  });

  it("shows error when delete fails", async () => {
    vi.mocked(deletePlaylistAction).mockResolvedValue({ ok: false, error: "Failed to delete" });

    render(<PlaylistActions playlist={mockPlaylist} />);

    fireEvent.click(screen.getByRole("button", { name: "Xóa playlist" }));
    await waitFor(() => {
      expect(screen.getByText("Xóa playlist")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));

    await waitFor(() => {
      expect(screen.getByText("Không xóa được playlist")).toBeTruthy();
    });
  });
});

describe("PlaylistTrackActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders move up and move down buttons", () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={1} />);

    expect(screen.getByRole("button", { name: "Chuyển bài lên" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển bài xuống" })).toBeTruthy();
  });

  it("disables move up for first track", () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={0} />);

    expect(screen.getByRole("button", { name: "Chuyển bài lên" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Chuyển bài xuống" })).toHaveProperty("disabled", false);
  });

  it("disables move down for last track", () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={2} />);

    expect(screen.getByRole("button", { name: "Chuyển bài lên" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Chuyển bài xuống" })).toHaveProperty("disabled", true);
  });

  it("enables both buttons for middle track", () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={1} />);

    expect(screen.getByRole("button", { name: "Chuyển bài lên" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Chuyển bài xuống" })).toHaveProperty("disabled", false);
  });

  it("calls reorder action on move up", async () => {
    vi.mocked(reorderPlaylistAction).mockResolvedValue({ ok: true });

    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={1} />);

    fireEvent.click(screen.getByRole("button", { name: "Chuyển bài lên" }));

    await waitFor(() => {
      expect(reorderPlaylistAction).toHaveBeenCalled();
    });
  });

  it("calls reorder action on move down", async () => {
    vi.mocked(reorderPlaylistAction).mockResolvedValue({ ok: true });

    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={1} />);

    fireEvent.click(screen.getByRole("button", { name: "Chuyển bài xuống" }));

    await waitFor(() => {
      expect(reorderPlaylistAction).toHaveBeenCalled();
    });
  });

  it("does not call reorder action when move up is disabled", async () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={0} />);

    fireEvent.click(screen.getByRole("button", { name: "Chuyển bài lên" }));

    expect(reorderPlaylistAction).not.toHaveBeenCalled();
  });

  it("does not call reorder action when move down is disabled", async () => {
    render(<PlaylistTrackActions playlistId="pl1" tracks={mockTracks} trackIndex={2} />);

    fireEvent.click(screen.getByRole("button", { name: "Chuyển bài xuống" }));

    expect(reorderPlaylistAction).not.toHaveBeenCalled();
  });
});