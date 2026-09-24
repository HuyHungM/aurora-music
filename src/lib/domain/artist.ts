import type { ProviderId } from "./common";

export interface Artist {
  id: string;
  provider: ProviderId;
  providerArtistId?: string;
  name: string;
  image?: string;
  bio?: string;
  genres?: string[];
}