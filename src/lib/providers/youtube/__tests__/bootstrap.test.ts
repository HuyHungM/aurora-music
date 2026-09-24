import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider } from "@/lib/providers/registry";
import { extractorManager } from "@/lib/providers/extractor-manager";
import {
  ensureYouTubeProvider,
  resetYouTubeBootstrap,
} from "@/lib/providers/youtube/bootstrap";
import type { EnvConfig } from "@/lib/config/env";

function envWith(key: string | undefined): EnvConfig {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    YOUTUBE_API_KEY: key,
  } as EnvConfig;
}

describe("YouTube bootstrap", () => {
  beforeEach(() => {
    clearProviders();
    resetYouTubeBootstrap();
  });

  afterEach(() => {
    clearProviders();
    resetYouTubeBootstrap();
  });

  it("registers nothing without a key", () => {
    expect(ensureYouTubeProvider(envWith(undefined))).toBeNull();
    expect(() => getProvider("youtube")).toThrow();
  });

  it("registers the real provider with a key", () => {
    const provider = ensureYouTubeProvider(envWith("test-key"));
    expect(provider?.id).toBe("youtube");
    expect(getProvider("youtube").id).toBe("youtube");
  });

  it("is idempotent across repeated calls", () => {
    const first = ensureYouTubeProvider(envWith("test-key"));
    const second = ensureYouTubeProvider(envWith("test-key"));
    expect(second).toBe(first);
  });

  it("is visible through the extractor manager", () => {
    ensureYouTubeProvider(envWith("test-key"));
    expect(extractorManager.get("youtube").id).toBe("youtube");
    expect(
      extractorManager.extractorFor("https://youtu.be/dQw4w9WgXcQ")?.name,
    ).toBe("youtube");
  });

  it("recovers when the registry was cleared", () => {
    ensureYouTubeProvider(envWith("test-key"));
    clearProviders();
    const provider = ensureYouTubeProvider(envWith("test-key"));
    expect(provider?.id).toBe("youtube");
    expect(getProvider("youtube").id).toBe("youtube");
  });

  it("re-registers when the key rotates", () => {
    const first = ensureYouTubeProvider(envWith("key-one"));
    const second = ensureYouTubeProvider(envWith("key-two"));
    expect(second).not.toBe(first);
    expect(getProvider("youtube").id).toBe("youtube");
  });
});
