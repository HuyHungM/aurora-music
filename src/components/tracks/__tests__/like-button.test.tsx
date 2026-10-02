// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LikeButton } from "@/components/tracks/like-button";
import { AUTH_REQUIRED_EVENT } from "@/components/tracks/liked-tracks";
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

describe("LikeButton standalone anonymous UX", () => {
  // The standalone path (no LikedTracksProvider: unit tests, isolated
  // surfaces) has only the `isAuthenticated` prop to tell it whether a failed
  // mutation is an authorization failure. Without the prop an anonymous tap
  // rolled back silently with no explanation.
  it("raises the shared sign-in prompt when an anonymous like fails", async () => {
    const { likeTrackAction } = await import("@/app/actions/track");
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(
        <LikeButton track={makeTrack()} initialLiked={false} isAuthenticated={false} />,
      );
      await user.click(screen.getByRole("button", { name: "Thích Test Track" }));
      // Rolled back: still shows Like, and the prompt was requested.
      expect(
        await screen.findByRole("button", { name: "Thích Test Track" }),
      ).toBeTruthy();
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });

  it("stays silent for authenticated failures (no false sign-in prompt)", async () => {
    const { likeTrackAction } = await import("@/app/actions/track");
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const listener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(
        <LikeButton track={makeTrack()} initialLiked={false} isAuthenticated={true} />,
      );
      await user.click(screen.getByRole("button", { name: "Thích Test Track" }));
      // Rolled back, but an authenticated failure is transient, not an
      // authorization failure: no prompt.
      expect(
        await screen.findByRole("button", { name: "Thích Test Track" }),
      ).toBeTruthy();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });

  it("keeps silent rollback when the prop is omitted", async () => {
    // Backward compatibility pin: the standalone unit-test path renders
    // without auth plumbing, and omitting the prop must not start prompting.
    const { likeTrackAction } = await import("@/app/actions/track");
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const listener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(<LikeButton track={makeTrack()} initialLiked={false} />);
      await user.click(screen.getByRole("button", { name: "Thích Test Track" }));
      expect(
        await screen.findByRole("button", { name: "Thích Test Track" }),
      ).toBeTruthy();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });
});
