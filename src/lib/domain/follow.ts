import type { ProviderId } from "./common";

export interface Follow {
  id: string;
  userId: string;
  provider: ProviderId;
  artistId: string;
  createdAt: string;
}