import type { Track, TrackIdentity } from "@/lib/domain";
import { resolveArtworkUrl } from "@/lib/domain";

/**
 * Whether a canonical identity is the same resource as a legacy track row.
 * Compares the identity's primary source against the row's provider
 * identity (providerTrackId wins, id is the fallback), mirroring the
 * legacy trackKey/sameTrack semantics without converting objects.
 */
export function isIdentityOfTrack(
  identity: TrackIdentity | null | undefined,
  track: Pick<Track, "provider" | "id"> & { providerTrackId?: string } | null | undefined,
): boolean {
  if (!identity || !track) {
    return false;
  }
  const trackId = track.providerTrackId ?? track.id;
  return (
    identity.primarySource.source === track.provider &&
    identity.primarySource.id === trackId
  );
}

/**
 * Presentation adapter: canonical search group -> legacy row/queue Track.
 *
 * The row component and queue actions still consume `Track`, so each
 * `TrackIdentity` group is projected onto one Track for display and queue
 * handoff. Playback resolution is NOT done here: the Phase 10/11
 * controller canonicalizes the handed-off Track and resolves it.
 *
 * Rules:
 * - Identity fields (primary source, title, artists, album, duration,
 *   artwork, explicit) drive the row. No streamUrl/previewUrl is ever
 *   fabricated — those keys are simply absent.
 * - The FULL merged source list is carried in `metadata.sources` so the
 *   controller can restore the group's YouTube source instead of seeing
 *   only the primary. Primary provider/id stay the stable row identity.
 */
export function identityToTrack(identity: TrackIdentity): Track {
  const primary = identity.primarySource;
  const artist = identity.artists[0];
  const track: Track = {
    id: primary.id,
    provider: primary.source,
    providerTrackId: primary.id,
    title: identity.title,
    artistId: artist?.id ?? primary.id,
    artistName: artist?.name ?? "Unknown artist",
    providerUrl: primary.url,
    metadata: {
      ...(identity.metadata ?? {}),
      sources: identity.sources.map((source) => ({ ...source })),
    },
  };
  if (identity.album) {
    track.albumId = identity.album.id;
    track.albumName = identity.album.title;
  }
  if (identity.durationMs !== undefined) {
    track.duration = Math.round(identity.durationMs / 1000);
  }
  const artworkUrl = resolveArtworkUrl(identity.artwork);
  if (artworkUrl !== undefined) {
    track.artworkUrl = artworkUrl;
  }
  if (typeof identity.metadata?.explicit === "boolean") {
    track.explicit = identity.metadata.explicit;
  }
  return track;
}
