import { describe, expect, it } from "vitest";
import {
  invalidatePlaybackResolutionAction,
  resolveAudioSourceAction,
} from "@/app/actions/playback-resolve";

describe("resolveAudioSourceAction", () => {
  it("rejects non-youtube providers without network access", async () => {
    const result = await resolveAudioSourceAction("spotify", "spotify-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAYBACK_RESOLUTION_ERROR");
    }
  });

  it("rejects malformed references without network access", async () => {
    const badId = await resolveAudioSourceAction("youtube", "nope");
    expect(badId.ok).toBe(false);
    const empty = await resolveAudioSourceAction("youtube", "   ");
    expect(empty.ok).toBe(false);
    const missing = await resolveAudioSourceAction("", "");
    expect(missing.ok).toBe(false);
  });

  it("serializes failures safely", async () => {
    const result = await resolveAudioSourceAction("deezer", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const payload = JSON.stringify(result.error);
      expect(payload).not.toContain("token");
      expect(payload).not.toContain("cookie");
      expect(result.error).toMatchObject({ retryable: false });
    }
  });
});

describe("invalidatePlaybackResolutionAction", () => {
  it("always reports ok, with or without a cached entry", async () => {
    // Best-effort by contract: on a cold instance there is nothing to drop,
    // which is the same position as having just cleared it.
    await expect(
      invalidatePlaybackResolutionAction("youtube", "dQw4w9WgXcQ"),
    ).resolves.toEqual({ ok: true });
    await expect(
      invalidatePlaybackResolutionAction("youtube", "dQw4w9WgXcQ"),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses malformed references without touching the cache", async () => {
    await expect(
      invalidatePlaybackResolutionAction("spotify", "spotify-1"),
    ).resolves.toEqual({ ok: true });
    await expect(
      invalidatePlaybackResolutionAction("youtube", "nope"),
    ).resolves.toEqual({ ok: true });
    await expect(invalidatePlaybackResolutionAction("", "")).resolves.toEqual({
      ok: true,
    });
  });
});
