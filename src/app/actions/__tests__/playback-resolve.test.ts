import { describe, expect, it } from "vitest";
import { resolveAudioSourceAction } from "@/app/actions/playback-resolve";

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
