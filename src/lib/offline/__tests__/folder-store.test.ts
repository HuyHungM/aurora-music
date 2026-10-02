import { describe, expect, it } from "vitest";
import {
  clearStoredFolder,
  folderStatus,
  readFolderPermission,
  readStoredFolder,
  requestFolderPermission,
  writeStoredFolder,
} from "@/lib/offline/folder-store";
import { createMemoryStore } from "@/lib/offline/storage";
import type {
  OfflineDirectoryHandle,
  OfflineFileHandle,
} from "@/lib/offline/types";

/**
 * Fakes are structural, exactly like the real handles. That is the point of
 * declaring them in `types.ts`: this suite runs without a browser and without
 * a dev dependency that would fake IndexedDB.
 */
function directory(
  name: string,
  permission: PermissionState | Error = "granted",
  entries: Array<OfflineDirectoryHandle | OfflineFileHandle> = [],
): OfflineDirectoryHandle {
  return {
    kind: "directory",
    name,
    queryPermission: async () => {
      if (permission instanceof Error) throw permission;
      return permission;
    },
    requestPermission: async () => {
      if (permission instanceof Error) throw permission;
      return permission;
    },
    values: async function* () {
      for (const entry of entries) yield entry;
    },
    getFileHandle: async () => {
      throw new Error("not used");
    },
  };
}

function file(name: string, size = 1024): OfflineFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () =>
      ({ name, size, lastModified: 1_700_000_000_000 }) as unknown as File,
  };
}

describe("offline folder store", () => {
  it("round-trips the granted handle", async () => {
    const store = createMemoryStore();
    const handle = directory("Music", "granted", [file("a.mp3")]);

    await writeStoredFolder(store, handle);
    const restored = await readStoredFolder(store);

    expect(restored).not.toBeNull();
    expect(restored?.name).toBe("Music");
  });

  it("treats a missing or unusable stored value as no folder", async () => {
    const store = createMemoryStore();
    expect(await readStoredFolder(store)).toBeNull();

    // A structured clone can come back as something unexpected. Failing closed
    // means the user re-picks rather than a scan throwing deep inside a walk.
    await store.set("folder", { kind: "not-a-directory" });
    expect(await readStoredFolder(store)).toBeNull();

    await store.set("folder", { kind: "directory" });
    expect(await readStoredFolder(store)).toBeNull();
  });

  it("reports no folder rather than throwing when the store is unreadable", async () => {
    const broken = {
      get: async () => {
        throw new Error("quota exceeded");
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    expect(await readStoredFolder(broken)).toBeNull();
    // Forgetting is best-effort; a store that cannot forget must not throw
    // into the UI.
    await expect(clearStoredFolder(broken)).resolves.toBeUndefined();
  });

  it("forgets a stored folder", async () => {
    const store = createMemoryStore();
    await writeStoredFolder(store, directory("Music"));
    await clearStoredFolder(store);
    expect(await readStoredFolder(store)).toBeNull();
  });
});

describe("offline folder status", () => {
  it("distinguishes the three unhappy states instead of collapsing them", async () => {
    // "Needs permission" is an ORDINARY returning-user state, not an error,
    // and "unavailable" is a lost grant. Merging them is what makes a
    // revoked-permission UI lie about what happened.
    expect(await folderStatus(null)).toEqual({ state: "empty", folderName: null });
    expect((await folderStatus(directory("M", "prompt"))).state).toBe("needs-permission");
    expect((await folderStatus(directory("M", "denied"))).state).toBe("denied");
    expect((await folderStatus(directory("M", "granted"))).state).toBe("ready");
  });

  it("carries the folder name for display", async () => {
    expect((await folderStatus(directory("Live Sets", "prompt"))).folderName).toBe("Live Sets");
  });

  it("reports denied when the permission query itself fails", async () => {
    const handle = directory("M", new Error("SecurityError"));
    expect(await readFolderPermission(handle)).toBe("denied");
    expect(await requestFolderPermission(handle)).toBe("denied");
    expect((await folderStatus(handle)).state).toBe("denied");
  });

  it("does not lock a user out when permission cannot be queried", async () => {
    // No queryPermission means we do not know, and refusing on a guess would
    // hide a folder the user can actually open.
    const opaque: OfflineDirectoryHandle = {
      kind: "directory",
      name: "M",
      values: async function* () {},
      getFileHandle: async () => {
        throw new Error("not used");
      },
    };
    expect(await readFolderPermission(opaque)).toBe("granted");
    expect((await folderStatus(opaque)).state).toBe("ready");
  });

  it("treats a refused re-grant as denied rather than an exception", async () => {
    const handle = directory("M", "denied");
    expect(await requestFolderPermission(handle)).toBe("denied");
  });
});

describe("offline file handles", () => {
  it("exposes name and size through getFile", async () => {
    const handle = file("song.mp3", 2048);
    const blob = await handle.getFile();
    expect(blob.name).toBe("song.mp3");
    expect(blob.size).toBe(2048);
  });
});