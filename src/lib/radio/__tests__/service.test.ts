import { describe, expect, it, vi } from "vitest";
import type { Album, Track } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import {
  RADIO_INITIAL_TRACKS,
  generateRadioBatch,
  groupCandidates,
  identityKeys,
  rankGroups,
  type RadioDiscoveryBackend,
} from "@/lib/radio/service";

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
    artistId: `artist-of-${id}`,
    artistName: `Artist of ${id}`,
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

function seedOf(track: Track) {
  return toTrackIdentity(track);
}

describe("groupCandidates", () => {
  it("merges cross-provider duplicates into one canonical group", () => {
    const groups = groupCandidates([
      makeTrack("spotify", "sp1", {
        title: "Midnight Run",
        artistId: "a1",
        artistName: "Nova",
        duration: 200,
      }),
      makeTrack("deezer", "dz1", {
        title: "Midnight Run",
        artistId: "a1",
        artistName: "Nova",
        duration: 200,
      }),
      makeTrack("youtube", "yt1", { title: "Unrelated", artistName: "Other" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.sources).toHaveLength(2);
  });

  it("drops uncanonicalizable tracks without sinking the batch", () => {
    const groups = groupCandidates([
      { ...makeTrack("youtube", "ok"), title: "  " },
      makeTrack("youtube", "fine", { title: "Fine Song" }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["Fine Song"]);
  });
});

describe("rankGroups", () => {
  it("orders same-artist above title affinity above the rest, ties stable", () => {
    const seed = seedOf(
      makeTrack("spotify", "seed", {
        title: "Midnight Run",
        artistId: "a1",
        artistName: "Nova",
        duration: 200,
      }),
    );
    const groups = groupCandidates([
      makeTrack("deezer", "other", { title: "Completely Different", artistName: "Stranger" }),
      makeTrack("youtube", "aff", { title: "Midnight Drive", artistName: "Stranger" }),
      makeTrack("deezer", "same", {
        title: "Another Song",
        artistId: "a9",
        artistName: "Nova",
        duration: 205,
      }),
    ]);
    const ranked = rankGroups(
      groups,
      {
        seedTitle: seed.title,
        seedArtist: "Nova",
        seedDurationMs: seed.durationMs,
        excludeKeys: new Set(),
      },
      10,
    );
    expect(ranked.map((r) => r.identity.primarySource.id)).toEqual([
      "same",
      "aff",
      "other",
    ]);
    expect(ranked[0]?.reasons).toContain("same-artist");
  });

  it("excludes the seed, played, and queued keys", () => {
    // The excluded set is built from the ranked groups themselves, so the
    // assertion is about the exclusion, not about a separately constructed
    // seed identity that nothing compares against.
    const groups = groupCandidates([
      makeTrack("spotify", "seed", { artistName: "Nova" }),
      makeTrack("deezer", "heard", { artistName: "Nova" }),
      makeTrack("youtube", "fresh", { artistName: "Nova" }),
    ]);
    const exclude = new Set([
      ...identityKeys(groups[0] as (typeof groups)[number]),
      ...identityKeys(groups[1] as (typeof groups)[number]),
    ]);
    const ranked = rankGroups(
      groups,
      { seedTitle: "X", seedArtist: "Nova", excludeKeys: exclude },
      10,
    );
    expect(ranked.map((r) => r.identity.primarySource.id)).toEqual(["fresh"]);
  });
});

describe("generateRadioBatch", () => {
  const seedTrack = makeTrack("spotify", "seed1", {
    title: "Midnight Run",
    artistId: "a1",
    artistName: "Nova",
    albumId: "al1",
    albumName: "Neon",
    duration: 200,
  });

  it("builds a track-radio batch from same-artist discovery first", async () => {
    const backendWithData = backend({
      searchTracks: async (query: string) =>
        query === "Nova"
          ? [
              makeTrack("deezer", "n1", { title: "Nova Song One", artistName: "Nova" }),
              makeTrack("youtube", "n2", { title: "Nova Song Two", artistName: "Nova" }),
            ]
          : [],
    });
    const batch = await generateRadioBatch(
      backendWithData,
      {
        mode: "track",
        seed: seedOf(seedTrack),
        excludeKeys: new Set(),
        limit: RADIO_INITIAL_TRACKS,
      },
    );
    expect(batch.exhausted).toBe(false);
    expect(batch.groups.map((g) => g.primarySource.id)).toEqual(["n1", "n2"]);
  });

  it("isolates per-avenue provider failure and still returns candidates", async () => {
    const failing: RadioDiscoveryBackend = {
      searchTracks: async (query: string) => {
        if (query === "Nova") {
          throw new Error("provider down");
        }
        return [makeTrack("youtube", "t1", { title: "Midnight Run Cover" })];
      },
      artistTracks: async () => [],
      albumTracks: async () => [],
      artistAlbums: async () => [],
      popularTracks: async () => [makeTrack("deezer", "p1", { title: "Popular One" })],
      getTrack: async () => null,
      getArtist: async () => null,
    };
    const batch = await generateRadioBatch(failing, {
      mode: "track",
      seed: seedOf(seedTrack),
      excludeKeys: new Set(),
      limit: 5,
    });
    expect(batch.exhausted).toBe(false);
    expect(batch.groups.length).toBeGreaterThan(0);
  });

  it("reports exhaustion when every avenue is empty", async () => {
    const batch = await generateRadioBatch(backend(), {
      mode: "artist",
      seedArtist: { provider: "spotify", providerArtistId: "a9", name: "Nobody" },
      excludeKeys: new Set(),
      limit: 5,
    });
    expect(batch.groups).toEqual([]);
    expect(batch.exhausted).toBe(true);
  });

  it("builds artist radio from artist tracks and albums", async () => {
    const artistBackend = backend({
      artistTracks: async () => [
        makeTrack("deezer", "d1", { title: "Hit One", artistName: "Nova" }),
      ],
      artistAlbums: async () =>
        [
          {
            id: "al9",
            provider: "spotify",
            title: "Neon Nights",
            artistId: "a1",
            artistName: "Nova",
          },
        ] as Album[],
      albumTracks: async () => [
        makeTrack("spotify", "s9", { title: "Album Cut", artistName: "Nova" }),
      ],
    });
    const batch = await generateRadioBatch(artistBackend, {
      mode: "artist",
      seedArtist: { provider: "spotify", providerArtistId: "a1", name: "Nova" },
      excludeKeys: new Set(),
      limit: 5,
    });
    expect(batch.exhausted).toBe(false);
    const ids = batch.groups.map((g) => g.primarySource.id);
    expect(ids).toContain("d1");
    expect(ids).toContain("s9");
  });

  it("builds discovery radio from popular plus bounded signals", async () => {
    const discoveryBackend = backend({
      popularTracks: async () => [makeTrack("deezer", "pop1", { title: "Big Hit" })],
      searchTracks: vi.fn(async (query: string) =>
        query === "Nova" ? [makeTrack("youtube", "nv1", { title: "Nova Tune" })] : [],
      ),
    });
    const batch = await generateRadioBatch(discoveryBackend, {
      mode: "discovery",
      signals: ["Nova", "ignored-1", "ignored-2", "ignored-3", "ignored-4"],
      excludeKeys: new Set(),
      limit: 5,
    });
    expect(batch.exhausted).toBe(false);
    // Only the first three signals are queried (bounded fan-out).
    const calls = vi.mocked(discoveryBackend.searchTracks).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["Nova", "ignored-1", "ignored-2"]);
  });
});
