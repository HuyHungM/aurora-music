import type { ProviderId } from "./common";

export interface RecentlyPlayed {
  id: string;
  userId: string;
  provider: ProviderId;
  trackId: string;
  playedAt: string;
}