/**
 * Persistence and status for the one offline thing Aurora remembers: WHICH
 * FOLDER the user granted. CLIENT-ONLY.
 *
 * The handle is stored through an injected {@link OfflineKeyValueStore} so
 * the persistence logic is testable without IndexedDB, and so the "no audio
 * ever crosses this boundary" property is structural rather than a promise:
 * the only value written here is a directory handle.
 *
 * PERMISSION IS NOT REQUESTED HERE. `requestPermission` is only honoured from
 * a user gesture, so asking for it is the caller's job at the moment of a
 * click (see `requestFolderPermission`).
 */

import type {
  OfflineDirectoryHandle,
  OfflineFolderStatus,
  OfflinePermissionState,
} from "./types";
import type { OfflineKeyValueStore } from "./storage";

const FOLDER_KEY = "folder";

/**
 * Accepts a stored value only if it still looks like a directory handle.
 *
 * A stored value is not trusted input: IndexedDB can return `undefined` for
 * a key that was never written, and a structured clone of a handle from a
 * different build can come back with an unexpected shape. Failing closed here
 * means a bad value is treated as "no folder chosen" — the user re-picks — and
 * never as a handle that would throw deep inside a scan.
 */
function asDirectoryHandle(value: unknown): OfflineDirectoryHandle | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<OfflineDirectoryHandle>;
  if (candidate.kind !== "directory") {
    return null;
  }
  if (typeof candidate.name !== "string" || typeof candidate.values !== "function") {
    return null;
  }
  if (typeof candidate.getFileHandle !== "function") {
    return null;
  }
  return candidate as OfflineDirectoryHandle;
}

/** Reads the remembered folder, or null when none is stored or it is unusable. */
export async function readStoredFolder(
  store: OfflineKeyValueStore,
): Promise<OfflineDirectoryHandle | null> {
  try {
    return asDirectoryHandle(await store.get(FOLDER_KEY));
  } catch {
    // A store that cannot be read (private mode, quota, a failed upgrade) is
    // indistinguishable from "no folder chosen" for the user, and treating it
    // as such keeps the page working instead of erroring on load.
    return null;
  }
}

/** Remembers the granted folder so the next visit can offer to re-open it. */
export async function writeStoredFolder(
  store: OfflineKeyValueStore,
  handle: OfflineDirectoryHandle,
): Promise<void> {
  await store.set(FOLDER_KEY, handle);
}

/** Forgets the folder (the user chose to disconnect it). */
export async function clearStoredFolder(store: OfflineKeyValueStore): Promise<void> {
  try {
    await store.delete(FOLDER_KEY);
  } catch {
    // Nothing to do: a folder we cannot forget is a folder the user will be
    // offered again, which the UI already handles as "needs permission".
  }
}

/**
 * Reads the current permission without prompting. Safe to call anywhere;
 * `requestFolderPermission` is the one that needs a gesture.
 */
export async function readFolderPermission(
  handle: OfflineDirectoryHandle,
): Promise<OfflinePermissionState> {
  if (typeof handle.queryPermission !== "function") {
    // No way to ask means we do not know. Assume the best and let the scan
    // surface a real refusal, rather than locking a user out on a guess.
    return "granted";
  }
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

/**
 * Prompts for read access. MUST be called from a user gesture; browsers
 * reject the request otherwise. Returns the resulting state, never throws for
 * a refusal — a denial is an outcome the UI renders, not an error.
 */
export async function requestFolderPermission(
  handle: OfflineDirectoryHandle,
): Promise<OfflinePermissionState> {
  if (typeof handle.requestPermission !== "function") {
    return "granted";
  }
  try {
    return await handle.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

/**
 * Derives the user-facing folder state. The three unhappy states are kept
 * distinct on purpose: `needs-permission` is a one-click recovery,
 * `denied` is a decision the user made, and `unavailable` means the grant is
 * gone entirely. Collapsing them would make a revoked grant look like a
 * refusal.
 */
export async function folderStatus(
  handle: OfflineDirectoryHandle | null,
): Promise<OfflineFolderStatus> {
  if (!handle) {
    return { state: "empty", folderName: null };
  }
  const permission = await readFolderPermission(handle);
  const folderName = typeof handle.name === "string" && handle.name.length > 0 ? handle.name : null;
  if (permission === "prompt") {
    return { state: "needs-permission", folderName };
  }
  if (permission === "denied") {
    return { state: "denied", folderName };
  }
  // "granted" is a claim, not a proof. The scan is what proves it, and it
  // maps a refusal back to `unavailable` through `scanOfflineFolder`.
  return { state: "ready", folderName };
}