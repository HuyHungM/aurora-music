// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LikeButton } from "@/components/tracks/like-button";
import type { Track } from "@/lib/domain";

vi.mock("@/app/actions/track", () => ({
  likeTrackAction: vi.fn(async () => ({ ok: true, liked: true })),
  unlikeTrackAction: vi.fn(async () => ({ ok: true, liked: false })),
}));

afterEach(() => {
  cleanup();
});

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    provider: "mock",
    providerTrackId: "mock-t1",
    title: "Test Track",
    artistId: "a1",
    artistName: "Test Artist",
    ...overrides,
  };
}

describe("LikeButton", () => {
  it("renders like button with correct label when not liked", () => {
    render(<LikeButton track={makeTrack()} initialLiked={false} />);
    expect(screen.getByRole("button", { name: "Thích Test Track" })).toBeTruthy();
  });

  it("renders unlike button with correct label when liked", () => {
    render(<LikeButton track={makeTrack()} initialLiked={true} />);
    expect(screen.getByRole("button", { name: "Bỏ thích Test Track" })).toBeTruthy();
  });

  it("sets aria-pressed to true when liked", () => {
    render(<LikeButton track={makeTrack()} initialLiked={true} />);
    const button = screen.getByRole("button", { name: "Bỏ thích Test Track" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("sets aria-pressed to false when not liked", () => {
    render(<LikeButton track={makeTrack()} initialLiked={false} />);
    const button = screen.getByRole("button", { name: "Thích Test Track" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles liked state on click", async () => {
    const user = userEvent.setup();
    render(<LikeButton track={makeTrack()} initialLiked={false} />);
    
    await user.click(screen.getByRole("button", { name: "Thích Test Track" }));
    
    expect(screen.getByRole("button", { name: "Bỏ thích Test Track" })).toBeTruthy();
  });
});
