import type { ProviderId } from "./common";

export interface Like {
  id: string;
  userId: string;
  provider: ProviderId;
  trackId: string;
  createdAt: string;
}