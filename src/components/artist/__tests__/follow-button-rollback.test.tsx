// @vitest-environment jsdom
/**
 * Optimistic-mutation rollback on a REJECTED action.
 *
 * `followArtistAction` and `unfollowArtistAction` catch internally and return
 * `{ ok: false }`, so `{ ok: false }` was handled. A REJECTED action — a
 * transport drop, a navigation abort — never reaches that branch at all: the
 * `await` throws, the transition function exits, and neither the rollback nor
 * the toast ever ran. The button kept the optimistic state permanently, so it
 * claimed a follow the database did not have, with no explanation.
 *
 * The sibling shared like path (`liked-tracks.tsx`) has always had this catch.
 * These two did not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { FollowButton } from "@/components/artist/follow-button";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { useNotifications, clearNotifications } from "@/components/ui/notifications";

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  unfollow: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/actions/artist", () => ({
  followArtistAction: mocks.follow,
  unfollowArtistAction: mocks.unfollow,
}));

const ARTIST = { id: "a1", provider: "youtube", name: "Rick Astley" } as const;

function renderButton(initialFollowing: boolean) {
  return render(
    <LocaleProvider initialLocale="en">
      <FollowButton
        artist={ARTIST}
        initialFollowing={initialFollowing}
        isAuthenticated={true}
      />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  clearNotifications();
  mocks.follow.mockReset();
  mocks.unfollow.mockReset();
});

describe("FollowButton rollback", () => {
  it("restores the previous state when the action rejects", async () => {
    mocks.follow.mockRejectedValue(new Error("network down"));
    renderButton(false);

    act(() => {
      screen.getByRole("button").click();
    });

    await waitFor(() => expect(mocks.follow).toHaveBeenCalledTimes(1));
    // Back to "not following": the optimistic flip is not a claim the DB never
    // agreed to.
    await waitFor(() =>
      expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false"),
    );
  });

  it("restores to following when an unfollow rejects", async () => {
    mocks.unfollow.mockRejectedValue(new Error("network down"));
    renderButton(true);

    act(() => {
      screen.getByRole("button").click();
    });

    await waitFor(() => expect(mocks.unfollow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("rolls back and reports when the action returns ok:false", async () => {
    mocks.follow.mockResolvedValue({ ok: false, following: false });
    renderButton(false);

    act(() => {
      screen.getByRole("button").click();
    });

    await waitFor(() =>
      expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false"),
    );
    // Asserted on the store rather than on rendered copy: this suite mounts no
    // `NotificationHost`, and what matters here is that a failure is REPORTED —
    // a signed-in user gets the failure notice, not the sign-in prompt.
    await waitFor(() => {
      const items = useNotifications.getState().items;
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("error");
    });
  });
});