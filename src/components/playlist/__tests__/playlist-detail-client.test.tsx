// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PlaylistDetailClient } from "@/components/playlist/playlist-detail-client";
import type { Playlist, Track } from "@/lib/domain";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  removeTrackFromPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/player/store", () => ({
  usePlayerStore: vi.fn().mockReturnValue({
    queue: [],
    playCollection: vi.fn(),
  }),
}));

import { removeTrackFromPlaylistAction } from "@/app/actions/playlist";
import { usePlayerStore } from "@/lib/player/store";

const mockPlaylist: Playlist = {
  id: "pl1",
  ownerId: "user-1",
  title: "My Playlist",
  description: "A great mix",
  items: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockTracks: Track[] = [
  { id: "t1", provider: "jamendo", title: "Track 1", artistId: "a1", artistName: "Artist 1" },
  { id: "t2", provider: "jamendo", title: "Track 2", artistId: "a2", artistName: "Artist 2" },
  { id: "t3", provider: "jamendo", title: "Track 3", artistId: "a3", artistName: "Artist 3" },
];

describe("PlaylistDetailClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePlayerStore).mockReturnValue({
      queue: [],
      playCollection: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders playlist title and description", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getByText("My Playlist")).toBeTruthy();
    expect(screen.getByText("A great mix")).toBeTruthy();
  });

  it("shows track count", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getByText(/3 tracks/)).toBeTruthy();
  });

  it("renders tracks when playlist has tracks", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getByText("Track 1")).toBeTruthy();
    expect(screen.getByText("Track 2")).toBeTruthy();
    expect(screen.getByText("Track 3")).toBeTruthy();
  });

  it("shows empty state when playlist has no tracks", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={[]} isOwner={true} />,
    );

    expect(screen.getByText("This playlist is empty")).toBeTruthy();
    expect(screen.getByText("Search for music and add tracks to get started.")).toBeTruthy();
  });

  it("shows owner controls when isOwner is true", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getByRole("button", { name: "Rename playlist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete playlist" })).toBeTruthy();
  });

  it("hides owner controls when isOwner is false", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={false} />,
    );

    expect(screen.queryByRole("button", { name: "Rename playlist" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete playlist" })).toBeNull();
  });

  it("shows track numbers for non-owners", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={false} />,
    );

    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows reorder buttons for owners", () => {
    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getAllByRole("button", { name: "Move track up" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Move track down" })).toHaveLength(3);
  });

  it("removes track from playlist on remove action", async () => {
    vi.mocked(removeTrackFromPlaylistAction).mockResolvedValue({ ok: true });

    render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    expect(screen.getByText("Track 1")).toBeTruthy();
  });

  it("adopts refreshed server props so completed reorders become visible", () => {
    const { rerender } = render(
      <PlaylistDetailClient playlist={mockPlaylist} tracks={mockTracks} isOwner={true} />,
    );

    const before = document.querySelector("main") ?? document.body;
    expect(before.innerHTML.indexOf("Track 1")).toBeLessThan(
      before.innerHTML.indexOf("Track 3"),
    );

    rerender(
      <PlaylistDetailClient
        playlist={mockPlaylist}
        tracks={[mockTracks[2], mockTracks[1], mockTracks[0]]}
        isOwner={true}
      />,
    );

    const after = document.querySelector("main") ?? document.body;
    expect(after.innerHTML.indexOf("Track 3")).toBeLessThan(
      after.innerHTML.indexOf("Track 1"),
    );
  });
});