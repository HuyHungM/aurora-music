import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";

/**
 * M3-03: the like path wrote a fully unvalidated client `Track` into the
 * catalog every user reads.
 *
 * `upsertTrack` takes `title`, `artistName`, `albumName`, `artworkUrl`,
 * `providerUrl` and `genres` straight from the payload, and before this change
 * `likeTrackAction` passed the argument through with no parse at all — so any
 * signed-in caller could write an arbitrarily long display string that every
 * other user's library, playlist and search result then renders. The playlist
 * add path already parsed; these cases pin that the like path now honours the
 * SAME contract, and that what reaches the DAL is the parsed value rather than
 * the caller's object.
 */
vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
  getSessionUserId: vi.fn(),
}));

vi.mock("@/lib/dal/like", () => ({
  likeTrack: vi.fn(),
  unlikeTrack: vi.fn(),
  isTrackLiked: vi.fn(),
}));

import { requireUser } from "@/lib/dal/session";
import { likeTrack, unlikeTrack } from "@/lib/dal/like";
import { likeTrackAction, unlikeTrackAction } from "../track";

const mockUser = { id: "user-1" } as never;

const validTrack: Track = {
  id: "abc123",
  provider: "youtube",
  providerTrackId: "abc123",
  title: "Test Track",
  artistId: "artist-1",
  artistName: "Test Artist",
  albumId: "album-1",
  albumName: "Test Album",
  duration: 180,
  genres: ["pop"],
  explicit: false,
};

/** A structurally valid track with one field replaced. */
function withField(field: string, value: unknown): Track {
  return { ...validTrack, [field]: value } as Track;
}

describe("likeTrackAction write-path validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(likeTrack).mockResolvedValue(undefined as never);
  });

  it("writes a valid track", async () => {
    await expect(likeTrackAction(validTrack)).resolves.toEqual({
      ok: true,
      liked: true,
    });
    expect(likeTrack).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbounded title instead of writing it to the shared catalog", async () => {
    const result = await likeTrackAction(
      withField("title", "x".repeat(5001)),
    );
    expect(result).toEqual({ ok: false, liked: false });
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("rejects an unbounded artist name", async () => {
    const result = await likeTrackAction(
      withField("artistName", "y".repeat(5001)),
    );
    expect(result.ok).toBe(false);
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("rejects an empty title, which normalizeTrack already refuses to produce", async () => {
    const result = await likeTrackAction(withField("title", "   "));
    expect(result.ok).toBe(false);
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("rejects a non-finite duration", async () => {
    const result = await likeTrackAction(withField("duration", Number.NaN));
    expect(result.ok).toBe(false);
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("rejects an oversized genre list", async () => {
    const result = await likeTrackAction(
      withField("genres", Array.from({ length: 21 }, (_, i) => `g${i}`)),
    );
    expect(result.ok).toBe(false);
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("rejects a missing identity field", async () => {
    const result = await likeTrackAction({ ...validTrack, artistId: "" } as Track);
    expect(result.ok).toBe(false);
    expect(likeTrack).not.toHaveBeenCalled();
  });

  it("strips streamUrl, previewUrl and metadata before the DAL sees them", async () => {
    // The DAL omits these too; the schema makes the payload incapable of
    // carrying them, so neither layer has to be the only thing standing
    // between a client and a media URL in a shared row.
    const hostile = {
      ...validTrack,
      streamUrl: "https://cdn.example/stream.m3u8",
      previewUrl: "https://cdn.example/preview.mp3",
      metadata: { injected: true },
    } as Track;
    await expect(likeTrackAction(hostile)).resolves.toEqual({
      ok: true,
      liked: true,
    });
    const written = vi.mocked(likeTrack).mock.calls[0]?.[1] as Track;
    expect(written).not.toHaveProperty("streamUrl");
    expect(written).not.toHaveProperty("previewUrl");
    expect(written).not.toHaveProperty("metadata");
  });

  it("passes the parsed value, not the caller's object", async () => {
    const padded = { ...validTrack, title: "  Padded Title  " };
    await likeTrackAction(padded as Track);
    const written = vi.mocked(likeTrack).mock.calls[0]?.[1] as Track;
    expect(written).not.toBe(padded);
    expect(written.title).toBe("Padded Title");
  });
});

describe("unlikeTrackAction ref validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(mockUser);
    vi.mocked(unlikeTrack).mockResolvedValue(undefined as never);
  });

  it("unlikes using providerTrackId when present", async () => {
    await expect(unlikeTrackAction(validTrack)).resolves.toEqual({
      ok: true,
      liked: false,
    });
    expect(unlikeTrack).toHaveBeenCalledWith("user-1", {
      provider: "youtube",
      providerTrackId: "abc123",
    });
  });

  it("falls back to id when providerTrackId is absent", async () => {
    const { providerTrackId: _omitted, ...withoutRef } = validTrack;
    await unlikeTrackAction(withoutRef as Track);
    expect(unlikeTrack).toHaveBeenCalledWith("user-1", {
      provider: "youtube",
      providerTrackId: "abc123",
    });
  });

  it("refuses an empty ref rather than unliking an arbitrary row", async () => {
    // No `providerTrackId`, so the action falls back to `id` - the value the
    // catalog upsert keys on. An empty one must be refused, not turned into a
    // delete of whatever row carries an empty provider id.
    const result = await unlikeTrackAction({
      ...validTrack,
      id: "  ",
      providerTrackId: undefined,
    } as Track);
    expect(result).toEqual({ ok: false, liked: false });
    expect(unlikeTrack).not.toHaveBeenCalled();
  });

  it("refuses an unbounded provider", async () => {
    const result = await unlikeTrackAction(
      withField("provider", "p".repeat(500)),
    );
    expect(result.ok).toBe(false);
    expect(unlikeTrack).not.toHaveBeenCalled();
  });
});
