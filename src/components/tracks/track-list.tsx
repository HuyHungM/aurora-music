import type { Track } from "@/lib/domain";
import { TrackRow, type TrackRowVariant } from "./track-row";

/**
 * Canonical identity for a catalog track row (provider + stable id).
 * Occurrence lists (likes / history / playlist items / queue) must
 * pass getKey backed by like.id / history id / playlist item id /
 * queue-entry id instead.
 */
export function catalogTrackKey(track: Track): string {
  return `${track.provider}:${track.providerTrackId ?? track.id}`;
}

export function TrackList({
  tracks,
  showMenu = false,
  showAddToPlaylist = true,
  onTrackLike,
  likedTracks,
  getKey,
  variant = "catalog",
  numbered = false,
}: {
  tracks: Track[];
  showMenu?: boolean;
  /** Every track menu offers Add to playlist (contextual, never a wall of buttons). */
  showAddToPlaylist?: boolean;
  onTrackLike?: (track: Track) => void;
  likedTracks?: Set<string>;
  getKey?: (track: Track, index: number) => string;
  variant?: TrackRowVariant;
  numbered?: boolean;
}) {
  if (tracks.length === 0) {
    return null;
  }
  // Occurrence-safe keys: a provider may legitimately return the same
  // video twice in one collection (e.g. youtube:Xk9kczrs8I0 appearing in
  // both popular and a merged list, or a raw duplicate inside one
  // provider response). Those are provider collections, not user collections,
  // and the canonical dedupe deliberately does not rewrite what a provider
  // returned. The canonical identity stays first; a per-list occurrence
  // counter only disambiguates repeats so React never sees a duplicate
  // key. This is not index-as-identity: unique tracks keep their stable
  // canonical key, and the three user collections that CAN hold the same
  // logical track twice - playlist membership, the active queue, recently
  // played - are deduplicated before they reach this component, so the
  // counter is idle for them.
  const seen = new Map<string, number>();
  const keyFor = (track: Track, index: number): string => {
    if (getKey) {
      return getKey(track, index);
    }
    const base = catalogTrackKey(track);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}#${occurrence + 1}`;
  };
  return (
    <ul className="flex flex-col gap-0.5">
      {tracks.map((track, index) => (
        <li key={keyFor(track, index)}>
          <TrackRow
            track={track}
            collectionTracks={tracks}
            collectionIndex={index}
            showMenu={showMenu}
            showAddToPlaylist={showAddToPlaylist}
            onLikeToggle={onTrackLike ? () => onTrackLike(track) : undefined}
            isLiked={likedTracks?.has(catalogTrackKey(track)) ?? false}
            variant={variant}
            position={numbered ? index + 1 : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
