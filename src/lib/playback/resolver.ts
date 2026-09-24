/**
 * Capability-driven playback orchestration: TrackIdentity -> AudioSource.
 *
 * The PlaybackResolver answers ONLY "which known source can provide
 * playback?" It inspects an identity's source references IN ORDER and
 * delegates to the first source type with a registered resolver. Today
 * that means youtube; Deezer/Spotify sources are skipped as
 * metadata-only, producing a staged `match` failure ("no playable source
 * in this identity") rather than an attempted resolution.
 *
 * Separations enforced here:
 * - No matching: a Spotify/Deezer-only identity is NOT searched against
 *   YouTube. Matching to a YouTube candidate is orchestration above this
 *   layer (future TrackMatcher flows); this layer resolves exact sources.
 * - No merging: identities are never modified (no sources added, primary
 *   untouched, ordering preserved).
 * - No ranking: selection follows identity source order with the first
 *   resolvable source, not provider prestige.
 * - No persistence: AudioSources are returned, never stored.
 */

import type { AudioSource, SourceReference, TrackIdentity } from "@/lib/domain";
import { PlaybackResolutionError } from "@/lib/domain";

export interface SourcePlaybackResolver {
  /** The source type this resolver handles (today: "youtube"). */
  readonly source: SourceReference["source"];
  resolveSource(ref: SourceReference): Promise<AudioSource>;
}

export interface PlaybackResolver {
  /** True when the identity carries at least one resolvable source. */
  canResolve(identity: TrackIdentity): boolean;
  /** Resolves the first resolvable source in identity order. */
  resolve(identity: TrackIdentity): Promise<AudioSource>;
}

function identityRef(identity: TrackIdentity): { provider: string; providerTrackId: string } {
  return {
    provider: identity.primarySource.source,
    providerTrackId: identity.primarySource.id,
  };
}

export function createPlaybackResolver(
  resolvers: SourcePlaybackResolver[],
): PlaybackResolver {
  const bySource = new Map<SourceReference["source"], SourcePlaybackResolver>();
  for (const resolver of resolvers) {
    if (!bySource.has(resolver.source)) {
      bySource.set(resolver.source, resolver);
    }
  }

  function pick(identity: TrackIdentity): {
    resolver: SourcePlaybackResolver;
    ref: SourceReference;
  } | null {
    for (const ref of identity.sources) {
      const resolver = bySource.get(ref.source);
      if (resolver) {
        return { resolver, ref };
      }
    }
    return null;
  }

  return {
    canResolve(identity: TrackIdentity): boolean {
      return pick(identity) !== null;
    },

    async resolve(identity: TrackIdentity): Promise<AudioSource> {
      const selected = pick(identity);
      if (!selected) {
        throw new PlaybackResolutionError(
          identityRef(identity),
          "match",
          "No playable source in this identity",
        );
      }
      return selected.resolver.resolveSource(selected.ref);
    },
  };
}
