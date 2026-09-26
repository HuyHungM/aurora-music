// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { FollowButton } from "@/components/artist/follow-button";
import { AUTH_REQUIRED_EVENT } from "@/components/tracks/liked-tracks";
import type { Artist } from "@/lib/domain";

vi.mock("@/app/actions/artist", () => ({
  followArtistAction: vi.fn(async () => ({ ok: false })),
  unfollowArtistAction: vi.fn(async () => ({ ok: true })),
}));

// liked-tracks pulls the track actions transitively; keep the suite hermetic.
vi.mock("@/app/actions/track", () => ({
  likeTrackAction: vi.fn(async () => ({ ok: true, liked: true })),
  unlikeTrackAction: vi.fn(async () => ({ ok: true, liked: false })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeArtist(): Artist {
  return {
    id: "a1",
    provider: "mock",
    providerArtistId: "mock-a1",
    name: "Test Artist",
  };
}

describe("FollowButton anonymous UX", () => {
  it("raises the shared sign-in prompt when an anonymous follow fails", async () => {
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(
        <FollowButton artist={makeArtist()} initialFollowing={false} isAuthenticated={false} />,
      );
      await user.click(screen.getByRole("button", { name: "Theo dõi Test Artist" }));
      // Rolled back: still shows Follow, and the prompt was requested.
      expect(
        await screen.findByRole("button", { name: "Theo dõi Test Artist" }),
      ).toBeTruthy();
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });
});
