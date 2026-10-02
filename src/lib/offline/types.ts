/**
 * Structural types for the offline (local-file) source. SERVER-ONLY TYPES,
 * CLIENT-ONLY USAGE.
 *
 * These are deliberately hand-written and structural rather than taken from
 * `lib.dom`. The File System Access API types ship unevenly across TypeScript
 * releases, and the module that consumes them is the one place where a
 * runtime capability has to be probed anyway — so the shapes the offline
 * feature actually depends on are declared here, and a test double can
 * satisfy them without a browser. This mirrors `UndiciEgressModule` in
 * `providers/youtube/innertube/egress.ts`.
 */

/** A single file the user granted us access to. */
export interface OfflineFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

/** A directory the user granted us read access to. */
export interface OfflineDirectoryHandle {
  kind: "directory";
  name: string;
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  values(): AsyncIterableIterator<OfflineHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OfflineFileHandle>;
}

export type OfflineHandle = OfflineFileHandle | OfflineDirectoryHandle;

/** `"granted" | "denied" | "prompt"`, or `null` when the API cannot say. */
export type OfflinePermissionState = PermissionState | null;

/**
 * What the offline source can do right now.
 *
 * Every state is a real, reachable outcome — not a loading flag. In
 * particular `needs-permission` is an ordinary state (it is what a returning
 * user sees after a browser restart), not an error, and `unavailable` is the
 * single honest answer for "the folder or its permission is gone", because
 * recovering from it needs a user gesture the app cannot perform alone.
 */
export type OfflineFolderState =
  /** File System Access API missing (Firefox, Safari, older Chromium). */
  | "unsupported"
  /** Nothing chosen yet. */
  | "empty"
  /** A folder is remembered but needs a read grant before it can be scanned. */
  | "needs-permission"
  /** Folder readable; files are scannable. */
  | "ready"
  /** The user explicitly refused read access. */
  | "denied"
  /** The handle is gone (folder removed, moved, or revoked by the browser). */
  | "unavailable";

export interface OfflineFolderStatus {
  state: OfflineFolderState;
  /** Folder name for display, when one is known. Never a filesystem path. */
  folderName: string | null;
}

/** One audio file discovered by a scan. Metadata only — never bytes. */
export interface OfflineTrackFile {
  /** Stable identity: the file's path relative to the granted folder. */
  id: string;
  /** File name including extension. */
  name: string;
  /** Containing folder name relative to the granted folder, when nested. */
  folder: string | null;
  /** Size in bytes, when the platform could report it. */
  size?: number;
  /** Last-modified epoch millis, when the platform could report it. */
  lastModified?: number;
}