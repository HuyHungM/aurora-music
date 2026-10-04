// @vitest-environment jsdom
/**
 * The player like button's accessible name must be localized.
 *
 * It was the only accessible name in a production component built from an
 * English template literal (`` `Like ${title}` ``), so a Vietnamese listener
 * heard English from the player while every sibling like control spoke the
 * active locale. A screen-reader user is the one user for whom an untranslated
 * control name is not merely cosmetic, and the name is the entire affordance:
 * the button shows only a heart.
 *
 * Rendered through a mocked engine so the test is about the LABEL, not about
 * the player.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { getT } from "@/lib/i18n/translate";
import { LikedTracksProvider, PlayerLikeButton, likedTrackKey } from "@/components/tracks/liked-tracks";
import { identityToTrack } from "@/lib/music/identity-track";

// `vi.mock` factories are hoisted above module-level `const`, so the fixture
// the mocked engine reads has to be hoisted with them. It is a full
// `TrackIdentity`, because `PlayerLikeButton` runs it through
// `identityToTrack`, which reads `artists[0]` and `primarySource`.
const TRACK = vi.hoisted(() => ({
  id: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  identity: {
    id: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    artists: [
      { id: "UC0", provider: "youtube", name: "Rick Astley" },
    ],
    sources: [
      { provider: "youtube", providerTrackId: "dQw4w9WgXcQ", kind: "track" },
    ],
    primarySource: {
      provider: "youtube",
      providerTrackId: "dQw4w9WgXcQ",
      kind: "track",
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/music/use-music-engine", () => ({
  useMusicEngine: () => null,
  useMusicEngineState: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentTrack: TRACK.identity,
      isPlaying: false,
      position: 0,
      queue: [],
      error: null,
    }),
}));

function renderButton(locale: "en" | "vi", liked: boolean) {
  // Seeded through the same key derivation the component uses, rather than a
  // hand-written string: `identityToTrack` decides whether `providerTrackId` or
  // `id` wins, and this test is about the label, not about that rule.
  const key = likedTrackKey(
    identityToTrack(TRACK.identity as unknown as Parameters<typeof identityToTrack>[0]),
  );
  return render(
    <LocaleProvider initialLocale={locale}>
      <LikedTracksProvider
        initialLiked={liked ? [key] : []}
        isAuthenticated={true}
      >
        <PlayerLikeButton />
      </LikedTracksProvider>
    </LocaleProvider>,
  );
}

afterEach(cleanup);

describe("PlayerLikeButton accessible name", () => {
  it("speaks the active locale rather than an English literal", () => {
    renderButton("vi", false);

    const label = screen.getByRole("button").getAttribute("aria-label");
    expect(label).toBe(getT("vi")("track.likeLabel", { title: TRACK.title }));
    // The regression itself: the old value was `Like <title>` in every locale.
    expect(label).not.toBe(`Like ${TRACK.title}`);
    expect(getT("vi")("track.likeLabel", { title: TRACK.title })).not.toBe(
      `Like ${TRACK.title}`,
    );
  });

  it("says Unlike when the track is already liked", () => {
    renderButton("en", true);

    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      getT("en")("track.unlikeLabel", { title: TRACK.title }),
    );
  });
});