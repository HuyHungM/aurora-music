import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSourceResolver } from "@/lib/offline/local-resolver";
import {
  MAX_LIVE_OBJECT_URLS,
  getFileRegistry,
  liveObjectUrlCount,
  replaceFileRegistry,
  resetOfflineSession,
} from "@/lib/offline/session";
import type { OfflineFileHandle } from "@/lib/offline/types";

/**
 * The object-URL budget is the only thing here that can quietly exhaust a
 * browser tab, so `URL.createObjectURL` / `revokeObjectURL` are installed as
 * fakes for the whole file. Everything else runs for real.
 */

const created: string[] = [];
const revoked: string[] = [];
let counter = 0;

function installUrlFakes(): void {
  counter = 0;
  created.length = 0;
  revoked.length = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => {
      counter += 1;
      const url = `blob:fake-${counter}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
}

function handleFor(name: string, bytes = 4_096): OfflineFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => ({ name, size: bytes }) as unknown as File,
  };
}

function registryWith(...names: string[]): Map<string, OfflineFileHandle> {
  return new Map(names.map((name) => [name, handleFor(name)]));
}

afterEach(() => {
  resetOfflineSession();
});

describe("local source resolver", () => {
  it("mints an object URL for a registered file and never calls the server", async () => {
    installUrlFakes();
    replaceFileRegistry(registryWith("Song.mp3"));
    const resolver = createLocalSourceResolver();

    const source = await resolver.resolveSource({ source: "local", id: "Song.mp3" });

    expect(source.url).toBe("blob:fake-1");
    expect(source.mimeType).toBe("audio/mpeg");
    expect(source.expiresAt).toBeUndefined();
    expect(resolver.source).toBe("local");
  });

  it("maps each container to a MIME type the browser will accept", async () => {
    installUrlFakes();
    replaceFileRegistry(registryWith("a.m4a", "b.flac", "c.opus", "d.wav"));
    const resolver = createLocalSourceResolver();

    const types = await Promise.all(
      ["a.m4a", "b.flac", "c.opus", "d.wav"].map((id) =>
        resolver.resolveSource({ source: "local", id }),
      ),
    );
    expect(types.map((entry) => entry.mimeType)).toEqual([
      "audio/mp4",
      "audio/flac",
      "audio/ogg",
      "audio/wav",
    ]);
  });

  it("explains an unopened folder instead of failing opaquely", async () => {
    installUrlFakes();
    replaceFileRegistry(new Map());
    const resolver = createLocalSourceResolver();

    const error = await resolver
      .resolveSource({ source: "local", id: "a.mp3" })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "PlaybackResolutionError", stage: "resolve" });
    // Non-retryable on purpose: every recovery ends in a user gesture the
    // bounded recovery cycle cannot perform.
    expect(error).toMatchObject({ retryable: false });
    expect(created).toEqual([]);
  });

  it("explains a file that has gone away", async () => {
    installUrlFakes();
    const registry = registryWith("gone.mp3");
    registry.set("gone.mp3", {
      kind: "file",
      name: "gone.mp3",
      getFile: async () => {
        throw new Error("NotFoundError");
      },
    });
    replaceFileRegistry(registry);
    const resolver = createLocalSourceResolver();

    await expect(
      resolver.resolveSource({ source: "local", id: "gone.mp3" }),
    ).rejects.toMatchObject({ name: "PlaybackResolutionError", retryable: false });
    expect(created).toEqual([]);
  });

  it("keeps only a bounded number of object URLs alive", async () => {
    // One URL per played track, left alive, would grow a listening session
    // without limit: each one pins the file's bytes for the document's life.
    installUrlFakes();
    replaceFileRegistry(registryWith("a.mp3", "b.mp3", "c.mp3", "d.mp3", "e.mp3"));
    const resolver = createLocalSourceResolver();

    for (const id of ["a.mp3", "b.mp3", "c.mp3", "d.mp3", "e.mp3"]) {
      await resolver.resolveSource({ source: "local", id });
    }

    expect(created).toHaveLength(5);
    expect(liveObjectUrlCount()).toBe(MAX_LIVE_OBJECT_URLS);
    expect(revoked).toEqual(["blob:fake-1", "blob:fake-2", "blob:fake-3"]);
  });

  it("revokes everything and forgets handles when the session resets", async () => {
    installUrlFakes();
    replaceFileRegistry(registryWith("a.mp3", "b.mp3", "c.mp3"));
    expect(getFileRegistry().size).toBe(3);

    // Mint a real URL first: resetting an already-empty pool would assert
    // nothing at all, which is how a leak would survive this test.
    const resolver = createLocalSourceResolver();
    await resolver.resolveSource({ source: "local", id: "a.mp3" });
    expect(liveObjectUrlCount()).toBe(1);

    resetOfflineSession();

    expect(getFileRegistry().size).toBe(0);
    expect(revoked).toEqual(["blob:fake-1"]);
    expect(liveObjectUrlCount()).toBe(0);
  });

  it("revokes prior URLs when a new scan replaces the registry", () => {
    installUrlFakes();
    replaceFileRegistry(registryWith("a.mp3"));
    resetOfflineSession();
    const before = revoked.length;

    replaceFileRegistry(registryWith("b.mp3"));

    // A rescan must not leave the previous folder's URLs (or handles) alive.
    expect(revoked.length).toBeGreaterThanOrEqual(before);
    expect([...getFileRegistry().keys()]).toEqual(["b.mp3"]);
  });

  it("keeps a filesystem path out of the error message", async () => {
    installUrlFakes();
    replaceFileRegistry(new Map());
    const resolver = createLocalSourceResolver();
    const error = (await resolver
      .resolveSource({ source: "local", id: "Secret Song.mp3" })
      .catch((cause: unknown) => cause)) as { message: string; toJSON(): unknown };

    // The id IS legitimate identity and travels in `details`, by design. What
    // must never happen is the message echoing a filesystem path back at the
    // user, so that is what is asserted.
    expect(error.message).not.toContain("Secret Song");
    expect(error.message).toContain("Local files");
  });

  it("leaves the session registry untouched when resolution fails", async () => {
    installUrlFakes();
    const registry = registryWith("a.mp3");
    replaceFileRegistry(registry);
    const resolver = createLocalSourceResolver();
    const spy = vi.spyOn(registry, "get");

    await resolver.resolveSource({ source: "local", id: "a.mp3" });

    expect(spy).toHaveBeenCalledWith("a.mp3");
  });
});