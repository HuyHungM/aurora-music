// @vitest-environment jsdom
/**
 * The `/search` page's classification branch (feature §7 of the report).
 *
 * The page reads `?q=` and is a server component, so what is under test here
 * is ORDER: classification happens before `searchQuerySchema` and before any
 * provider call, and the three outcomes (text query / provider link /
 * unsupported link) are mutually exclusive. Every network-shaped seam is a
 * mock, which is the point — an unsupported link must reach NONE of them,
 * and a text query must reach only the text search.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { track } from "@/lib/music/__tests__/fake-backend";
import { toTrackIdentity } from "@/lib/domain";
import { getT } from "@/lib/i18n/translate";
import SearchPage from "../page";

const mocks = vi.hoisted(() => ({
  resolveSearchLinkAction: vi.fn(),
  searchUnifiedTracksAction: vi.fn(),
  recordSearchAction: vi.fn().mockResolvedValue(undefined),
  clearSearchHistoryAction: vi.fn().mockResolvedValue(undefined),
  getSessionUserId: vi.fn(),
  listSearchHistory: vi.fn(),
  getShellProviders: vi.fn(),
  getPreferredProvider: vi.fn(),
}));

vi.mock("@/lib/i18n/server", () => ({
  getRequestLocale: async () => "en",
}));

vi.mock("@/app/actions/resolve-search-link", () => ({
  resolveSearchLinkAction: mocks.resolveSearchLinkAction,
}));

vi.mock("@/app/actions/unified-search", () => ({
  searchUnifiedTracksAction: mocks.searchUnifiedTracksAction,
}));

vi.mock("@/app/actions/search", () => ({
  recordSearchAction: mocks.recordSearchAction,
  clearSearchHistoryAction: mocks.clearSearchHistoryAction,
}));

vi.mock("@/app/actions/locale", () => ({ setLocaleAction: vi.fn() }));

vi.mock("@/lib/providers/server", () => ({
  getShellProviders: mocks.getShellProviders,
  // No artist/album capability: the single-provider side paths are not what
  // this file is about, and reporting them unsupported keeps them out of the
  // way without pretending they succeeded.
  getPreferredProvider: () => ({ id: "deezer", capabilities: new Set<string>() }),
}));

vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: mocks.getSessionUserId,
}));

vi.mock("@/lib/dal/search-history", () => ({
  listSearchHistory: mocks.listSearchHistory,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/search",
  useSearchParams: () => ({ get: () => null, has: () => false }),
}));

const t = getT("en");

function emptyUnifiedResult() {
  return { ok: true, result: { succeeded: true, tracks: [], partial: false } };
}

async function renderSearch(q: string) {
  const element = await SearchPage({
    searchParams: Promise.resolve({ q }),
  });
  return render(element);
}

function heading() {
  return (screen.getByRole("heading", { level: 1 }) as HTMLElement).textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue(null);
  mocks.resolveSearchLinkAction.mockReset();
  mocks.searchUnifiedTracksAction.mockReset();
});

describe("SearchPage: an unsupported link is refused, not searched", () => {
  it("names the failure and reaches no provider, no action and no history", async () => {
    await renderSearch("https://example.com/watch?v=dQw4w9WgXcQ");

    expect(heading().trim()).toBe(t("search.linkUnsupportedTitle"));
    expect(screen.getByText(t("search.linkUnsupported"))).toBeTruthy();

    // Not one of the seams the link path could have leaked into. A foreign
    // host must never be text-searched (that would be a blind search of URL
    // prose), and it must never be resolved as a provider link either.
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
    expect(mocks.searchUnifiedTracksAction).not.toHaveBeenCalled();
    expect(mocks.getSessionUserId).not.toHaveBeenCalled();
    expect(mocks.listSearchHistory).not.toHaveBeenCalled();
    expect(mocks.recordSearchAction).not.toHaveBeenCalled();
  });

  it("explains an allowlisted host with an unreadable resource separately", async () => {
    // Recognised host, wrong resource type: the user pasted a real Spotify
    // link, so "not supported" would be a worse answer than "not readable".
    await renderSearch("https://open.spotify.com/artist/6Ub0qfYbXNoUvufHmuvafC");

    expect(heading().trim()).toBe(t("search.linkUnsupportedTitle"));
    expect(screen.getByText(t("search.linkUnreadable"))).toBeTruthy();
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
    expect(mocks.searchUnifiedTracksAction).not.toHaveBeenCalled();
  });

  it("does not show the idle prompt or history for a refused link", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    await renderSearch("https://example.com/a");

    expect(screen.queryByText(t("search.subtitle"))).toBeNull();
    expect(screen.queryByText(t("search.emptyTitle"))).toBeNull();
    expect(mocks.getSessionUserId).not.toHaveBeenCalled();
  });
});

describe("SearchPage: a supported link resolves instead of searching", () => {
  const SRC = {
    provider: "youtube",
    kind: "track",
    id: "dQw4w9WgXcQ",
    url: "https://youtu.be/dQw4w9WgXcQ",
  };

  function resolved() {
    return {
      ok: true,
      result: {
        source: SRC,
        canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        resource: {
          kind: "track",
          provider: "youtube",
          resourceKind: "track",
          id: "dQw4w9WgXcQ",
          matched: false,
          track: toTrackIdentity(
            track("youtube", {
              id: "dQw4w9WgXcQ",
              providerTrackId: "dQw4w9WgXcQ",
              title: "Never Gonna Give You Up",
              duration: 213,
            }),
          ),
        },
      },
    };
  }

  it("routes the link to the resolver and never to the text search", async () => {
    mocks.resolveSearchLinkAction.mockResolvedValue(resolved());
    await renderSearch("https://youtu.be/dQw4w9WgXcQ?si=tracking-noise");

    expect(mocks.resolveSearchLinkAction).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSearchLinkAction).toHaveBeenCalledWith(
      "https://youtu.be/dQw4w9WgXcQ?si=tracking-noise",
    );
    expect(mocks.searchUnifiedTracksAction).not.toHaveBeenCalled();
    expect(heading()).toBe("Never Gonna Give You Up");
  });

  it("records the canonical URL in history, never the tracking parameters", async () => {
    mocks.resolveSearchLinkAction.mockResolvedValue(resolved());
    await renderSearch("https://youtu.be/dQw4w9WgXcQ?si=tracking-noise");

    expect(mocks.recordSearchAction).toHaveBeenCalledTimes(1);
    expect(mocks.recordSearchAction).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("accepts a link longer than the prose query cap", async () => {
    // `searchQuerySchema` caps `q` at 200 characters. Classification runs
    // first precisely so a URL — which can exceed that easily — is never
    // rejected as an over-long prose query.
    const longUrl = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${"PL".repeat(120)}`;
    expect(longUrl.length).toBeGreaterThan(200);
    mocks.resolveSearchLinkAction.mockResolvedValue(resolved());

    await renderSearch(longUrl);

    expect(mocks.resolveSearchLinkAction).toHaveBeenCalledWith(longUrl);
    expect(mocks.searchUnifiedTracksAction).not.toHaveBeenCalled();
    expect(heading()).toBe("Never Gonna Give You Up");
  });

  it("surfaces a resolution failure as copy, not as a provider message", async () => {
    mocks.resolveSearchLinkAction.mockResolvedValue({
      ok: false,
      error: "Could not resolve this link.",
      linkError: "unavailable",
    });
    await renderSearch("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3");

    expect(heading().trim()).toBe(t("search.linkErrorTitle"));
    expect(screen.getByText(t("search.linkUnavailable"))).toBeTruthy();
    // The action's own English sentence is not what the user is shown; only
    // the localized copy for the code is.
    expect(screen.queryByText("Could not resolve this link.")).toBeNull();
    expect(mocks.recordSearchAction).not.toHaveBeenCalled();
  });

  it("maps a missing resource to its own message", async () => {
    mocks.resolveSearchLinkAction.mockResolvedValue({
      ok: false,
      error: "Could not resolve this link.",
      linkError: "not-found",
    });
    await renderSearch("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3");

    expect(screen.getByText(t("search.linkNotFound"))).toBeTruthy();
  });
});

describe("SearchPage: a text query keeps the existing path", () => {
  it("searches as text and never calls the link resolver", async () => {
    mocks.searchUnifiedTracksAction.mockResolvedValue(emptyUnifiedResult());
    await renderSearch("  Sơn Tùng M-TP  ");

    expect(mocks.searchUnifiedTracksAction).toHaveBeenCalledTimes(1);
    expect(mocks.searchUnifiedTracksAction).toHaveBeenCalledWith("Sơn Tùng M-TP");
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
    expect(heading().trim()).toBe(t("search.resultsFor", { query: "Sơn Tùng M-TP" }));
    expect(mocks.recordSearchAction).toHaveBeenCalledWith("Sơn Tùng M-TP");
  });

  it("treats punctuated prose as a query, not as a broken link", async () => {
    mocks.searchUnifiedTracksAction.mockResolvedValue(emptyUnifiedResult());
    await renderSearch("What's up?");

    expect(mocks.searchUnifiedTracksAction).toHaveBeenCalledWith("What's up?");
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
    expect(screen.queryByText(t("search.linkUnsupportedTitle"))).toBeNull();
    expect(screen.getByText(t("search.noResultsTitle", { query: "What's up?" }))).toBeTruthy();
  });

  it("treats prose that merely contains a URL as a query", async () => {
    mocks.searchUnifiedTracksAction.mockResolvedValue(emptyUnifiedResult());
    const input = "listen to https://youtu.be/dQw4w9WgXcQ later";
    await renderSearch(input);

    expect(mocks.searchUnifiedTracksAction).toHaveBeenCalledWith(input);
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
  });

  it("keeps the idle prompt and history for an empty search", async () => {
    mocks.getSessionUserId.mockResolvedValue("user-1");
    mocks.listSearchHistory.mockResolvedValue([]);
    await renderSearch("");

    expect(screen.getByText(t("search.subtitle"))).toBeTruthy();
    expect(screen.getByText(t("search.emptyTitle"))).toBeTruthy();
    expect(mocks.resolveSearchLinkAction).not.toHaveBeenCalled();
    expect(mocks.searchUnifiedTracksAction).not.toHaveBeenCalled();
    expect(mocks.getSessionUserId).toHaveBeenCalledTimes(1);
    expect(mocks.listSearchHistory).toHaveBeenCalledWith("user-1", 8);
  });
});
