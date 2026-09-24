import type { Track } from "@/lib/domain";
import { TrackRow } from "./track-row";

export function TrackList({
  tracks,
  showMenu = false,
  onTrackLike,
  likedTracks,
}: {
  tracks: Track[];
  showMenu?: boolean;
  onTrackLike?: (track: Track) => void;
  likedTracks?: Set<string>;
}) {
  if (tracks.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {tracks.map((track, index) => (
        <li key={`${track.provider}:${track.id}`}>
          <TrackRow
            track={track}
            collectionTracks={tracks}
            collectionIndex={index}
            showMenu={showMenu}
            onLikeToggle={onTrackLike ? () => onTrackLike(track) : undefined}
            isLiked={likedTracks?.has(`${track.provider}:${track.id}`) ?? false}
          />
        </li>
      ))}
    </ul>
  );
}
