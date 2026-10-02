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

  it("refuses an oversized client payload before it reaches the catalog", async () => {
    // The shared catalog row has no owner column, so this write is authorized
    // by nothing but validation. `title` is a Postgres `text`, so an unbounded
    // payload is a storage-amplification lever available to any authenticated
    // account, and it is rendered by every other user.
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);

    const result = await recordPlayedAction({
      ...mockTrack,
      title: "x".repeat(5_000),
    } as Track);

    expect(result).toEqual({ ok: false });
    expect(recordPlayed).not.toHaveBeenCalled();
  });

  it("strips the columns the catalog must never accept", async () => {
    // `streamUrl`, `previewUrl` and `metadata` are the fields the catalog
    // deliberately does not store. The schema drops unknown keys, so they
    // cannot ride along on a client payload into a shared row.
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);

    await recordPlayedAction({
      ...mockTrack,
      streamUrl: "https://attacker.example/x.mp3",
      previewUrl: "https://attacker.example/y.mp3",
      metadata: { sources: [{ provider: "forged", id: "x" }] },
    } as unknown as Track);

    const written = vi.mocked(recordPlayed).mock.calls[0]?.[1] as unknown as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty("streamUrl");
    expect(written).not.toHaveProperty("previewUrl");
    expect(written).not.toHaveProperty("metadata");
  });
});
