import { describe, expect, it, vi } from "vitest";
import { PlaybackResolutionError } from "@/lib/domain";
import { createServerSourceResolver } from "@/lib/playback/client-resolver";

describe("createServerSourceResolver", () => {
  it("returns parsed audio sources", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      source: { url: "https://cdn.example/a.m4a", mimeType: "audio/mp4" },
    }));
    const resolver = createServerSourceResolver(action);
    expect(resolver.source).toBe("youtube");
    const source = await resolver.resolveSource({ source: "youtube", id: "dQw4w9WgXcQ" });
    expect(source.url).toBe("https://cdn.example/a.m4a");
    expect(action).toHaveBeenCalledWith("youtube", "dQw4w9WgXcQ");
  });

  it("revives staged failures without leaking internals", async () => {
    const action = vi.fn(async () => ({
      ok: false as const,
      error: {
        name: "PlaybackResolutionError",
        code: "PLAYBACK_RESOLUTION_ERROR" as const,
        message: "Video unavailable",
        retryable: false,
        provider: "youtube",
        details: { providerTrackId: "dQw4w9WgXcQ", stage: "resolve" },
      },
    }));
    const resolver = createServerSourceResolver(action);
    const error = await resolver
      .resolveSource({ source: "youtube", id: "dQw4w9WgXcQ" })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(PlaybackResolutionError);
    expect(error).toMatchObject({ stage: "resolve", retryable: false });
  });

  it("rejects malformed source payloads at the stream stage", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      source: { url: "" },
    }));
    const resolver = createServerSourceResolver(action);
    await expect(
      resolver.resolveSource({ source: "youtube", id: "dQw4w9WgXcQ" }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError", stage: "stream" });
  });
});
