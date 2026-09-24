import { describe, expect, it } from "vitest";
import { NormalizationError, toTrackIdentity } from "@/lib/domain";
import {
  createUnifiedSearch,
  enrichIdentity,
} from "@/lib/music/unified-search";
import {
  failedOutcome,
  fakeBackend,
  outcome,
  track,
} from "./fake-backend";

function sameSong(provider: string, id: string): ReturnType<typeof track> {
  return track(provider, {
    id,
    providerTrackId: id,
    title: "Lạc Trôi",
    artistId: `${provider}-st`,
    artistName: "Sơn Tùng M-TP",
    duration: 243,
    providerUrl: `https://example.invalid/${provider}/${id}`,
  });
}

describe("fan-out and outcomes", () => {
  it("aggregates all providers when all succeed", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [track("youtube")]),
        outcome("deezer", [track("deezer")]),
        outcome("spotify", [track("spotify")]),
      ]),
    );
    const result = await search.search("Lạc Trôi");
    expect(result.query).toBe("Lạc Trôi");
    expect(result.succeeded).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.providers.map((entry) => entry.provider)).toEqual([
      "youtube",
      "deezer",
      "spotify",
    ]);
  });

  it("keeps successful results when one provider fails", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [track("youtube")]),
        failedOutcome("deezer"),
        outcome("spotify", [track("spotify")]),
      ]),
    );
    const result = await search.search("x");
    expect(result.succeeded).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.tracks.length).toBeGreaterThan(0);
    expect(
      result.providers.find((entry) => entry.provider === "deezer")?.status,
    ).toBe("failed");
  });

  it("reports structured failure when all providers fail", async () => {
    const search = createUnifiedSearch(
      fakeBackend([failedOutcome("youtube"), failedOutcome("deezer")]),
    );
    const result = await search.search("x");
    expect(result.succeeded).toBe(false);
    expect(result.tracks).toEqual([]);
  });

  it("distinguishes all-empty from all-failed", async () => {
    const emptySearch = createUnifiedSearch(
      fakeBackend([outcome("youtube"), outcome("deezer")]),
    );
    const empty = await emptySearch.search("zzz");
    expect(empty.succeeded).toBe(true);
    expect(empty.partial).toBe(false);
    expect(empty.tracks).toEqual([]);

    const failedSearch = createUnifiedSearch(fakeBackend([failedOutcome("youtube")]));
    const failed = await failedSearch.search("zzz");
    expect(failed.succeeded).toBe(false);
  });

  it("forwards provider selection and limits to the backend", async () => {
    const backend = fakeBackend([outcome("spotify", [track("spotify")])]);
    const search = createUnifiedSearch(backend);
    await search.search("x", { providers: ["spotify"], limit: 5 });
    expect(backend.calls[0]?.options).toMatchObject({ providers: ["spotify"], limit: 5 });
  });

  it("rejects blank queries before fan-out", async () => {
    const backend = fakeBackend([]);
    const search = createUnifiedSearch(backend);
    await expect(search.search("   ")).rejects.toBeInstanceOf(NormalizationError);
    expect(backend.calls).toHaveLength(0);
  });

  it("skips malformed provider tracks without sinking the search", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [
          { ...track("youtube"), providerTrackId: "" },
          track("youtube", { title: "Kept" }),
        ]),
      ]),
    );
    const result = await search.search("x");
    expect(result.succeeded).toBe(true);
    expect(result.tracks).toHaveLength(1);
    expect(result.diagnostics.skippedMalformed).toBe(1);
  });
});

describe("canonical grouping", () => {
  it("merges the same song across three providers into one identity", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [sameSong("youtube", "yt-1")]),
        outcome("deezer", [sameSong("deezer", "dz-1")]),
        outcome("spotify", [sameSong("spotify", "sp-1")]),
      ]),
    );
    const result = await search.search("Lạc Trôi");
    expect(result.tracks).toHaveLength(1);
    const group = result.tracks[0];
    expect(group).toBeDefined();
    expect(group?.sources.map((source) => source.source).sort()).toEqual([
      "deezer",
      "spotify",
      "youtube",
    ]);
    // First-seen (youtube) identity id and primary survive enrichment.
    expect(group?.primarySource.source).toBe("youtube");
    expect(result.diagnostics.mergedSources).toBe(2);
  });

  it("keeps version variants separate", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [sameSong("youtube", "yt-1")]),
        outcome("spotify", [
          {
            ...sameSong("spotify", "sp-1"),
            title: "Lạc Trôi (Live)",
          },
        ]),
      ]),
    );
    const result = await search.search("x");
    expect(result.tracks).toHaveLength(2);
  });

  it("does not auto-merge possible-only pairs", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [
          track("youtube", { title: "Lạc Trôi", artistName: "Sơn Tùng M-TP" }),
        ]),
        outcome("deezer", [
          track("deezer", { title: "Lac Troi", artistName: "Son Tung" }),
        ]),
      ]),
    );
    const result = await search.search("x");
    // Folded-title + partial-artist evidence stays below strong: separate.
    expect(result.tracks).toHaveLength(2);
  });

  it("refreshes same-source duplicates instead of duplicating", async () => {
    const dup = sameSong("spotify", "sp-1");
    const search = createUnifiedSearch(
      fakeBackend([outcome("spotify", [dup, { ...dup }])]),
    );
    const result = await search.search("x");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.sources).toHaveLength(1);
  });

  it("keeps ties separate deterministically", async () => {
    // A and B reject each other, but C strongly matches both: ambiguous,
    // so C becomes its own group instead of merging incorrectly. A stub
    // matcher drives the tie branch directly (real scoring is built to
    // make ties rare).
    const stub = {
      match: (
        left: { primarySource: { source: string; id: string } },
        right: { primarySource: { source: string; id: string } },
      ) => {
        const key = (entry: { primarySource: { source: string; id: string } }) =>
          `${entry.primarySource.source}:${entry.primarySource.id}`;
        const pair = [key(left), key(right)].sort().join("+");
        const strong =
          pair === "deezer:dz-b+spotify:sp-c" || pair === "spotify:sp-c+youtube:yt-a";
        return strong
          ? {
              matched: true,
              classification: "strong" as const,
              score: 70,
              evidence: [],
              rejectionReasons: [],
            }
          : {
              matched: false,
              classification: "rejected" as const,
              score: 0,
              evidence: [],
              rejectionReasons: ["insufficient-evidence" as const],
            };
      },
    };
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [track("youtube", { id: "yt-a", providerTrackId: "yt-a" })]),
        outcome("deezer", [track("deezer", { id: "dz-b", providerTrackId: "dz-b" })]),
        outcome("spotify", [track("spotify", { id: "sp-c", providerTrackId: "sp-c" })]),
      ]),
    );
    const result = await search.search("x", { matcher: stub });
    expect(result.tracks).toHaveLength(3);
    expect(result.diagnostics.ties).toBe(1);
    expect(result.diagnostics.mergedSources).toBe(0);
    for (const group of result.tracks) {
      expect(group.sources).toHaveLength(1);
    }
    // Deterministic across runs (compare stable source keys; ids are fresh).
    const keys = (entries: typeof result.tracks) =>
      entries.map((entry) =>
        entry.sources.map((source) => `${source.source}:${source.id}`).join("+"),
      );
    const rerun = await search.search("x", { matcher: stub });
    expect(keys(rerun.tracks)).toEqual(keys(result.tracks));
  });

  it("orders groups by first appearance", async () => {
    const search = createUnifiedSearch(
      fakeBackend([
        outcome("youtube", [track("youtube", { title: "First" })]),
        outcome("deezer", [track("deezer", { title: "Second" })]),
      ]),
    );
    const result = await search.search("x");
    expect(result.tracks.map((entry) => entry.title)).toEqual(["First", "Second"]);
  });

  it("preserves provenance on every group", async () => {
    const search = createUnifiedSearch(
      fakeBackend([outcome("deezer", [sameSong("deezer", "dz-1")])]),
    );
    const result = await search.search("x");
    expect(result.tracks[0]?.sources).toEqual([
      expect.objectContaining({ source: "deezer", id: "dz-1" }),
    ]);
  });

  it("never mutates provider results", async () => {
    const tracks = [sameSong("youtube", "yt-1")];
    const backend = fakeBackend([outcome("spotify", tracks)]);
    const search = createUnifiedSearch(backend);
    const before = JSON.stringify(tracks);
    await search.search("x");
    expect(JSON.stringify(tracks)).toBe(before);
  });
});

describe("enrichIdentity", () => {
  it("refreshes an already-known source without duplicating", () => {
    const base = toTrackIdentity(sameSong("spotify", "sp-1"), { id: "aurora-base" });
    const same = toTrackIdentity(sameSong("spotify", "sp-1"), { id: "aurora-other" });
    const enriched = enrichIdentity(base, [same]);
    expect(enriched.id).toBe("aurora-base");
    expect(enriched.sources).toHaveLength(1);
  });

  it("adds a deezer source on strong match without touching primary", () => {
    const base = toTrackIdentity(sameSong("spotify", "sp-1"), { id: "aurora-base" });
    const candidate = toTrackIdentity(sameSong("deezer", "dz-1"), { id: "aurora-cand" });
    const enriched = enrichIdentity(base, [candidate]);
    expect(enriched.id).toBe("aurora-base");
    expect(enriched.primarySource.source).toBe("spotify");
    expect(enriched.sources.map((source) => source.source).sort()).toEqual([
      "deezer",
      "spotify",
    ]);
    // Inputs untouched.
    expect(base.sources).toHaveLength(1);
    expect(candidate.sources).toHaveLength(1);
  });

  it("ignores rejected and possible-only candidates", () => {
    const base = toTrackIdentity(sameSong("spotify", "sp-1"), { id: "aurora-base" });
    const live = toTrackIdentity(
      { ...sameSong("youtube", "yt-1"), title: "Lạc Trôi (Live)" },
      { id: "aurora-live" },
    );
    expect(enrichIdentity(base, [live]).sources).toHaveLength(1);
  });
});
