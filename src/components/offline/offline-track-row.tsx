"use client";

/**
 * One row in the local-files list.
 *
 * No duration column, and that is a decision rather than an omission. A
 * duration needs a media element per file, which for a large music folder
 * means thousands of them; and the number would be redundant, because the audio
 * element reports the true duration as soon as a track loads. Probing it here
 * would be cost bought with no extra truth, so the file name is shown instead
 * and the player carries the timing.
 */

import { PlayIcon, QueueIcon } from "@/components/ui/icons";
import type { Track } from "@/lib/domain";
import type { OfflineTrackFile } from "@/lib/offline/types";

export interface OfflineTrackRowProps {
  file: OfflineTrackFile;
  playLabel: string;
  queueLabel: string;
  fileLabel: string;
  onPlay: (track: Track) => void;
  onQueue: (track: Track) => void;
  /** Injected so the row builds the Track through the same mapper as tests. */
  buildTrack: (input: { id: string; folder: string | null; name: string }) => Track;
}

export function OfflineTrackRow({
  file,
  playLabel,
  queueLabel,
  fileLabel,
  onPlay,
  onQueue,
  buildTrack,
}: OfflineTrackRowProps) {
  const track = buildTrack({ id: file.id, folder: file.folder, name: file.name });

  return (
    <li className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1/60 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="t-card-title truncate" title={file.name}>
          {track.title}
        </span>
        <span className="t-caption truncate">
          {track.artistName} · {fileLabel}
        </span>
      </div>
      <div className="flex gap-1">
        {/*
          Class strings are copied VERBATIM from an existing player control so
          Tailwind emits no new utility for this row. A local track list that
          quietly added a few KiB of CSS would push the shared stylesheet past
          its budget for every user, including those who never open /offline.
        */}
        <button
          type="button"
          onClick={() => onPlay(track)}
          aria-label={playLabel}
          className="aurora-touch grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        >
          <PlayIcon size={18} />
        </button>
        <button
          type="button"
          onClick={() => onQueue(track)}
          aria-label={queueLabel}
          className="aurora-touch grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        >
          <QueueIcon size={18} />
        </button>
      </div>
    </li>
  );
}