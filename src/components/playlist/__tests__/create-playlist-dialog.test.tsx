// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreatePlaylistDialog } from "@/components/playlist/create-playlist-dialog";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  createPlaylistAction: vi.fn(),
}));

import { createPlaylistAction } from "@/app/actions/playlist";
import { useRouter } from "next/navigation";

describe("CreatePlaylistDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders dialog with title and form fields", () => {
    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    expect(screen.getByText("Create playlist")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText(/Description/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(<CreatePlaylistDialog open={false} onClose={vi.fn()} />);

    expect(screen.queryByText("Create playlist")).toBeNull();
  });

  it("calls onClose when cancel is clicked", () => {
    const onClose = vi.fn();
    render(<CreatePlaylistDialog open={true} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows error for empty title on submit", async () => {
    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
    fireEvent.submit(screen.getByRole("button", { name: "Create" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText("Playlist name is required")).toBeTruthy();
    });
  });

  it("creates playlist and navigates on success", async () => {
    const onClose = vi.fn();
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);
    vi.mocked(createPlaylistAction).mockResolvedValue({ ok: true, playlistId: "pl1" });

    render(<CreatePlaylistDialog open={true} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Playlist" } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "A great mix" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createPlaylistAction).toHaveBeenCalledWith({
        title: "My Playlist",
        description: "A great mix",
      });
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledWith("/library/playlists/pl1");
    });
  });

  it("shows error when creation fails", async () => {
    vi.mocked(createPlaylistAction).mockResolvedValue({ ok: false, error: "Failed to create" });

    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Playlist" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to create")).toBeTruthy();
    });
  });

  it("disables submit button when title is empty", () => {
    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", true);
  });

  it("enables submit button when title is entered", () => {
    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Playlist" } });

    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", false);
  });

  it("trims title whitespace", async () => {
    vi.mocked(createPlaylistAction).mockResolvedValue({ ok: true, playlistId: "pl1" });

    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  My Playlist  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createPlaylistAction).toHaveBeenCalledWith({
        title: "My Playlist",
        description: undefined,
      });
    });
  });

  it("trims description whitespace", async () => {
    vi.mocked(createPlaylistAction).mockResolvedValue({ ok: true, playlistId: "pl1" });

    render(<CreatePlaylistDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Playlist" } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "  A great mix  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createPlaylistAction).toHaveBeenCalledWith({
        title: "My Playlist",
        description: "A great mix",
      });
    });
  });
});