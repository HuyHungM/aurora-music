import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider } from "@/lib/providers/registry";
import { extractorManager } from "@/lib/providers/extractor-manager";
import {
  ensureSpotifyProvider,
  resetSpotifyBootstrap,
} from "@/lib/providers/spotify/bootstrap";
import type { EnvConfig } from "@/lib/config/env";

const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQ3";

function envWith(id: string | undefined, secret: string | undefined): EnvConfig {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test",
    SPOTIFY_CLIENT_ID: id,
    SPOTIFY_CLIENT_SECRET: secret,
  } as EnvConfig;
}

describe("Spotify bootstrap", () => {
  beforeEach(() => {
    clearProviders();
    resetSpotifyBootstrap();
  });

  afterEach(() => {
    clearProviders();
    resetSpotifyBootstrap();
  });

  it("registers nothing without credentials", () => {
    expect(ensureSpotifyProvider(envWith(undefined, undefined))).toBeNull();
    expect(() => getProvider("spotify")).toThrow();
  });

  it("registers nothing with only one credential", () => {
    expect(ensureSpotifyProvider(envWith("id", undefined))).toBeNull();
    expect(ensureSpotifyProvider(envWith(undefined, "secret"))).toBeNull();
    expect(() => getProvider("spotify")).toThrow();
  });

  it("registers the real provider with credentials", () => {
    const provider = ensureSpotifyProvider(envWith("id", "secret"));
    expect(provider?.id).toBe("spotify");
    expect(getProvider("spotify").id).toBe("spotify");
  });

  it("is idempotent across repeated calls", () => {
    const first = ensureSpotifyProvider(envWith("id", "secret"));
    const second = ensureSpotifyProvider(envWith("id", "secret"));
    expect(second).toBe(first);
  });

  it("is visible through the extractor manager in canonical order", () => {
    ensureSpotifyProvider(envWith("id", "secret"));
    expect(extractorManager.get("spotify").id).toBe("spotify");
    expect(
      extractorManager.extractorFor(
        `https://open.spotify.com/track/${TRACK_ID}`,
      )?.name,
    ).toBe("spotify");
  });

  it("recovers when the registry was cleared", () => {
    ensureSpotifyProvider(envWith("id", "secret"));
    clearProviders();
    const provider = ensureSpotifyProvider(envWith("id", "secret"));
    expect(provider?.id).toBe("spotify");
  });

  it("re-registers when credentials rotate", () => {
    const first = ensureSpotifyProvider(envWith("id", "secret-one"));
    const second = ensureSpotifyProvider(envWith("id", "secret-two"));
    expect(second).not.toBe(first);
    expect(getProvider("spotify").id).toBe("spotify");
  });

  it("never registers invalid credentials", () => {
    expect(ensureSpotifyProvider(envWith("  ", "secret"))).toBeNull();
    expect(() => getProvider("spotify")).toThrow();
  });
});
