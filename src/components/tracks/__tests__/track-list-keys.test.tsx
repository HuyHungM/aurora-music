// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrackList, catalogTrackKey } from "@/components/tracks/track-list";
import type { Track } from "@/lib/domain";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

function makeTrack(id: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
    ...extra,
  };
}

afterEach(() => {
  cleanup();
});

describe("TrackList React identity (Phase 36)", () => {
  it("uses canonical provider:id keys for unique catalog tracks", () => {
    expect(catalogTrackKey(makeTrack("Xk9kczrs8I0"))).toBe("youtube:Xk9kczrs8I0");
  });

  it("never emits duplicate keys when a provider repeats a video in one list", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      // The reported warning: youtube:Xk9kczrs8I0 rendered twice in one
      // collection (raw provider duplicate). Keys must stay unique while
      // the canonical identity stays first.
      const tracks = [makeTrack("Xk9kczrs8I0"), makeTrack("Xk9kczrs8I0")];
      const { container } = render(<TrackList tracks={tracks} />);
      const items = container.querySelectorAll("ul > li");
      expect(items).toHaveLength(2);
      expect(
        errors.some((message) => message.includes("Encountered two children with the same key")),
      ).toBe(false);
    } finally {
      console.error = origError;
    }
  });

  it("honors occurrence keys (like.id / history id) over canonical identity", () => {
    const tracks = [makeTrack("same"), makeTrack("same")];
    const { container } = render(
      <TrackList tracks={tracks} getKey={(_track, index) => `like-${index}`} />,
    );
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
  });
});
