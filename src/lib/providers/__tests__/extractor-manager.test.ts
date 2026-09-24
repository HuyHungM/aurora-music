import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackNotFoundError } from "@/lib/domain";
import {
  ProviderNotFoundError,
  UnsupportedProviderCapabilityError,
} from "@/lib/errors";
import { clearProviders } from "@/lib/providers/registry";
import { ExtractorManager } from "@/lib/providers/extractor-manager";
import { makeFakeProvider, makeTrack } from "./fake-provider";

const YT_ID = "dQw4w9WgXcQ";

describe("ExtractorManager registration", () => {
  let manager: ExtractorManager;

  beforeEach(() => {
    clearProviders();
    manager = new ExtractorManager();
  });

  afterEach(() => {
    clearProviders();
  });

  it("registers and looks up providers", () => {
    manager.register(makeFakeProvider("youtube"));
    expect(manager.has("youtube")).toBe(true);
    expect(manager.get("youtube").id).toBe("youtube");
    expect(manager.has("spotify")).toBe(false);
  });

  it("replaces duplicate registration deterministically", () => {
    const first = makeFakeProvider("youtube");
    const second = makeFakeProvider("youtube");
    expect(manager.register(first)).toBeNull();
    expect(manager.register(second)).toBe(first);
    expect(manager.register(second)).toBe(second);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("youtube")).toBe(second);
  });

  it("unregisters providers", () => {
    manager.register(makeFakeProvider("youtube"));
    expect(manager.unregister("youtube")).toBe(true);
    expect(manager.unregister("youtube")).toBe(false);
    expect(manager.has("youtube")).toBe(false);
  });

  it("lists in canonical order regardless of registration order", () => {
    manager.register(makeFakeProvider("spotify"));
    manager.register(makeFakeProvider("youtube"));
    manager.register(makeFakeProvider("deezer"));
    expect(manager.list().map((provider) => provider.id)).toEqual([
      "youtube",
      "deezer",
      "spotify",
    ]);
  });

  it("throws ProviderNotFoundError for unknown providers", () => {
    expect(() => manager.get("youtube")).toThrow(ProviderNotFoundError);
  });

  it("shares the single canonical registry", async () => {
    manager.register(makeFakeProvider("youtube"));
    const other = new ExtractorManager();
    expect(other.has("youtube")).toBe(true);
    other.clear();
    expect(manager.has("youtube")).toBe(false);
  });
});

describe("ExtractorManager detection", () => {
  let manager: ExtractorManager;

  beforeEach(() => {
    clearProviders();
    manager = new ExtractorManager();
    manager.register(makeFakeProvider("youtube"));
    manager.register(makeFakeProvider("spotify"));
  });

  afterEach(() => {
    clearProviders();
  });

  it("detects supported urls", () => {
    expect(manager.detect(`https://youtu.be/${YT_ID}`)).toMatchObject({
      provider: "youtube",
      kind: "track",
    });
  });

  it("resolves the owning extractor for a url", () => {
    expect(
      manager.extractorFor(`https://youtu.be/${YT_ID}`)?.name,
    ).toBe("youtube");
  });

  it("returns null for plain text and unregistered providers", () => {
    expect(manager.extractorFor("Lạc Trôi")).toBeNull();
    expect(manager.extractorFor("https://www.deezer.com/track/3135556")).toBeNull();
  });
});

describe("ExtractorManager search fan-out", () => {
  let manager: ExtractorManager;

  beforeEach(() => {
    clearProviders();
    manager = new ExtractorManager();
  });

  afterEach(() => {
    clearProviders();
  });

  it("aggregates results when all providers succeed", async () => {
    manager.register(makeFakeProvider("youtube"));
    manager.register(makeFakeProvider("deezer"));
    manager.register(makeFakeProvider("spotify"));
    const result = await manager.searchAll("Lạc Trôi");
    expect(result.succeeded).toBe(true);
    expect(result.tracks).toHaveLength(3);
    expect(result.outcomes.map((outcome) => outcome.provider)).toEqual([
      "youtube",
      "deezer",
      "spotify",
    ]);
    expect(
      result.outcomes.every((outcome) => outcome.status === "success"),
    ).toBe(true);
  });

  it("isolates partial failures without losing successes", async () => {
    manager.register(makeFakeProvider("youtube"));
    manager.register(makeFakeProvider("deezer", { failSearch: true }));
    manager.register(makeFakeProvider("spotify"));
    const result = await manager.searchAll("Lạc Trôi");
    expect(result.succeeded).toBe(true);
    expect(result.tracks).toHaveLength(2);
    const deezer = result.outcomes.find(
      (outcome) => outcome.provider === "deezer",
    );
    expect(deezer?.status).toBe("failed");
    expect(deezer?.error?.code).toBe("EXTRACTOR_ERROR");
  });

  it("reports aggregate failure when every provider fails", async () => {
    manager.register(makeFakeProvider("youtube", { failSearch: true }));
    manager.register(makeFakeProvider("deezer", { failSearch: true }));
    const result = await manager.searchAll("Lạc Trôi");
    expect(result.succeeded).toBe(false);
    expect(result.tracks).toEqual([]);
    expect(
      result.outcomes.every((outcome) => outcome.status === "failed"),
    ).toBe(true);
  });

  it("distinguishes empty success from failure", async () => {
    manager.register(makeFakeProvider("youtube", { tracks: [] }));
    const result = await manager.searchAll("Lạc Trôi");
    expect(result.succeeded).toBe(true);
    expect(result.outcomes[0]?.status).toBe("empty");
    expect(result.tracks).toEqual([]);
  });

  it("marks unsupported capabilities without invoking the method", async () => {
    const provider = makeFakeProvider("deezer", {
      without: ["search.tracks"],
    });
    const spy = vi.spyOn(provider, "searchTracks");
    manager.register(provider);
    const result = await manager.searchAll("Lạc Trôi");
    expect(result.succeeded).toBe(false);
    expect(result.outcomes[0]?.status).toBe("unsupported");
    expect(spy).not.toHaveBeenCalled();
  });

  it("supports explicit provider selection in caller order", async () => {
    manager.register(makeFakeProvider("youtube"));
    manager.register(makeFakeProvider("deezer"));
    manager.register(makeFakeProvider("spotify"));
    const result = await manager.searchAll("Lạc Trôi", {
      providers: ["spotify", "youtube"],
    });
    expect(result.outcomes.map((outcome) => outcome.provider)).toEqual([
      "spotify",
      "youtube",
    ]);
    expect(result.tracks.map((track) => track.provider)).toEqual([
      "spotify",
      "youtube",
    ]);
  });

  it("maps unknown selected providers to failed outcomes", async () => {
    manager.register(makeFakeProvider("youtube"));
    const result = await manager.searchAll("Lạc Trôi", {
      providers: ["youtube", "napster"],
    });
    expect(result.succeeded).toBe(true);
    const unknown = result.outcomes.find(
      (outcome) => outcome.provider === "napster",
    );
    expect(unknown?.status).toBe("failed");
    expect(unknown?.error?.code).toBe("EXTRACTOR_ERROR");
  });

  it("returns tracks from the requested provider only", async () => {
    manager.register(
      makeFakeProvider("youtube", { tracks: [makeTrack("youtube", "y1")] }),
    );
    manager.register(
      makeFakeProvider("spotify", { tracks: [makeTrack("spotify", "s1")] }),
    );
    const result = await manager.searchAll("x", { providers: ["spotify"] });
    expect(result.tracks.map((track) => track.id)).toEqual(["s1"]);
  });
});

describe("ExtractorManager track lookup", () => {
  let manager: ExtractorManager;

  beforeEach(() => {
    clearProviders();
    manager = new ExtractorManager();
    manager.register(makeFakeProvider("youtube"));
  });

  afterEach(() => {
    clearProviders();
  });

  it("resolves registered tracks", async () => {
    await expect(
      manager.getTrack({ provider: "youtube", id: "youtube-t1" }),
    ).resolves.toMatchObject({ id: "youtube-t1" });
  });

  it("returns null for missing tracks", async () => {
    await expect(
      manager.getTrack({ provider: "youtube", id: "missing" }),
    ).resolves.toBeNull();
  });

  it("rejects unregistered providers without cross-provider fallback", async () => {
    await expect(
      manager.getTrack({ provider: "spotify", id: "s1" }),
    ).rejects.toBeInstanceOf(TrackNotFoundError);
  });

  it("rejects unsupported lookup explicitly", async () => {
    manager.register(makeFakeProvider("deezer", { without: ["tracks.get"] }));
    await expect(
      manager.getTrack({ provider: "deezer", id: "d1" }),
    ).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });
});
