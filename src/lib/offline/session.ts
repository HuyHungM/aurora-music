/**
 * Session-scoped state for the offline source: which files the current page
 * session can open, and which object URLs are alive. CLIENT-ONLY.
 *
 * WHY THIS IS A MODULE SINGLETON. The playback resolver is constructed ONCE,
 * in `PlayerHost`, and the /offline page is a different component. Something
 * has to carry the scan's file handles from one to the other; a module-level
 * map is that something, and it is exactly as long-lived as the promise it
 * makes: a handle registered by a scan on this page load is reachable for
 * this page load, and no longer.
 *
 * OBJECT URL LIFECYCLE. `URL.createObjectURL` pins the underlying bytes for
 * the lifetime of the document, so leaving one per played track would grow a
 * music session without bound. A small ring of live URLs is kept instead:
 * the most recent couple stay valid (which covers the old element still
 * flushing when a new source loads), and the oldest are revoked. Everything
 * is revoked when the session resets.
 */

import type { OfflineFileHandle } from "./types";

/** How many object URLs may be alive at once. See the file header. */
export const MAX_LIVE_OBJECT_URLS = 2;

let fileRegistry = new Map<string, OfflineFileHandle>();
let liveObjectUrls: string[] = [];

/**
 * The `URL` surface this module needs.
 *
 * Read from `globalThis` rather than `window`: `URL` is a global in the
 * browser AND in Node, so this stays exercisable under a plain Node test
 * environment, and a `window`-only lookup would silently no-op there and make
 * the object-URL budget untested — exactly the thing that can exhaust a tab.
 */
function urlSurface(): { revokeObjectURL(url: string): void } | null {
  const candidate = (globalThis as { URL?: { revokeObjectURL?: unknown } }).URL;
  return candidate && typeof candidate.revokeObjectURL === "function"
    ? (candidate as { revokeObjectURL(url: string): void })
    : null;
}

/**
 * The live file registry. Replaced wholesale by {@link resetOfflineSession}
 * rather than cleared, so a scan in flight cannot repopulate a registry the
 * user has already moved on from.
 */
export function getFileRegistry(): Map<string, OfflineFileHandle> {
  return fileRegistry;
}

/**
 * Registers handles from a scan, DISCARDING any previous registry. Called once
 * per scan so a rescan never mixes two folders' files together.
 */
export function replaceFileRegistry(entries: Map<string, OfflineFileHandle>): void {
  revokeAllObjectUrls();
  fileRegistry = entries;
}

/** Mints an object URL for a file and enforces the live-URL budget. */
export function createObjectUrlFor(file: File): string {
  const url = URL.createObjectURL(file);
  liveObjectUrls.push(url);
  while (liveObjectUrls.length > MAX_LIVE_OBJECT_URLS) {
    const oldest = liveObjectUrls.shift();
    if (oldest !== undefined) {
      urlSurface()?.revokeObjectURL(oldest);
    }
  }
  return url;
}

function revokeAllObjectUrls(): void {
  const env = urlSurface();
  for (const url of liveObjectUrls) {
    env?.revokeObjectURL(url);
  }
  liveObjectUrls = [];
}

/**
 * Drops every registered handle and revokes every object URL. Called when the
 * user disconnects a folder, and available as a test hook.
 */
export function resetOfflineSession(): void {
  revokeAllObjectUrls();
  fileRegistry = new Map();
}

/** Live object URL count. Exposed for tests that assert the budget. */
export function liveObjectUrlCount(): number {
  return liveObjectUrls.length;
}