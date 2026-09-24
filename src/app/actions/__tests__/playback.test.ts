import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/dal/recently-played", () => ({
  recordPlayed: vi.fn(),
}));

import { requireUser } from "@/lib/dal/session";
import { recordPlayed } from "@/lib/dal/recently-played";
import { recordPlayedAction } from "../playback";

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

describe("recordPlayedAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records play for authenticated user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(recordPlayed).mockResolvedValue(undefined);

    const result = await recordPlayedAction(mockTrack);

    expect(result).toEqual({ ok: true });
    expect(requireUser).toHaveBeenCalledOnce();
    expect(recordPlayed).toHaveBeenCalledWith("user-1", mockTrack);
  });

  it("returns ok:false when user is not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    const result = await recordPlayedAction(mockTrack);

    expect(result).toEqual({ ok: false });
    expect(recordPlayed).not.toHaveBeenCalled();
  });

  it("returns ok:false when DB fails", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(recordPlayed).mockRejectedValue(new Error("DB error"));

    const result = await recordPlayedAction(mockTrack);

    expect(result).toEqual({ ok: false });
  });
});
