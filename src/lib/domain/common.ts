export type ProviderId = string;

/**
 * Closed production music-source set for the Music Engine.
 * Canonical definition lives here so both the existing TrackRef contract
 * and the new SourceReference contract share one source vocabulary.
 */
export type SourceType = "youtube" | "spotify" | "deezer";

export interface TrackRef {
  provider: string;
  providerTrackId: string;
}