"use client";

import { resolveArtworkUrl } from "@/lib/domain";
import { usePlayerStore } from "@/lib/player/store";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { identityToTrack } from "@/lib/music/identity-track";
import { formatPlaybackTime } from "@/lib/player/format";
import { Artwork } from "@/components/ui/artwork";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayerLikeButton } from "@/components/tracks/liked-tracks";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { Button } from "@/components/ui/button";
import { AutoplayButton } from "@/components/player/autoplay-button";
import {
  nextRepeatMode,
  PlayPauseButton,
  repeatDisplay,
  SeekSlider,
  SHUFFLE_DISABLED_CLASS,
  shuffleIconClass,
  shuffleToggleClass,
  useShuffleControl,
} from "@/components/ui/player-controls";
import {
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from "@/components/ui/icons";

export function PlayerBar() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const currentTime = useMusicEngineState((s) => s.position);
  const duration = useMusicEngineState((s) => s.duration);
  const volume = useMusicEngineState((s) => s.volume);
  const muted = useMusicEngineState((s) => s.muted);
  const error = useMusicEngineState((s) => s.error);
  const shuffle = useMusicEngineState((s) => s.shuffle);
  // Availability and the three labels come from one shared source, so this
  // surface cannot disagree with the mini bar or the full player about whether
  // shuffle can be used or what it is called.
  const shuffleControl = useShuffleControl();
  const repeat = useMusicEngineState((s) => s.repeat);
  const queueIndex = useMusicEngineState((s) => s.currentIndex);
  const { t } = useLocale();
  const rd = repeatDisplay(repeat);
  const repeatLabel =
    rd === "one" ? t("player.repeatOne") : rd === "all" ? t("player.repeatAll") : t("player.repeatOff");
  const artistName = currentTrack?.artists[0]?.name ?? "";
  const artworkUrl = currentTrack ? resolveArtworkUrl(currentTrack.artwork) : undefined;
  // Queue-panel visibility is local UI chrome state, not engine state.
  const openQueue = usePlayerStore((s) => s.openQueue);

  const seekMax = duration > 0 ? duration : 1;
  const progress = Math.min(Math.max(currentTime, 0), seekMax) / seekMax;
  const displayVolume = muted ? 0 : volume;

  return (
    <div
      role="region"
      aria-label={t("player.bar")}
      // `aurora-liquid-glass` replaces `bg-background-subtle/95 backdrop-blur-md`
      // (Phase 53, §29; lifted to Liquid Glass in the Stitch migration). The
      // player bar is the surface most often overlapped by scrolling content,
      // and it is also the surface that most carries the product's material —
      // so it gets Level 3 rather than plain chrome: the firmest fill of the
      // ladder, a specular sheen and a lavender/electric edge. That is exactly
      // the "floating Liquid Glass surface" the player bar is specified as.
      className="aurora-liquid-glass fixed inset-x-0 bottom-0 z-player hidden border-t border-border-subtle lg:left-66 lg:flex"
    >
      {/* Hairline progress: the bar's top edge is the seek position. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.5 bg-surface-active"
      >
        <div className="h-full bg-gradient-to-r from-aurora-indigo to-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-5 py-2.5">
        {/* Identity: artwork + track + artist + compact Like. */}
        <div className="flex min-w-0 items-center gap-2">
          {currentTrack ? (
            <>
              <Artwork src={artworkUrl} alt="" size="player" pixelSize={48} />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="t-track-title truncate">{currentTrack.title}</span>
                <span className="t-metadata truncate">{artistName}</span>
              </span>
              <PlayerLikeButton />
              <TrackActionMenu
                track={identityToTrack(currentTrack)}
                showAddToPlaylist
              />
            </>
          ) : (
            <span className="truncate text-sm text-text-muted">{t("player.nothingPlaying")}</span>
          )}
        </div>

        {/* Primary transport: the reason the bar exists. */}
        <div className="flex items-center gap-1" role="group" aria-label={t("player.controls")}>
          <Button
            variant="ghost"
            size="icon"
            className={`h-10 w-10 ${shuffleToggleClass(shuffle)} ${SHUFFLE_DISABLED_CLASS}`}
            disabled={!shuffleControl.canShuffle}
            aria-label={shuffleControl.actionLabel}
            aria-pressed={shuffle}
            title={shuffleControl.title}
            onClick={() => engine?.shuffle()}
          >
            <ShuffleIcon size={18} className={shuffleIconClass(shuffle)} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10"
            aria-label={t("player.previous")}
            onClick={() => engine?.previous()}
            disabled={!currentTrack}
          >
            <SkipBackIcon size={18} />
          </Button>
          <PlayPauseButton
            playing={isPlaying}
            loading={isLoading}
            label={isPlaying ? t("player.pause") : t("player.play")}
            onToggle={() => engine?.togglePlay()}
            size={20}
            primary
            disabled={!currentTrack || isLoading}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10"
            aria-label={t("player.next")}
            onClick={() => engine?.skip()}
            disabled={!currentTrack}
          >
            <SkipForwardIcon size={18} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10"
            aria-label={repeatLabel}
            aria-pressed={rd !== "off"}
            onClick={() => engine?.setRepeat(nextRepeatMode(repeat))}
          >
            {rd === "one" ? (
              <RepeatOneIcon size={18} className="text-accent" />
            ) : (
              <RepeatIcon size={18} className={rd === "all" ? "text-accent" : ""} />
            )}
          </Button>
        </div>

        {/* Secondary: time + queue + volume. The seek block stays
            narrow at xl so the right zone can never overflow onto the
            transport controls at 1280px; it widens where room allows. */}
        <div className="flex min-w-0 items-center gap-3 justify-self-end">
          <div className="hidden w-32 flex-col gap-1 xl:flex 2xl:w-48">
            <SeekSlider position={currentTime} duration={duration} onSeek={(v) => engine?.seek(v)} />
            <div className="flex justify-between text-[11px] tabular-nums text-text-muted">
              <span>{formatPlaybackTime(currentTime)}</span>
              <span>{formatPlaybackTime(duration)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Autoplay sits with the queue controls, not in the transport
                row: it is a secondary control, and putting it beside
                play/pause would compete with the reason the bar exists. It is
                immediately left of the queue button because the two are the
                same idea — what is queued, and what happens when it runs
                out. */}
            <AutoplayButton size={20} />
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label={t("player.upNext")}
              onClick={openQueue}
            >
              <QueueIcon size={20} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label={muted ? t("player.unmute") : t("player.mute")}
              onClick={() => engine?.toggleMute()}
            >
              {muted ? <VolumeMuteIcon size={20} /> : <VolumeIcon size={20} />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayVolume}
              aria-label={t("player.volume")}
              onChange={(event) => engine?.setVolume(Number(event.currentTarget.value))}
              className="hidden w-24 accent-accent xl:block"
            />
          </div>
        </div>
      </div>

      {error && currentTrack ? (
        <div
          role="status"
          className="absolute inset-x-0 -top-8 mx-auto flex w-max max-w-[90%] items-center gap-3 truncate rounded-t-xl border border-b-0 border-border-subtle bg-surface-elevated px-4 py-1.5 text-xs text-text-secondary"
        >
          <span className="truncate">{error.message}</span>
          <button
            type="button"
            aria-label={t("player.retryPlayback")}
            onClick={() => {
              if (queueIndex >= 0) {
                engine?.playAt(queueIndex);
              }
            }}
            className="shrink-0 rounded-full border border-border-strong px-2.5 py-0.5 font-semibold text-text-primary transition-colors hover:border-accent/50 hover:text-accent"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
