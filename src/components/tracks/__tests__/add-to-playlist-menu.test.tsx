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

    expect(screen.getByRole("menu", { name: "Thêm vào playlist" })).toBeTruthy();
    expect(screen.getByText("Đang tải playlist...")).toBeTruthy();
  });

  it("loads and displays playlists", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [
        { id: "pl1", ownerId: "user-1", title: "Playlist 1", visibility: "private" as const, items: [] },
        { id: "pl2", ownerId: "user-1", title: "Playlist 2", visibility: "private" as const, items: [{ id: "pi1", trackId: "t1", provider: "jamendo" }] },
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
      expect(screen.getByText("Không tải được playlist")).toBeTruthy();
    });
  });

  /**
   * Phase 49 regression. A server action's body try/catches and resolves
   * `{ok:false}`, but the transport rejects on a network drop. The rejection
   * skipped `setLoading(false)`, so the menu rendered "Đang tải playlist…"
   * forever — and because `loading` is tested before `error`, the Retry
   * button could never render, leaving no escape without a full reload.
   */
  it("recovers when the load request rejects instead of hanging", async () => {
    vi.mocked(listUserPlaylistsAction).mockRejectedValue(new Error("network down"));

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    // Leaves the loading branch and reports the curated error.
    await waitFor(() => {
      expect(screen.getByText("Không tải được playlist")).toBeTruthy();
    });
    expect(screen.queryByText(/Đang tải playlist/)).toBeNull();
    // ...and the Retry escape hatch is reachable again.
    expect(screen.getByRole("button", { name: /Thử lại|Retry/i })).toBeTruthy();
  });

  /**
   * Phase 49 regression. `pendingRef`/`setPendingId(null)` sat after the
   * awaits, so a rejection left the row permanently disabled with no error.
   */
  it("releases the in-flight guard when adding rejects", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [
        { id: "pl1", ownerId: "user-1", title: "Playlist 1", visibility: "private" as const, items: [] },
      ],
    });
    vi.mocked(addTrackToPlaylistAction).mockRejectedValue(new Error("network down"));

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    const row = await waitFor(() => screen.getByText("Playlist 1"));
    fireEvent.click(row);

    // The regression: before the fix the rejection skipped every statement
    // after the await, so no error was ever surfaced and `pendingRef` stayed
    // set - leaving the row permanently disabled with no way out.
    await waitFor(() => {
      expect(screen.getByText("Không thêm được bài hát")).toBeTruthy();
    });

    // Nothing is left stuck disabled: the recovery action is live.
    const retry = screen.getByRole("button", { name: "Thử lại" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  it("adds track to playlist on click", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [{ id: "pl1", ownerId: "user-1", title: "Playlist 1", visibility: "private" as const, items: [] }],
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
      playlists: [{ id: "pl1", ownerId: "user-1", title: "Playlist 1", visibility: "private" as const, items: [] }],
    });
    vi.mocked(addTrackToPlaylistAction).mockResolvedValue({ ok: false, error: "Track already in playlist" });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Playlist 1")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Playlist 1").closest("[role='menuitem']")!);

    await waitFor(() => {
      expect(screen.getByText("Không thêm được bài hát")).toBeTruthy();
    });
  });

  it("shows create new playlist option", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [],
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Tạo playlist mới" })).toBeTruthy();
    });
  });

  it("shows empty state when no playlists exist", async () => {
    vi.mocked(listUserPlaylistsAction).mockResolvedValue({
      ok: true,
      playlists: [],
    });

    render(<AddToPlaylistMenu track={mockTrack} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Chưa có playlist nào. Hãy tạo một playlist để thêm bài hát.")).toBeTruthy();
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