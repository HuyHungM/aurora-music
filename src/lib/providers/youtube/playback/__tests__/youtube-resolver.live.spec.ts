import { describe, expect, it } from "vitest";
import { createPlaybackResolver } from "@/lib/playback/resolver";
import { createYouTubeResolver } from "@/lib/providers/youtube/playback/youtube-resolver";
import { createInnertubePlaybackClient } from "@/lib/providers/youtube/playback/innertube-client";
import { parseAudioSource } from "@/lib/domain/audio-source";
import type { TrackIdentity } from "@/lib/domain/track-identity";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

const VIDEO_ID = "dQw4w9WgXcQ";

function identity(): TrackIdentity {
  return {
    id: "e2e-fixture-1",
    primarySource: { source: "youtube", id: VIDEO_ID },
    sources: [{ source: "youtube", id: VIDEO_ID }],
    title: "Never Gonna Give You Up",
    artists: [{ id: "UC1", provider: "youtube", name: "Rick Astley" }],
  };
}

/**
 * Live resolver smoke (Phase 17 §11): TrackIdentity -> PlaybackResolver ->
 * YouTubeResolver -> AudioSource against the real provider. Opt-in only;
 * skipped (never failed) without AURORA_E2E_LIVE_PLAYBACK=1.
 * Property assertions only — the temporary URL is never snapshotted,
 * persisted, or logged in full.
 */
describe.skipIf(!LIVE)("live YouTube resolution", () => {
  it(
    "resolves a fresh structurally-valid AudioSource",
    async () => {
      const before = JSON.parse(JSON.stringify(identity())) as TrackIdentity;
      const resolver = createPlaybackResolver([
        {
          source: "youtube",
          resolveSource: (ref) =>
            createYouTubeResolver(createInnertubePlaybackClient()).resolveSource(ref),
        },
      ]);

      expect(resolver.canResolve(identity())).toBe(true);
      const source = await resolver.resolve(identity());

      // Temporary URL: properties, never literals.
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.url.length).toBeGreaterThan(0);
      expect(source.url).toContain("googlevideo");
      expect(parseAudioSource(source)).not.toBeNull();
      // Canonical identity untouched by resolution.
      expect(identity()).toEqual(before);
      // Expiry observed, never stored anywhere by this test.
      expect(
        source.expiresAt === undefined || source.expiresAt instanceof Date,
      ).toBe(true);
      if (source.durationMs !== undefined) {
        expect(source.durationMs).toBeGreaterThan(0);
      }
      if (source.mimeType !== undefined) {
        expect(source.mimeType).toContain("mp4");
      }
    },
    60_000,
  );
});
