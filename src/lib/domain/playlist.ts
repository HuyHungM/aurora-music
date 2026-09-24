import type { ProviderId } from "./common";

export interface PlaylistItem {
  id: string;
  trackId: string;
  provider: ProviderId;
}

export interface Playlist {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  artwork?: string;
  items: PlaylistItem[];
  createdAt?: string;
  updatedAt?: string;
}