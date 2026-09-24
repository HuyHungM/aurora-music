import type { SourceType, TrackRef } from "./common";

/**
 * Provider-specific reference to a single external track resource.
 *
 * A SourceReference is the stable external identity for one provider only.
 * Cross-provider logical identity is composed later via TrackIdentity and
 * the TrackMatcher; individual extractors own exactly one source type and
 * must never fabricate references for other providers.
 */
export interface SourceReferenceMetadata {
  /** International Standard Recording Code, when the provider exposes it. */
  isrc?: string;
  /** YouTube channel identifier, when useful for matching. */
  channelId?: string;
  /** Stable provider album identifier, when available. */
  albumId?: string;
  /** Stable provider artist identifier, when available. */
  artistId?: string;
}

export interface SourceReference {
  source: SourceType;
  /** Stable provider-scoped track id (videoId / trackId). Never a stream URL. */
  id: string;
  /** Canonical provider URL for display/linking. Never a stream URL. */
  url?: string;
  metadata?: SourceReferenceMetadata;
}

const SOURCE_TYPES: readonly SourceType[] = ["youtube", "spotify", "deezer"];

/** Type guard for the closed production source set. */
export function isSourceType(value: unknown): value is SourceType {
  return (
    typeof value === "string" &&
    (SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/** Stable `source:id` key for maps, dedupe sets, and logs (no secrets). */
export function sourceReferenceKey(ref: Pick<SourceReference, "source" | "id">): string {
  return `${ref.source}:${ref.id}`;
}

/** Bridges an engine source reference to the existing Aurora TrackRef. */
export function toTrackRef(ref: Pick<SourceReference, "source" | "id">): TrackRef {
  return { provider: ref.source, providerTrackId: ref.id };
}

/** Bridges the existing Aurora TrackRef to an engine source reference. */
export function fromTrackRef(ref: TrackRef): SourceReference | null {
  if (!isSourceType(ref.provider)) {
    return null;
  }
  if (typeof ref.providerTrackId !== "string" || ref.providerTrackId.length === 0) {
    return null;
  }
  return { source: ref.provider, id: ref.providerTrackId };
}
