import type { ProviderId } from "./common";
import type { Track } from "./track";

export interface Album {
  id: string;
  provider: ProviderId;
  providerAlbumId?: string;
  title: string;
  artistId: string;
  artistName: string;
  artwork?: string;
  releaseDate?: string;
  tracks?: Track[];
}