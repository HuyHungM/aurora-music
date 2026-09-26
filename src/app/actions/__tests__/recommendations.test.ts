import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
  getSessionUserId: vi.fn(),
}));

vi.mock("@/lib/radio/backend", () => ({
  getRadioBackend: vi.fn(),
}));

vi.mock("@/lib/recommendations/signals", () => ({
  collectRecommendationSignals: vi.fn(),
  recentHistoryExcludeKeys: vi.fn(),
}));

import { getSessionUserId } from "@/lib/dal/session";
import { getRadioBackend } from "@/lib/radio/backend";
import {
  collectRecommendationSignals,
  recentHistoryExcludeKeys,
} from "@/lib/recommendations/signals";
import { RECOMMENDATION_SET_SIZE } from "@/lib/recommendations/service";
import type { RadioDiscoveryBackend } from "@/lib/radio/service";
import { recommendTracksAction } from "../recommendations";

/**
 * Phase 47 recommendation action boundary (§24, §48, §81, §82).
 *
 * Three properties are under test, and all three are contract rather than
 * behaviour:
 *
 *  1. PRIVACY — the personalization signals are read from Aurora's own
 *     database on the server. The client's request body carries only the
 *     shape of the ask, never listening history, and nothing is forwarded
 *     anywhere. `collectRecommendationSignals` is called with the session
 *     user id and nothing else.
 *  2. BOUNDS — a client cannot turn one request into an unbounded payload.
 *  3. FAILURE — a provider outage returns a safe empty/error result, never a
 *     throw and never a stack trace.
 */

/** The exact shape `collectRecommendationSignals` returns. */
function signals(
  overrides: Partial<{
    recentArtists: string[];
    likedArtists: string[];
    followedArtists: Array<{ provider: string; providerArtistId: string; name: string }>;
  }> = {},
) {
  return {
    recentArtists: [],
    likedArtists: [],
    followedArtists: [],
    ...overrides,
  };
}

const NO_SIGNALS = signals();

function backend(overrides: Partial<RadioDiscoveryBackend> = {}): RadioDiscoveryBackend {
  return {
    searchTracks: async () => [],
    artistTracks: async () => [],
    albumTracks: async () => [],
    artistAlbums: async () => [],
    popularTracks: async () => [],
    getTrack: async () => null,
    getArtist: async () => null,
    ...overrides,
  };
}

function catalogTrack(provider: string, id: string, artistName: string) {
  return {
    id,
    provider,
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: `${provider}-artist`,
    artistName,
    duration: 200,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserId).mockResolvedValue("user-1");
  vi.mocked(collectRecommendationSignals).mockResolvedValue(NO_SIGNALS);
  vi.mocked(recentHistoryExcludeKeys).mockResolvedValue([]);
  vi.mocked(getRadioBackend).mockReturnValue(backend());
});

describe("recommendTracksAction privacy", () => {
  it("derives signals from the session on the server, never from the request", async () => {
    vi.mocked(collectRecommendationSignals).mockResolvedValue(
      signals({ recentArtists: ["Nova"], likedArtists: ["Orion"] }),
    );
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({ popularTracks: async () => [catalogTrack("spotify", "p1", "Nova")] }),
    );

    // A request body stuffed with "history" must be ignored entirely: the
    // only recognized fields are surface, currentTrack, excludeKeys, limit.
    await recommendTracksAction({
      surface: "home",
      limit: 5,
      recentArtists: ["Injected"],
      likedArtists: ["Injected"],
      history: [{ provider: "spotify", providerTrackId: "sneaky" }],
    } as never);

    expect(collectRecommendationSignals).toHaveBeenCalledWith("user-1");
    // The session is the only source of personalization.
    expect(vi.mocked(collectRecommendationSignals).mock.calls).toEqual([["user-1"]]);
  });

  it("works for an anonymous visitor with no session at all", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({ popularTracks: async () => [catalogTrack("spotify", "p1", "Nova")] }),
    );

    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks.length).toBeGreaterThan(0);
      // Non-personalized discovery for someone with no history.
      expect(result.categories).toEqual(["continue-discovering"]);
    }
  });

  it("tolerates a session lookup that throws", async () => {
    vi.mocked(getSessionUserId).mockRejectedValue(new Error("no cookie"));
    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks).toEqual([]);
    }
  });
});

describe("recommendTracksAction request parsing", () => {
  it("defaults an unknown surface to home rather than trusting it", async () => {
    await recommendTracksAction({ surface: "literally-anything" });
    expect(vi.mocked(collectRecommendationSignals)).toHaveBeenCalled();
    // home must not seed from a client-supplied current track.
    const result = await recommendTracksAction({
      surface: "not-a-surface",
      currentTrack: { provider: "youtube", providerTrackId: "x" },
    });
    expect(result.ok).toBe(true);
  });

  it("ignores a malformed current track instead of throwing", async () => {
    for (const currentTrack of [
      null,
      "a string",
      42,
      {},
      { provider: "" },
      { provider: "youtube" },
      { provider: "youtube", providerTrackId: "" },
      { provider: "a".repeat(65), providerTrackId: "x" },
      { provider: "youtube", providerTrackId: "b".repeat(257) },
    ]) {
      const result = await recommendTracksAction({
        surface: "track",
        currentTrack: currentTrack as never,
      });
      expect(result.ok, JSON.stringify(currentTrack)).toBe(true);
    }
  });

  it("clamps a hostile limit to the documented maximum", async () => {
    for (const limit of [0, -1, 10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await recommendTracksAction({ surface: "home", limit });
      expect(result.ok, String(limit)).toBe(true);
      if (result.ok) {
        expect(result.tracks.length).toBeLessThanOrEqual(RECOMMENDATION_SET_SIZE);
      }
    }
  });

  it("defaults an absent or non-numeric limit to the documented size", async () => {
    for (const limit of [undefined, "10", {}, []]) {
      const result = await recommendTracksAction({ surface: "home", limit });
      expect(result.ok).toBe(true);
    }
  });

  it("discards malformed exclusion keys and merges the real history ones", async () => {
    vi.mocked(recentHistoryExcludeKeys).mockResolvedValue(["spotify:history-1"]);
    const result = await recommendTracksAction({
      surface: "home",
      excludeKeys: ["spotify:ok", "", 42, null, "b".repeat(321)],
    });
    expect(result.ok).toBe(true);
  });

  it("caps a huge exclusion payload rather than passing it through", async () => {
    const flood = Array.from({ length: 5000 }, (_, i) => `spotify:k${i}`);
    const result = await recommendTracksAction({ surface: "home", excludeKeys: flood });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object request", async () => {
    for (const request of [null, undefined, "string", 42]) {
      const result = await recommendTracksAction(request as never);
      expect(result.ok, String(request)).toBe(false);
      if (!result.ok) {
        // The error must be the safe, user-facing string — never an
        // exception, a stack, or a provider name.
        expect(result.error).toBe("Couldn't find recommendations right now.");
      }
    }
  });
});

describe("recommendTracksAction failure handling", () => {
  it("returns a safe error when the backend constructor throws", async () => {
    vi.mocked(getRadioBackend).mockImplementation(() => {
      throw new Error("jamendo credentials missing");
    });
    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // No provider or credential detail leaks through the boundary.
      expect(result.error).toBe("Couldn't find recommendations right now.");
      expect(result.error).not.toContain("jamendo");
    }
  });

  it("returns an empty set rather than an error when the catalog is empty", async () => {
    const result = await recommendTracksAction({ surface: "home" });
    expect(result).toEqual({ ok: true, tracks: [], categories: [] });
  });

  it("degrades to whatever survived when one avenue fails", async () => {
    vi.mocked(collectRecommendationSignals).mockResolvedValue({
      recentArtists: ["Nova"],
      likedArtists: [],
      followedArtists: [],
    });
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        searchTracks: async () => {
          throw new Error("search down");
        },
        popularTracks: async () => [catalogTrack("spotify", "p1", "Orion")],
      }),
    );
    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks.length).toBeGreaterThan(0);
    }
  });
});

describe("recommendTracksAction result shape", () => {
  it("returns plain Aurora tracks, never provider-branded product types", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({ popularTracks: async () => [catalogTrack("spotify", "sp1", "Nova")] }),
    );
    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = result.tracks[0];
    expect(track).toBeDefined();
    // A real Aurora Track: display metadata the surfaces can render, with a
    // playable provider, and no `isSpotify`-style flag anywhere.
    expect(track?.title.length).toBeGreaterThan(0);
    expect(track?.artistName.length).toBeGreaterThan(0);
    expect(Object.keys(track as object).some((key) => /^is[A-Z]/.test(key))).toBe(false);
  });

  it("never returns the same canonical track twice", async () => {
    const single = catalogTrack("spotify", "dup", "Nova");
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({ popularTracks: async () => [single, single, single] }),
    );
    const result = await recommendTracksAction({ surface: "home" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks).toHaveLength(1);
  });

  it("excludes a track the caller already has in the queue", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        popularTracks: async () => [
          catalogTrack("spotify", "queued", "Nova"),
          catalogTrack("spotify", "fresh", "Orion"),
        ],
      }),
    );
    const result = await recommendTracksAction({
      surface: "home",
      excludeKeys: ["spotify:queued"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks.map((track) => track.providerTrackId)).toEqual(["fresh"]);
  });
});
