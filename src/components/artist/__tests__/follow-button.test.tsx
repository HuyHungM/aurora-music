// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { FollowButton } from "@/components/artist/follow-button";
import type { Artist } from "@/lib/domain";

vi.mock("@/app/actions/artist", () => ({
  followArtistAction: vi.fn(async () => ({ ok: true, following: true })),
  unfollowArtistAction: vi.fn(async () => ({ ok: true, following: false })),
}));

afterEach(() => {
  cleanup();
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
    expect(screen.getByRole("button", { name: "Follow Test Artist" })).toBeTruthy();
  });

  it("renders following button when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    expect(screen.getByRole("button", { name: "Unfollow Test Artist" })).toBeTruthy();
  });

  it("shows Follow text when not following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    expect(screen.getByText("Follow")).toBeTruthy();
  });

  it("shows Following text when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    expect(screen.getByText("Following")).toBeTruthy();
  });

  it("sets aria-pressed to true when following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={true} />);
    const button = screen.getByRole("button", { name: "Unfollow Test Artist" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("sets aria-pressed to false when not following", () => {
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    const button = screen.getByRole("button", { name: "Follow Test Artist" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles following state on click", async () => {
    const user = userEvent.setup();
    render(<FollowButton artist={makeArtist()} initialFollowing={false} />);
    
    await user.click(screen.getByRole("button", { name: "Follow Test Artist" }));
    
    expect(screen.getByRole("button", { name: "Unfollow Test Artist" })).toBeTruthy();
  });
});
