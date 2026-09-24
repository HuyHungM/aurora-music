import type { ProviderId } from "./common";

export interface Track {
  id: string;
  provider: ProviderId;
  providerTrackId?: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId?: string;
  albumName?: string;
  artworkUrl?: string;
  streamUrl?: string;
  previewUrl?: string;
  duration?: number;
  genres?: string[];
  releaseDate?: string;
  providerUrl?: string;
  explicit?: boolean;
  metadata?: Record<string, unknown>;
}