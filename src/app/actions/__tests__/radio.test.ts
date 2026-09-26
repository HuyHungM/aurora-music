import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import { clearProviders } from "@/lib/providers/registry";

vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: vi.fn(async () => null),
  requireUser: vi.fn(async () => {
    throw new Error("Not authenticated");
  }),
  getCurrentUser: vi.fn(async () => null),
}));

vi.mock("@/lib/dal/library", () => ({
  getLibraryOverview: vi.fn(async () => ({ liked: [], recent: [], playlists: [] })),
}));

vi.mock("@/lib/dal/follow", () => ({
  listFollowedArtists: vi.fn(async () => []),
}));

vi.mock("@/lib/dal/recently-played", () => ({
  listRecent: vi.fn(async () => []),
}));

vi.mock("@/lib/radio/backend", () => ({
  getRadioBackend: vi.fn(),
}));

import { getRadioBackend } from "@/lib/radio/backend";
import {
  extendRadioBatchAction,
  startArtistRadioAction,
  startDiscoveryRadioAction,
  startTrackRadioAction,
} from "@/app/actions/radio";
import type { RadioDiscoveryBackend } from "@/lib/radio/service";

function makeTrack(
  provider: string,
  id: string,
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    provider: provider as Track["provider"],
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "a1",
    artistName: "Nova",
    duration: 200,
    ...overrides,
  };
}

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

describe("radio server actions (Phase 41)", () => {
  beforeEach(() => {
    clearProviders();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearProviders();
  });

  it("starts track radio with the seed first and a human label", async () => {
    const seed = makeTrack("youtube", "seed1", {
      title: "Midnight Run",
      artistName: "Nova",
    });
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        getTrack: async () => seed,
        searchTracks: async (query: string) =>
          query === "Nova"
            ? [makeTrack("deezer", "n1", { title: "Nova Song", artistName: "Nova" })]
            : [],
      }),
    );

    const result = await startTrackRadioAction("youtube", "seed1");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.station.tracks[0]?.providerTrackId).toBe("seed1");
    expect(result.station.tracks.map((t) => t.providerTrackId)).toContain("n1");
    // Queue-ready projection carries merged sources, never stream URLs.
    const raw = JSON.stringify(result.station.tracks);
    expect(raw).not.toContain("googlevideo");
    expect(raw).not.toContain("streamUrl");
  });

  it("rejects invalid seed refs with a safe error", async () => {
    const result = await startTrackRadioAction("youtube", "   ");
    expect(result).toEqual({
      ok: false,
      error: "Couldn't start radio. Try again in a moment.",
    });
  });

  it("reports failure when the seed cannot be resolved", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(backend({ getTrack: async () => null }));
    const result = await startTrackRadioAction("youtube", "missing");
    expect(result.ok).toBe(false);
  });

  it("starts discovery radio anonymously from the popular catalog", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        popularTracks: async () => [makeTrack("deezer", "pop1", { title: "Big Hit" })],
      }),
    );
    const result = await startDiscoveryRadioAction();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.station.tracks.map((t) => t.providerTrackId)).toContain("pop1");
  });

  it("starts artist radio from artist tracks", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        getArtist: async () => ({
          id: "a1",
          provider: "spotify",
          providerArtistId: "a1",
          name: "Artist a1",
        }),
        artistTracks: async () => [
          makeTrack("deezer", "d1", { title: "Hit One", artistName: "Nova" }),
        ],
      }),
    );

    const result = await startArtistRadioAction("spotify", "a1");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.station.tracks.map((t) => t.providerTrackId)).toContain("d1");
  });

  it("extends a session excluding already-queued keys", async () => {
    vi.mocked(getRadioBackend).mockReturnValue(
      backend({
        getTrack: async () =>
          makeTrack("youtube", "seed1", { title: "Midnight Run", artistName: "Nova" }),
        searchTracks: async () => [
          makeTrack("youtube", "fresh", { title: "Nova Gem", artistName: "Nova" }),
        ],
      }),
    );

    const result = await extendRadioBatchAction({
      mode: "track",
      seedTrack: { provider: "youtube", providerTrackId: "seed1" },
      excludeKeys: ["youtube:seed1", "youtube:fresh"],
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    // The only candidate was excluded: honest exhaustion, not an error.
    expect(result.batch.tracks).toEqual([]);
    expect(result.batch.exhausted).toBe(true);
  });

  it("rejects malformed extend input safely", async () => {
    const result = await extendRadioBatchAction({ mode: "unknown" } as never);
    expect(result.ok).toBe(false);
  });
});
