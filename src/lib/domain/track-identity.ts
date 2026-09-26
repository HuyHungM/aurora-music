import type { Album } from "./album";
import type { Artist } from "./artist";
import type { Artwork } from "./artwork";
import type { TrackRef } from "./common";
import type { SourceReference } from "./source-reference";
import { toTrackRef } from "./source-reference";

/**
 * Logical track composed of one or more provider references.
 *
 * Identity rules (frozen):
 * - `id` is the Aurora internal identity (existing cuid() strategy).
 * - External identity is always `TrackRef` (provider + providerTrackId).
 * - Never derive the internal primary key from a provider hash.
 * - `sources` grows ONLY through explicit merging of provider-supplied
 *   references (Phase 06). Automatic cross-provider matching that invents
 *   references is forbidden here and belongs to the future TrackMatcher.
 */
export interface TrackIdentity {
  /** Aurora internal id (cuid). Stable across providers. */
  id: string;
  title: string;
  artists: Artist[];
  album?: Album;
  /** Canonical milliseconds. Undefined when the provider reports none. */
  durationMs?: number;
  artwork?: Artwork;
  /** All known provider references for this logical track. */
  sources: SourceReference[];
  /** Preferred reference for playback resolution. */
  primarySource: SourceReference;
  /**
   * Provider-supplied descriptive metadata (explicit flags, live state,
   * disc/track numbers). Never identity, never stream URLs, never raw
   * provider payloads.
   */
  metadata?: Record<string, unknown>;
}

/** Stable external identity of the preferred playback source. */
export function primaryTrackRef(identity: Pick<TrackIdentity, "primarySource">): TrackRef {
  return toTrackRef(identity.primarySource);
}

/** Finds the reference for a given source, if the identity includes it. */
export function findSourceReference(
  identity: Pick<TrackIdentity, "sources">,
  source: SourceReference["source"],
): SourceReference | undefined {
  return identity.sources.find((candidate) => candidate.source === source);
}

/**
 * Every canonical key an identity can be addressed by, not just its primary
 * source. Live in the domain layer because de-duplication and
 * already-played memory must agree on what "the same track" means no matter
 * which subsystem is asking — radio and Phase 47 queue continuation share
 * this so neither can drift from the other.
 */
export function identityKeys(
  identity: Pick<TrackIdentity, "sources">,
): Set<string> {
  return new Set(identity.sources.map((source) => `${source.source}:${source.id}`));
}
