import type { Track } from "@/lib/domain/track";
import type { TrackIdentity } from "@/lib/domain/track-identity";
import { toTrackIdentity } from "@/lib/domain/track-normalizer";

/**
 * Shared offline fixture builders for matcher tests. Plain objects only:
 * no network, no database, no provider clients.
 */

let counter = 0;

export interface FixtureTrackOptions {
  id?: string;
  provider?: "youtube" | "spotify" | "deezer";
  providerTrackId?: string;
  title?: string;
  artistId?: string;
  artistName?: string;
  artists?: Array<{ id: string; name: string }>;
  albumId?: string;
  albumName?: string;
  durationSeconds?: number;
  explicit?: boolean;
  isrc?: string;
  providerUrl?: string;
}

export function fixtureTrack(options: FixtureTrackOptions): Track {
  const provider = options.provider ?? "spotify";
  const providerTrackId = options.providerTrackId ?? `${provider}-track-${(counter += 1)}`;
  const artistId = options.artistId ?? `${provider}-artist-1`;
  const artistName = options.artistName ?? "Artist";
  const track: Track = {
    id: providerTrackId,
    provider,
    providerTrackId,
    title: options.title ?? "Song",
    artistId,
    artistName,
    providerUrl: options.providerUrl ?? `https://example.invalid/${provider}/${providerTrackId}`,
    metadata: { artistId },
  };
  if (options.id !== undefined) {
    track.id = options.id;
  }
  if (options.albumId !== undefined) {
    track.albumId = options.albumId;
  }
  if (options.albumName !== undefined) {
    track.albumName = options.albumName;
  }
  if (options.durationSeconds !== undefined) {
    track.duration = options.durationSeconds;
  }
  if (options.explicit !== undefined) {
    track.explicit = options.explicit;
  }
  if (options.isrc !== undefined && track.metadata) {
    track.metadata.isrc = options.isrc;
  }
  return track;
}

export function fixtureIdentity(
  options: FixtureTrackOptions & { identityId?: string },
): TrackIdentity {
  const { identityId, artists, ...trackOptions } = options;
  const track = fixtureTrack(trackOptions);
  return toTrackIdentity(track, {
    ...(identityId !== undefined ? { id: identityId } : {}),
    ...(artists !== undefined
      ? {
          artists: artists.map((artist) => ({
            id: artist.id,
            provider: track.provider,
            providerArtistId: artist.id,
            name: artist.name,
          })),
        }
      : {}),
  });
}

/** Lac Troi pair: Spotify canonical vs Deezer plain variant. */
export function lacTroiPair(): { left: TrackIdentity; right: TrackIdentity } {
  const left = fixtureIdentity({
    provider: "spotify",
    providerTrackId: "spotify-lac-troi",
    title: "Lạc Trôi",
    artistId: "spotify-st",
    artistName: "Sơn Tùng M-TP",
    albumId: "spotify-album-1",
    albumName: "Lạc Trôi",
    durationSeconds: 243,
    explicit: false,
    isrc: "VNF251700001",
  });
  const right = fixtureIdentity({
    provider: "deezer",
    providerTrackId: "deezer-lac-troi",
    title: "Lac Troi",
    artistId: "deezer-st",
    artistName: "Son Tung M-TP",
    durationSeconds: 244,
  });
  return { left, right };
}
