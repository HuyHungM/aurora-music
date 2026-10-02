import { describe, expect, it } from "vitest";
import {
  MAX_SCAN_DEPTH,
  MAX_SCAN_FILES,
  readRegisteredFile,
  scanOfflineFolder,
} from "@/lib/offline/scan";
import type {
  OfflineDirectoryHandle,
  OfflineFileHandle,
  OfflineHandle,
} from "@/lib/offline/types";

function file(name: string, size = 1024): OfflineFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () =>
      ({ name, size, lastModified: 1_700_000_000_000 }) as unknown as File,
  };
}

function directory(name: string, entries: OfflineHandle[]): OfflineDirectoryHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      for (const entry of entries) yield entry;
    },
    getFileHandle: async () => {
      throw new Error("not used");
    },
  };
}

describe("offline folder scan", () => {
  it("collects audio files and ignores everything else", async () => {
    const root = directory("Music", [
      file("b.mp3"),
      file("cover.jpg"),
      file("notes.txt"),
      file("a.flac"),
    ]);
    const registry = new Map<string, OfflineFileHandle>();

    const result = await scanOfflineFolder(root, registry);

    expect(result.files.map((entry) => entry.name)).toEqual(["a.flac", "b.mp3"]);
    expect(result.truncated).toBe(false);
    // Handles are registered so the resolver can find the file again by id.
    expect(registry.size).toBe(2);
    expect(registry.has("a.flac")).toBe(true);
  });

  it("walks subfolders and keys files by their relative path", async () => {
    const root = directory("Music", [
      file("root.mp3"),
      directory("Album", [file("inner.mp3"), file("art.png")]),
    ]);

    const result = await scanOfflineFolder(root);

    expect(result.files.map((entry) => entry.id).sort()).toEqual([
      "Album/inner.mp3",
      "root.mp3",
    ]);
    expect(result.files.find((entry) => entry.id === "Album/inner.mp3")?.folder).toBe("Album");
    expect(result.files.find((entry) => entry.id === "root.mp3")?.folder).toBeNull();
  });

  it("records size and mtime when the platform can report them", async () => {
    const result = await scanOfflineFolder(directory("Music", [file("a.mp3", 4096)]));
    expect(result.files[0]).toMatchObject({ size: 4096, lastModified: 1_700_000_000_000 });
  });

  it("keeps a file whose metadata cannot be read", async () => {
    // A file that vanishes mid-walk is still a real track the user can see; it
    // simply has no size. Failing the whole scan over one stat would be worse.
    const vanishing: OfflineFileHandle = {
      kind: "file",
      name: "gone.mp3",
      getFile: async () => {
        throw new Error("NotFoundError");
      },
    };
    const result = await scanOfflineFolder(directory("Music", [vanishing]));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.size).toBeUndefined();
  });

  it("skips one unreadable subfolder instead of failing the whole scan", async () => {
    const broken: OfflineDirectoryHandle = {
      kind: "directory",
      name: "Locked",
      values: async function* () {
        throw new Error("NotAllowedError");
      },
      getFileHandle: async () => {
        throw new Error("not used");
      },
    };
    const root = directory("Music", [file("visible.mp3"), broken]);

    const result = await scanOfflineFolder(root);

    expect(result.files.map((entry) => entry.name)).toEqual(["visible.mp3"]);
  });

  it("stops at the depth bound rather than walking forever", async () => {
    // A cycle through symlinked folders would otherwise recurse without end.
    let deep = directory("level-40", [file("deep.mp3")]);
    for (let index = 0; index < 60; index += 1) {
      deep = directory(`level-${index}`, [deep]);
    }
    const result = await scanOfflineFolder(deep);
    expect(result.files.length).toBeLessThanOrEqual(1);
    expect(result.truncated).toBe(true);
    expect(MAX_SCAN_DEPTH).toBeGreaterThan(0);
  });

  it("stops at the file bound and says so", async () => {
    const many = Array.from({ length: MAX_SCAN_FILES + 25 }, (_, index) =>
      file(`track-${index}.mp3`),
    );
    const result = await scanOfflineFolder(directory("Music", many));
    expect(result.files.length).toBeLessThanOrEqual(MAX_SCAN_FILES);
    expect(result.truncated).toBe(true);
  });

  it("sorts so Track 2 precedes Track 10", async () => {
    const result = await scanOfflineFolder(
      directory("Music", [file("Track 10.mp3"), file("Track 2.mp3"), file("Track 1.mp3")]),
    );
    expect(result.files.map((entry) => entry.name)).toEqual([
      "Track 1.mp3",
      "Track 2.mp3",
      "Track 10.mp3",
    ]);
  });
});

describe("registered file reading", () => {
  it("returns null for an unknown id instead of throwing", async () => {
    expect(await readRegisteredFile(new Map(), "missing.mp3")).toBeNull();
  });

  it("drops a handle whose file has gone away", async () => {
    const registry = new Map<string, OfflineFileHandle>();
    registry.set("gone.mp3", {
      kind: "file",
      name: "gone.mp3",
      getFile: async () => {
        throw new Error("NotFoundError");
      },
    });
    expect(await readRegisteredFile(registry, "gone.mp3")).toBeNull();
    // Evicted, so a later attempt does not keep re-trying a dead handle.
    expect(registry.has("gone.mp3")).toBe(false);
  });

  it("returns the file for a live handle", async () => {
    const registry = new Map<string, OfflineFileHandle>();
    registry.set("a.mp3", file("a.mp3", 10));
    const blob = await readRegisteredFile(registry, "a.mp3");
    expect(blob?.name).toBe("a.mp3");
  });
});