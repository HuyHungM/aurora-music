import type { ProviderId } from "./common";

export interface PlaylistItem {
  id: string;
  trackId: string;
  provider: ProviderId;
}

/**
 * Phase 47 sharing model. Deliberately two states: "private" (owner only)
 * and "shared" (readable through a public share token). No public /
 * unlisted / friends-only / collaborative / password states.
 */
export type PlaylistVisibility = "private" | "shared";

export interface Playlist {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  /**
   * Custom artwork URL. Reuses the pre-existing column; `undefined` means
   * "no custom artwork" and every surface renders the default artwork.
   */
  artwork?: string;
  visibility: PlaylistVisibility;
  /**
   * Owner-facing share token. Never serialized to a shared viewer — see
   * `SharedPlaylist`, which is the only shape the public route returns.
   */
  shareToken?: string;
  items: PlaylistItem[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Public read model for a shared playlist (Phase 47). Structurally omits
 * `ownerId` and `shareToken` so no public code path can reach the owner's
 * identity or the reusable token, even by accident. Attribution is a
 * display-only display name.
 */
export interface SharedPlaylist {
  title: string;
  description?: string;
  artwork?: string;
  ownerDisplayName: string;
  items: PlaylistItem[];
}
