// @vitest-environment jsdom
/**
 * A playlist removal that does not land must be REPORTED.
 *
 * `handleRemoveTrack` was `if (result.ok) { … }` with no `else`, and no
 * `catch`. So a rate limit, an authorization failure, or a rejected action left
 * the row exactly where it was with no toast, no inline error and no
 * re-render: the user clicked the bin and nothing at all happened. Every
 * sibling mutation on that page reports its failures, so this was the one
 * mutation that could fail silently.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlaylistDetailClient } from "@/components/playlist/playlist-detail-client";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import {
  clearNotifications,
  useNotifications,
} from "@/components/ui/notifications";
import type { Playlist, Track } from "@/lib/domain";

const mocks = vi.hoisted(() => ({
  removeTrackFromPlaylist: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/library/playlists/pl1",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/actions/playlist", () => ({
  removeTrackFromPlaylistAction: mocks.removeTrackFromPlaylist,
}));

const TRACK: Track = {
  id: "t1",
  provider: "youtube",
  providerTrackId: "t1",
  title: "Never Gonna Give You Up",
  artistId: "a1",
  artistName: "Rick Astley",
};

const PLAYLIST = {
  id: "pl1",
  ownerId: "user-1",
  title: "My Playlist",
  visibility: "private",
  items: [TRACK],
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Playlist;

function renderDetail() {
  return render(
    <LocaleProvider initialLocale="en">
      <PlaylistDetailClient
        playlist={PLAYLIST}
        tracks={[TRACK]}
        isOwner={true}
      />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  clearNotifications();
  mocks.removeTrackFromPlaylist.mockReset();
});

describe("playlist detail: a removal that does not land is reported", () => {
  it("posts an error when the action returns ok:false", async () => {
    mocks.removeTrackFromPlaylist.mockResolvedValue({ ok: false, error: "nope" });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(mocks.removeTrackFromPlaylist).toHaveBeenCalled());
    await waitFor(() => {
      const items = useNotifications.getState().items;
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("error");
      expect(items[0].message).toContain(TRACK.title);
    });
  });

  it("posts an error when the action REJECTS", async () => {
    // The other half: a rejected action never reaches `result.ok`, so the
    // original `if` was never even evaluated.
    mocks.removeTrackFromPlaylist.mockRejectedValue(new Error("network down"));
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(mocks.removeTrackFromPlaylist).toHaveBeenCalled());
    await waitFor(() => {
      expect(useNotifications.getState().items[0]?.kind).toBe("error");
    });
  });

  it("still confirms a successful removal, and reports no error", async () => {
    mocks.removeTrackFromPlaylist.mockResolvedValue({ ok: true });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(mocks.removeTrackFromPlaylist).toHaveBeenCalled());
    await waitFor(() => {
      const items = useNotifications.getState().items;
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("info");
    });
  });
});