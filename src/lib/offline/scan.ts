/**
 * Offline folder scanning and the in-memory file registry. CLIENT-ONLY.
 *
 * SCAN ON DEMAND, ALWAYS. Nothing here runs at import or on mount. A folder is
 * walked only when the user opens /offline, because a walk is real work
 * against the user's disk and Aurora has no reason to do it for a page the
 * user is not looking at.
 *
 * THE REGISTRY IS SESSION STATE, NOT PERSISTENCE. The scan records a
 * `FileSystemFileHandle` per track id in a module-level map so the playback
 * resolver can find the file again when the queue reaches it. It is
 * deliberately NOT persisted: a handle is only meaningful while the page
 * session lives, and pretending otherwise would hand the resolver a reference
 * that resolves to a file the app can no longer open. After a reload the user
 * re-opens /offline and scans again, which is the behaviour that is true
 * rather than convenient.
 *
 * NO AUDIO IS COPIED. `getFile()` is called to read a file's metadata, or to
 * hand the browser a `File` it streams from. Nothing is uploaded, and no
 * server route ever sees any of this.
 */

import type {
  OfflineDirectoryHandle,
  OfflineFileHandle,
  OfflineHandle,
  OfflineTrackFile,
} from "./types";
import { isAudioFile } from "./tracks";

/** How deep the walk descends. Bounds cycles and pathological trees. */
export const MAX_SCAN_DEPTH = 6;
/** Upper bound on discovered files, so one huge folder cannot hang the page. */
export const MAX_SCAN_FILES = 5_000;

export interface ScanResult {
  files: OfflineTrackFile[];
  /** True when {@link MAX_SCAN_FILES} was reached and the walk stopped early. */
  truncated: boolean;
}

function isDirectory(handle: OfflineHandle): handle is OfflineDirectoryHandle {
  return handle.kind === "directory";
}

function isFile(handle: OfflineHandle): handle is OfflineFileHandle {
  return handle.kind === "file";
}

function joinPath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Display name of a directory's own relative path, or null at the root.
 *
 * Used as the "album" hint for artist-less filenames. It takes the LAST
 * segment of the DIRECTORY path, not of the file's path: for `Album/song.mp3`
 * that is "Album", and a file at the folder root has no folder at all. Getting
 * this wrong silently loses the only artist signal a filename-free file has.
 */
function folderDisplayName(directoryPath: string): string | null {
  if (directoryPath === "") {
    return null;
  }
  const slash = directoryPath.lastIndexOf("/");
  return slash === -1 ? directoryPath : directoryPath.slice(slash + 1);
}

async function statOf(handle: OfflineFileHandle): Promise<{ size?: number; lastModified?: number }> {
  try {
    const file = await handle.getFile();
    return { size: file.size, lastModified: file.lastModified };
  } catch {
    // A file that vanished between the walk and the stat is still a real
    // track the user can see; it simply has no size. The scan does not fail.
    return {};
  }
}

/**
 * Walks one directory, collecting audio files and registering their handles.
 *
 * Errors from a single subdirectory are skipped rather than fatal: one
 * unreadable folder in a music library should cost the user that folder, not
 * the whole page.
 */
async function walk(
  directory: OfflineDirectoryHandle,
  prefix: string,
  depth: number,
  collected: OfflineTrackFile[],
  registry: Map<string, OfflineFileHandle>,
  limits: { truncated: boolean },
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || collected.length >= MAX_SCAN_FILES) {
    limits.truncated = true;
    return;
  }
  let entries: OfflineHandle[];
  try {
    entries = [];
    for await (const entry of directory.values()) {
      entries.push(entry);
      if (entries.length >= MAX_SCAN_FILES) {
        limits.truncated = true;
        break;
      }
    }
  } catch {
    return;
  }

  for (const entry of entries) {
    if (collected.length >= MAX_SCAN_FILES) {
      limits.truncated = true;
      return;
    }
    if (isDirectory(entry)) {
      await walk(entry, joinPath(prefix, entry.name), depth + 1, collected, registry, limits);
      continue;
    }
    if (!isFile(entry) || !isAudioFile(entry.name)) {
      continue;
    }
    const id = joinPath(prefix, entry.name);
    collected.push({
      id,
      name: entry.name,
      folder: folderDisplayName(prefix),
      ...(await statOf(entry)),
    });
    registry.set(id, entry);
  }
}

/**
 * Scans the granted folder and registers every audio file it finds.
 *
 * Returns the discovered files sorted the way a listener expects to read a
 * track list: by folder, then by name. Name sorting is left to the platform
 * (`localeCompare` with numeric collation) so `Track 2` precedes `Track 10`
 * instead of following it.
 */
export async function scanOfflineFolder(
  directory: OfflineDirectoryHandle,
  registry: Map<string, OfflineFileHandle> = new Map(),
): Promise<ScanResult> {
  const collected: OfflineTrackFile[] = [];
  const limits = { truncated: false };
  await walk(directory, "", 0, collected, registry, limits);
  collected.sort((a, b) => {
    const folderA = a.folder ?? "";
    const folderB = b.folder ?? "";
    if (folderA !== folderB) {
      return folderA.localeCompare(folderB);
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return { files: collected, truncated: limits.truncated };
}

/**
 * Reads one registered file. Returns null when the id is unknown or the file
 * has gone away underneath us (deleted, moved, or the grant revoked), which is
 * the honest answer rather than a thrown error the player would surface as a
 * crash.
 */
export async function readRegisteredFile(
  registry: Map<string, OfflineFileHandle>,
  id: string,
): Promise<File | null> {
  const handle = registry.get(id);
  if (!handle) {
    return null;
  }
  try {
    return await handle.getFile();
  } catch {
    registry.delete(id);
    return null;
  }
}