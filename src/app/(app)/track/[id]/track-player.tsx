"use client";

import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import type { Track } from "@/lib/domain";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { EntityHeader } from "@/components/ui/entity-header";
import { trackCapabilities } from "@/lib/player/track-capabilities";
import { LikeButton } from "@/components/tracks/like-button";
import { useLocale } from "@/components/i18n/locale-provider";
import { StartTrackRadioButton } from "@/components/radio/radio-controls";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { formatTrackDuration } from "@/lib/player/format";

export function TrackPlayer({
  track,
  initialLiked,
}: {
  track: Track;
  initialLiked: boolean;
}) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;

  const handlePlay = () => {
    if (!engine) {
      return;
    }
    if (isCurrentPlaying) {
      engine.pause();
    } else {
      void engine.play(track);
    }
  };

  const duration = formatTrackDuration(track.duration);
  // The current track keeps its toggle (engine state rules there);
  // otherwise Play appears only when Aurora can attempt playback.
  const canPlay = isCurrent || trackCapabilities(track).canPlay;
  const playabilityLabel = isCurrent
    ? undefined
    : trackCapabilities(track).playability === "playable"
      ? t("track.availableToPlay")
      : t("track.playbackUnavailable");

  return (
    <div className="flex flex-col gap-6">
      <EntityHeader
        eyebrow={t("track.eyebrow")}
        title={track.title}
        artwork={track.artworkUrl}
        artworkAlt={track.title}
        meta={
          <>
            <span>{track.artistName}</span>
            {track.albumName ? (
              <>
                {" · "}
                <span>{track.albumName}</span>
              </>
            ) : null}
            {duration ? ` · ${duration}` : ""}
            {playabilityLabel ? (
              <>
                {" · "}
                <span>{playabilityLabel}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {canPlay ? (
              <button
                type="button"
                onClick={handlePlay}
                aria-label={isCurrentPlaying ? t("track.pauseLabel", { title: track.title }) : t("track.playLabel", { title: track.title })}
                className="aurora-press inline-flex h-12 items-center gap-2 rounded-full bg-accent px-7 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
              >
                {isCurrentPlaying ? (
                  <>
                    <PauseIcon size={18} /> {t("common.pause")}
                  </>
                ) : (
                  <>
                    <PlayIcon size={18} /> {t("common.play")}
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-label={t("track.playbackUnavailableFor", { title: track.title })}
                title={t("track.playbackUnavailable")}
                className="inline-flex h-12 cursor-not-allowed items-center gap-2 rounded-full border border-border-subtle px-7 text-sm font-semibold text-text-disabled"
              >
                <PlayIcon size={18} /> {t("collectionPlay.unavailable")}
              </button>
            )}
            <LikeButton
              track={track}
              initialLiked={initialLiked}
              size={18}
              className="h-12 w-12"
            />
            <TrackActionMenu track={track} showLike={false} showAddToPlaylist={true} />
          </>
        }
        secondary={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => engine?.queue.playNext(track)}
              aria-label={t("track.playNextLabel", { title: track.title })}
            >
              {t("menus.playNext")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => engine?.queue.add(track)}
              aria-label={t("track.addToQueueLabel", { title: track.title })}
            >
              {t("queue.title")}
            </Button>
            <StartTrackRadioButton track={track} variant="ghost" />
          </div>
        }
      />

      <div className="flex flex-wrap gap-2 text-xs text-text-muted">
        {duration ? (
          <span className="rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5 tabular-nums">
            {duration}
          </span>
        ) : null}
        {track.explicit ? (
          <span className="rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5 font-semibold uppercase">
            {t("track.explicit")}
          </span>
        ) : null}
        {track.genres && track.genres.length > 0
          ? // De-duplicated: `genres` is a provider-supplied JSON column with
            // no uniqueness guarantee on any read path (`dal/mappers.ts`
            // filters by type only), so a stored `["pop","pop"]` both rendered
            // a duplicate chip and handed React a duplicate key. Unique
            // values make `key={genre}` a genuine stable identity again.
            Array.from(new Set(track.genres)).map((genre) => (
              <span
                key={genre}
                className="rounded-full border border-border-subtle bg-surface-1 px-3 py-1.5"
              >
                {genre}
              </span>
            ))
          : null}
      </div>
    </div>
  );
}
