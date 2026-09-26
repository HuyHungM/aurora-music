// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { FollowButton } from "@/components/artist/follow-button";
import { followArtistAction, unfollowArtistAction } from "@/app/actions/artist";
import type { Artist } from "@/lib/domain";

vi.mock("@/app/actions/artist", () => ({
  followArtistAction: vi.fn(async () => ({ ok: true, following: true })),
  unfollowArtistAction: vi.fn(async () => ({ ok: true, following: false })),
}));

// liked-tracks pulls the track actions transitively; keep the suite hermetic.
vi.mock("@/app/actions/track", () => ({
  likeTrackAction: vi.fn(async () => ({ ok: true, liked: true })),
  unlikeTrackAction: vi.fn(async () => ({ ok: true, liked: false })),
}));

afterEach(() => {
  cleanup();
  vi.mocked(followArtistAction).mockClear();
  vi.mocked(unfollowArtistAction).mockClear();
});

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: "a1",
    provider: "mock",
    providerArtistId: "mock-a1",
    name: "Test Artist",
    ...overrides,
  };
}

describe("FollowButton", () => {
  it("renders follow button when not following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    expect(screen.getByRole("button", { name: "Theo dõi Test Artist" })).toBeTruthy();
  });

  it("renders following button when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    expect(screen.getByRole("button", { name: "Bỏ theo dõi Test Artist" })).toBeTruthy();
  });

  it("shows Follow text when not following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    expect(screen.getByText("Theo dõi")).toBeTruthy();
  });

  it("shows Following text when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    expect(screen.getByText("Đang theo dõi")).toBeTruthy();
  });

  it("sets aria-pressed to true when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    const button = screen.getByRole("button", { name: "Bỏ theo dõi Test Artist" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("sets aria-pressed to false when not following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    const button = screen.getByRole("button", { name: "Theo dõi Test Artist" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles following state on click", async () => {
    const user = userEvent.setup();
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    
    await user.click(screen.getByRole("button", { name: "Theo dõi Test Artist" }));
    
    expect(screen.getByRole("button", { name: "Bỏ theo dõi Test Artist" })).toBeTruthy();
  });

  it("re-syncs to the new artist when client-side navigation changes the prop", async () => {
    // Regression: client-side navigation between two artist routes reconciles
    // the same element in the same position, so React preserves this
    // component's state and only the props change. The button used to keep the
    // previous artist's follow state, and a click then sent the opposite
    // action for the artist now on screen.
    const user = userEvent.setup();
    const { rerender } = render(
      <FollowButton
        artist={makeArtist({ id: "a1", providerArtistId: "mock-a1", name: "Artist A" })}
        initialFollowing={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Theo dõi Artist A" })).toBeTruthy();

    rerender(
      <FollowButton
        artist={makeArtist({ id: "b2", providerArtistId: "mock-b2", name: "Artist B" })}
        initialFollowing={true}
      />,
    );

    const button = screen.getByRole("button", { name: "Bỏ theo dõi Artist B" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // Following B, so the click must unfollow B (not follow B, and certainly
    // not touch A).
    await user.click(button);
    expect(vi.mocked(unfollowArtistAction)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(followArtistAction)).not.toHaveBeenCalled();
  });
});
