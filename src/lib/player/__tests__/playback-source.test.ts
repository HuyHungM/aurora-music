import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain/track";
import {
  createResolutionGuard,
  withPlaybackSource,
} from "@/lib/player/playback-source";

function track(): Track {
  return {
    id: "t1",
    provider: "youtube",
    providerTrackId: "dQw4w9WgXcQ",
    title: "Song",
    artistId: "UC1",
    artistName: "Artist",
    streamUrl: "https://catalog.example/original.mp3",
  };
}

describe("withPlaybackSource", () => {
  it("attaches the resolved url to an in-memory copy", () => {
    const original = track();
    const loaded = withPlaybackSource(original, { url: "https://cdn.example/fresh.m4a" });
    expect(loaded.streamUrl).toBe("https://cdn.example/fresh.m4a");
    expect(loaded.providerTrackId).toBe("dQw4w9WgXcQ");
    // The input track is untouched: persistence keeps stable identity.
    expect(original.streamUrl).toBe("https://catalog.example/original.mp3");
  });
});

describe("createResolutionGuard", () => {
  it("keeps only the latest claim current", () => {
    const guard = createResolutionGuard();
    const first = guard.claim();
    const second = guard.claim();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.current()).toBe(second);
  });

  it("discards stale async resolutions in arrival order", async () => {
    const guard = createResolutionGuard();
    const applied: string[] = [];
    const slow = (async () => {
      const token = guard.claim();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (guard.isCurrent(token)) {
        applied.push("slow");
      }
      return token;
    })();
    const fast = (async () => {
      const token = guard.claim();
      if (guard.isCurrent(token)) {
        applied.push("fast");
      }
      return token;
    })();
    await Promise.all([slow, fast]);
    // The late-arriving stale result never applies over the newer track.
    expect(applied).toEqual(["fast"]);
  });

  it("starts with no claims", () => {
    const guard = createResolutionGuard();
    expect(guard.current()).toBe(0);
    expect(guard.isCurrent(0)).toBe(true);
  });
});
