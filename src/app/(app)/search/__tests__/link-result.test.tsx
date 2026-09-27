// @vitest-environment jsdom
/**
 * The link result surface (§10 of the feature report).
 *
 * What is being locked down here is that a pasted link is assembled from the
 * SAME parts the text search uses, and that the affordances behave the same
 * way: Play hands a `Track` to the engine, queueing goes through
 * `engine.queue.add` once per row, and whether Play is enabled at all is
 * still decided by `trackCapabilities`. Nothing in this file resolves a
 * stream — that is the controller's job at play time, and no playback URL
 * exists to hand over before then.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { track } from "@/lib/music/__tests__/fake-backend";
import { toTrackIdentity, type TrackIdentity } from "@/lib/domain";
import { enrichIdentity } from "@/lib/music/unified-search";
import { getT } from "@/lib/i18n/translate";
import type { SearchLinkResult } from "@/lib/search/resolve-link";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { LinkSearchResult } from "../link-result";

const mocks = vi.hoisted(() => ({
  playCollection: vi.fn(),
  queueAdd: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/search",
  useSearchParams: () => ({ get: () => null, has: () => false }),
}));

vi.mock("@/app/actions/locale", () => ({ setLocaleAction: vi.fn() }));

vi.mock("@/lib/music/instance", async () => {
  const { EMPTY_ENGINE_STATE } = await import("@/lib/music/music-engine");
  const engine = {
    getState: () => EMPTY_ENGINE_STATE,
    subscribe: () => () => {},
    playCollection: mocks.playCollection,
    queue: { add: mocks.queueAdd, playNext: vi.fn() },
    play: mocks.play,
    pause: mocks.pause,
  };
  return {
    getMusicEngine: () => engine,
    subscribeMusicEngine: () => () => {},
  };
});

// The component under test is wrapped in `LocaleProvider initialLocale="en"`
// (see `renderResult`), so expectations are read from the English dictionary.
const t = getT("en");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A single-source identity from one provider. */
function solo(provider: string, id: string, title: string): TrackIdentity {
  return toTrackIdentity(
    track(provider, { id, providerTrackId: id, title, duration: 200 }),
  );
}

/** A Spotify identity that already merged its YouTube equivalent. */
function matched(id: string, title: string): TrackIdentity {
  return enrichIdentity(solo("spotify", id, title), [
    solo("youtube", `yt-${id}`, title),
  ]);
}

function trackResult(
  resource: TrackIdentity,
  provider: Extract<SearchLinkResult, { kind: "track" }>["provider"] = "spotify",
): SearchLinkResult {
  return {
    kind: "track",
    provider,
    resourceKind: "track",
    id: resource.primarySource.id,
    track: resource,
    matched: resource.sources.length > 1,
  };
}

function collectionResult(
  tracks: TrackIdentity[],
  overrides: Partial<Extract<SearchLinkResult, { kind: "collection" }>> = {},
): SearchLinkResult {
  return {
    kind: "collection",
    provider: "spotify",
    resourceKind: "playlist",
    id: "PL1",
    title: "Aurora Mix",
    total: tracks.length,
    tracks,
    playable: 0,
    ...overrides,
  };
}

function renderResult(resource: SearchLinkResult) {
  return render(
    <LocaleProvider initialLocale="en">
      <LinkSearchResult resource={resource} />
    </LocaleProvider>,
  );
}

describe("LinkSearchResult: a resolved track", () => {
  it("labels the card with provider and resource type, not 'Top result'", () => {
    renderResult(trackResult(solo("spotify", "sp1", "Lạc Trôi")));
    const region = screen.getByRole("region", { name: "Detected link" });
    expect(within(region).getByText("Spotify · Track")).toBeTruthy();
    expect(within(region).getByText("Lạc Trôi")).toBeTruthy();
    // The default eyebrow must not leak into the link path.
    expect(within(region).queryByText(t("topResult.eyebrow"))).toBeNull();
  });

  it("exposes the track action menu beside Play", () => {
    renderResult(trackResult(matched("sp1", "Lạc Trôi")));
    expect(
      screen.getByRole("button", { name: t("menus.actionsFor", { title: "Lạc Trôi" }) }),
    ).toBeTruthy();
  });

  it("offers Play when the link resolved to an equivalent video", () => {
    renderResult(trackResult(matched("sp1", "Lạc Trôi")));
    const play = screen.getByRole("button", {
      name: t("track.playLabel", { title: "Lạc Trôi" }),
    });
    expect((play as HTMLButtonElement).disabled).toBe(false);
  });

  it("withholds Play when there is no playable source, without hiding the row", () => {
    // The catalog-only contract: a Spotify link with no YouTube equivalent is
    // still a real result (queue, like, add to playlist, details), it just
    // cannot be played. Disappearing it would be a lie about the outcome.
    renderResult(trackResult(solo("spotify", "sp1", "Lạc Trôi")));
    const region = screen.getByRole("region", { name: "Detected link" });
    expect(within(region).getByText("Lạc Trôi")).toBeTruthy();
    const play = within(region).getByRole("button", {
      name: t("track.playbackUnavailableFor", { title: "Lạc Trôi" }),
    });
    expect((play as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(region).getByRole("button", {
        name: t("menus.actionsFor", { title: "Lạc Trôi" }),
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("hands the track to the engine rather than opening a stream directly", async () => {
    const user = userEvent.setup();
    renderResult(trackResult(matched("sp1", "Lạc Trôi")));
    await user.click(
      screen.getByRole("button", { name: t("track.playLabel", { title: "Lạc Trôi" }) }),
    );
    expect(mocks.play).toHaveBeenCalledTimes(1);
    const handed = mocks.play.mock.calls[0]?.[0] as { title: string };
    // A hand-off of an identity to the engine — never a URL, a signed
    // source or a playback payload, none of which exists at this point.
    expect(handed.title).toBe("Lạc Trôi");
  });
});

describe("LinkSearchResult: a resolved collection", () => {
  it("renders the resource title, provider and a localized track count", () => {
    const tracks = [solo("youtube", "a", "One"), solo("youtube", "b", "Two")];
    renderResult(
      collectionResult(tracks, { provider: "youtube", resourceKind: "playlist" }),
    );
    const region = screen.getByRole("region", { name: "YouTube · Playlist" });
    expect(within(region).getByRole("heading", { name: "Aurora Mix" })).toBeTruthy();
    expect(within(region).getByText("YouTube · Playlist")).toBeTruthy();
    expect(within(region).getByText("2 tracks")).toBeTruthy();
    expect(within(region).getByText("One")).toBeTruthy();
    expect(within(region).getByText("Two")).toBeTruthy();
  });

  it("says so when the provider returned more than the bounded load", () => {
    const tracks = [solo("youtube", "a", "One")];
    renderResult(collectionResult(tracks, { provider: "youtube", total: 100 }));
    const region = screen.getByRole("region", { name: "YouTube · Playlist" });
    expect(region.textContent).toContain("1 of 100 tracks");
  });

  it("counts a single track with the singular form", () => {
    renderResult(collectionResult([solo("youtube", "a", "One")]));
    expect(screen.getByText("1 track")).toBeTruthy();
  });

  it("Play all starts the collection through the engine", async () => {
    const user = userEvent.setup();
    const tracks = [solo("youtube", "a", "One"), solo("youtube", "b", "Two")];
    renderResult(collectionResult(tracks, { provider: "youtube" }));
    await user.click(screen.getByRole("button", { name: t("search.playAll") }));
    expect(mocks.playCollection).toHaveBeenCalledTimes(1);
    const [handed, startIndex] = mocks.playCollection.mock.calls[0] as [
      unknown[],
      number,
    ];
    expect(handed).toHaveLength(2);
    expect(startIndex).toBe(0);
  });

  it("Play all skips a head row that cannot play", async () => {
    const user = userEvent.setup();
    const tracks = [solo("spotify", "sp1", "Catalog only"), matched("sp2", "Playable")];
    renderResult(collectionResult(tracks, { playable: 1 }));
    expect(
      (screen.getByRole("button", { name: t("search.playAll") }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: t("search.playAll") }));
    const startIndex = mocks.playCollection.mock.calls[0]?.[1] as number;
    expect(startIndex).toBe(1);
  });

  it("withholds Play all when no row is playable, and keeps the rows visible", () => {
    const tracks = [solo("spotify", "sp1", "One"), solo("spotify", "sp2", "Two")];
    renderResult(collectionResult(tracks));
    const playAll = screen.getByRole("button", { name: t("search.playAll") });
    expect((playAll as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("One")).toBeTruthy();
    expect(screen.getByText("Two")).toBeTruthy();
  });

  it("queues every row exactly once through the existing add path", async () => {
    const user = userEvent.setup();
    const tracks = [solo("youtube", "a", "One"), solo("youtube", "b", "Two")];
    renderResult(collectionResult(tracks, { provider: "youtube" }));
    await user.click(screen.getByRole("button", { name: t("search.queueAll") }));
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(
      mocks.queueAdd.mock.calls.map(([entry]) => (entry as { title: string }).title),
    ).toEqual(["One", "Two"]);
    // Pasting changed nothing; only an explicit action did.
    expect(mocks.playCollection).not.toHaveBeenCalled();
  });

  it("gives every row the same menu and playlist affordances as search results", () => {
    renderResult(collectionResult([solo("youtube", "a", "One")], { provider: "youtube" }));
    const menu = screen.getByRole("button", {
      name: t("menus.actionsFor", { title: "One" }),
    });
    expect((menu as HTMLButtonElement).disabled).toBe(false);
  });
});
