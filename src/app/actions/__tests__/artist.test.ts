import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artist } from "@/lib/domain";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/dal/follow", () => ({
  followArtist: vi.fn(),
  unfollowArtist: vi.fn(),
}));

import { requireUser } from "@/lib/dal/session";
import { followArtist, unfollowArtist } from "@/lib/dal/follow";
import { followArtistAction, unfollowArtistAction } from "../artist";

const mockArtist: Artist = {
  id: "artist-1",
  provider: "spotify",
  providerArtistId: "artist-1",
  name: "Test Artist",
  image: "https://example.com/a.jpg",
  genres: ["pop"],
} as unknown as Artist;

describe("followArtistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
  });

  it("follows for an authenticated user", async () => {
    vi.mocked(followArtist).mockResolvedValue(undefined);

    const result = await followArtistAction(mockArtist);

    expect(result).toEqual({ ok: true, following: true });
    expect(followArtist).toHaveBeenCalledWith("user-1", expect.objectContaining({
      provider: "spotify",
      name: "Test Artist",
    }));
  });

  it("refuses an oversized artist payload before it reaches the catalog", async () => {
    // `Artist` is a shared, unowned row: `upsertArtist` writes `name`, `bio`,
    // `image` and `genres` straight from this client payload, and those columns
    // are unbounded Postgres `text`. There was no artist-side schema at all.
    const result = await followArtistAction({
      ...mockArtist,
      bio: "x".repeat(20_000),
    } as Artist);

    expect(result).toEqual({ ok: false, following: false });
    expect(followArtist).not.toHaveBeenCalled();
  });

  it("refuses a nameless artist", async () => {
    const result = await followArtistAction({ ...mockArtist, name: "" } as Artist);

    expect(result).toEqual({ ok: false, following: false });
    expect(followArtist).not.toHaveBeenCalled();
  });

  it("reports not-following when the write fails", async () => {
    vi.mocked(followArtist).mockRejectedValue(new Error("DB error"));

    expect(await followArtistAction(mockArtist)).toEqual({
      ok: false,
      following: false,
    });
  });

  it("fails closed for an unauthenticated caller without touching the DAL", async () => {
    // UI hiding is not the authorization boundary: a logged-out user who
    // invokes the action directly (devtools, crafted request) must still be
    // refused, because `requireUser` throws before any write.
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    expect(await followArtistAction(mockArtist)).toEqual({
      ok: false,
      following: false,
    });
    expect(followArtist).not.toHaveBeenCalled();
  });
});

describe("unfollowArtistAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
  });

  it("unfollows and reports the resulting state", async () => {
    vi.mocked(unfollowArtist).mockResolvedValue(undefined);

    expect(await unfollowArtistAction(mockArtist)).toEqual({
      ok: true,
      following: false,
    });
    expect(unfollowArtist).toHaveBeenCalledWith("user-1", {
      provider: "spotify",
      providerArtistId: "artist-1",
    });
  });

  it("reports still-following when the unfollow fails", async () => {
    // The caller should be told the state it must DISPLAY. A failed unfollow
    // leaves the user following.
    vi.mocked(unfollowArtist).mockRejectedValue(new Error("DB error"));

    expect(await unfollowArtistAction(mockArtist)).toEqual({
      ok: false,
      following: true,
    });
  });

  it("fails closed for an unauthenticated caller without touching the DAL", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Not authenticated"));

    expect(await unfollowArtistAction(mockArtist)).toEqual({
      ok: false,
      following: true,
    });
    expect(unfollowArtist).not.toHaveBeenCalled();
  });
});