import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider } from "@/lib/providers/registry";
import { extractorManager } from "@/lib/providers/extractor-manager";
import {
  ensureDeezerProvider,
  resetDeezerBootstrap,
} from "@/lib/providers/deezer/bootstrap";
import { ensureYouTubeProvider } from "@/lib/providers/youtube/bootstrap";
import type { EnvConfig } from "@/lib/config/env";

const emptyEnv = {} as EnvConfig;

describe("Deezer bootstrap", () => {
  beforeEach(() => {
    clearProviders();
    resetDeezerBootstrap();
  });

  afterEach(() => {
    clearProviders();
    resetDeezerBootstrap();
  });

  it("registers without any credentials", () => {
    const provider = ensureDeezerProvider();
    expect(provider?.id).toBe("deezer");
    expect(getProvider("deezer").id).toBe("deezer");
  });

  it("is idempotent across repeated calls", () => {
    const first = ensureDeezerProvider();
    const second = ensureDeezerProvider();
    expect(second).toBe(first);
  });

  it("is visible through the extractor manager", () => {
    ensureDeezerProvider();
    expect(extractorManager.get("deezer").id).toBe("deezer");
    expect(
      extractorManager.extractorFor("https://www.deezer.com/track/3135556")?.name,
    ).toBe("deezer");
  });

  it("recovers when the registry was cleared", () => {
    ensureDeezerProvider();
    clearProviders();
    const provider = ensureDeezerProvider();
    expect(provider?.id).toBe("deezer");
  });

  it("leaves YouTube registration unaffected", () => {
    ensureDeezerProvider();
    expect(ensureYouTubeProvider(emptyEnv)).toBeNull();
    expect(extractorManager.get("deezer").id).toBe("deezer");
  });

  it("keeps canonical provider order (youtube, deezer, spotify)", () => {
    ensureDeezerProvider();
    expect(
      extractorManager.list().map((provider) => provider.id),
    ).toEqual(["deezer"]);
  });
});
