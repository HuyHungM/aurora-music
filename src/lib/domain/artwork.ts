/**
 * Canonical artwork contract for the Music Engine.
 *
 * Semantic sizes only. Provider-specific thumbnail structures (YouTube
 * thumbnail maps, Spotify 64/300/640 arrays, Deezer sized URLs) must be
 * normalized into these fields by the provider normalization layer.
 * Raw provider artwork payloads stay in the provider DTO layer and must
 * never leak into this domain model.
 */
export type ArtworkSize = "small" | "medium" | "large";

export interface Artwork {
  small?: string;
  medium?: string;
  large?: string;
}

const ARTWORK_PREFERENCE: Record<ArtworkSize, ArtworkSize[]> = {
  small: ["small", "medium", "large"],
  medium: ["medium", "large", "small"],
  large: ["large", "medium", "small"],
};

/**
 * Resolves the best available artwork URL for a preferred size,
 * falling back to the remaining sizes in a deterministic order.
 */
export function resolveArtworkUrl(
  artwork: Artwork | undefined | null,
  preferred: ArtworkSize = "medium",
): string | undefined {
  if (!artwork) {
    return undefined;
  }
  for (const size of ARTWORK_PREFERENCE[preferred]) {
    const url = artwork[size];
    if (typeof url === "string" && url.length > 0) {
      return url;
    }
  }
  return undefined;
}

/** Returns true when at least one semantic artwork URL is present. */
export function hasArtwork(artwork: Artwork | undefined | null): boolean {
  return resolveArtworkUrl(artwork) !== undefined;
}
