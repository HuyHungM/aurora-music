/**
 * Offline (local-file) source capability probe. CLIENT-ONLY.
 *
 * Everything here is feature detection. Nothing is assumed true, and the
 * answer is a typed state rather than a boolean so a caller cannot render a
 * control that cannot work (RULE 34): `showDirectoryPicker` is Chromium-only,
 * so on Firefox and Safari this module reports `unsupported` and the UI shows
 * honest copy instead of a dead button.
 *
 * NOTE this is a different question from `pwa/platform.ts`'s
 * `offlineAudio: false`. That field says Aurora does not DOWNLOAD provider
 * media, which remains true and forbidden. Reading files the user already
 * has is a different capability and is probed here.
 */

import type { OfflineDirectoryHandle } from "./types";

/** The window surface this module reads. Narrow on purpose, and testable. */
export interface OfflineWindow {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<OfflineDirectoryHandle>;
  indexedDB?: IDBFactory;
}

function offlineWindow(): OfflineWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as OfflineWindow);
}

/** True when the browser can hand us a directory handle at all. */
export function supportsDirectoryPicker(): boolean {
  return typeof offlineWindow()?.showDirectoryPicker === "function";
}

/** True when a handle can survive a reload (needed for folder persistence). */
export function supportsHandleStorage(): boolean {
  return typeof offlineWindow()?.indexedDB === "object" && offlineWindow()?.indexedDB !== null;
}

/**
 * Asks the user for a folder. MUST be called from a user gesture: the API
 * rejects or silently fails outside one, so this is deliberately not
 * reachable from a mount effect.
 */
export async function pickDirectory(): Promise<OfflineDirectoryHandle | null> {
  const picker = offlineWindow()?.showDirectoryPicker;
  if (typeof picker !== "function") {
    return null;
  }
  // `AbortError` is what a user dismissing the native dialog produces. It is
  // not a failure and must not surface as one; anything else is real.
  try {
    const handle = await picker.call(window, { mode: "read" });
    return handle ?? null;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return null;
    }
    throw error;
  }
}