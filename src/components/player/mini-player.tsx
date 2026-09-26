"use client";

import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { Artwork } from "@/components/ui/artwork";
import {
  PlayPauseButton,
  nextRepeatMode,
  repeatDisplay,
  shuffleIconClass,
  shuffleToggleClass,
  SHUFFLE_DISABLED_CLASS,
  useShuffleControl,
} from "@/components/ui/player-controls";
import { useLocale } from "@/components/i18n/locale-provider";
import { QueueIcon, RepeatIcon, RepeatOneIcon, ShuffleIcon, SkipForwardIcon } from "@/components/ui/icons";

export function MiniPlayer() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const currentTime = useMusicEngineState((s) => s.position);
  const duration = useMusicEngineState((s) => s.duration);
  const error = useMusicEngineState((s) => s.error);
  const repeat = useMusicEngineState((s) => s.repeat);
  // Same canonical source as the bar and the full player. Read from the engine
  // store, never from local state, so this control cannot disagree with the
  // other three or with the queue itself.
  const shuffle = useMusicEngineState((s) => s.shuffle);
  // One shared source for availability and labels: see `useShuffleControl`.
  const shuffleControl = useShuffleControl();
  const { t } = useLocale();
  const rd = repeatDisplay(repeat);
  const repeatLabel =
    rd === "one" ? t("player.repeatOne") : rd === "all" ? t("player.repeatAll") : t("player.repeatOff");
  // Queue/full-player visibility is local UI chrome state, not engine state.
  const openQueue = usePlayerStore((s) => s.openQueue);
  const openFullPlayer = usePlayerStore((s) => s.openFullPlayer);

  if (!currentTrack) {
    return null;
  }

  const artworkUrl = resolveArtworkUrl(currentTrack.artwork);
  const artistName = currentTrack.artists[0]?.name ?? "";
  const seekMax = duration > 0 ? duration : 1;
  const progress = Math.min(Math.max(currentTime, 0), seekMax) / seekMax;

  return (
    <div
      role="region"
      aria-label={t("player.miniPlayer")}
      // Same chrome glass level as the desktop player bar (`aurora-glass`),
      // so the two are one surface at two widths rather than two designs
      // (Phase 53, §29). The nested track button carries no glass of its own:
      // it is inside a surface that is already blurring, so a second
      // `backdrop-filter` would buy nothing and cost a composited layer.
      className="aurora-glass fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-player flex items-center gap-2 border-t border-border-subtle px-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2 lg:hidden"
    >
      {/* Progress hairline across the mini player's top edge. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-surface-active">
        <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
      </div>
      <button
        type="button"
        aria-label={t("player.expandPlayer")}
        onClick={openFullPlayer}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left"
      >
        <Artwork src={artworkUrl} alt="" size="thumbnail" pixelSize={44} />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="t-track-title truncate">{currentTrack.title}</span>
          <span className="t-metadata truncate">{error ? error.message : artistName}</span>
        </span>
      </button>
      {/* Shuffle, Repeat and Up next are `hidden sm:grid` (Phase 54).

          MEASURED, not assumed. At a 360px viewport this row is
          `px-3` + `gap-2` + a 44px artwork + five 44px controls, and the
          `flex-1 min-w-0` block that holds the title and artist came back
          76px wide - about eight characters. It is 91px at 375, 106 at 390,
          128 at 412 and 146 at 430: the track you are listening to is
          unreadable on most phones, which is the one thing a player bar
          exists to say.

          These three are the desktop set. On a phone they are one tap away in
          the full player, which carries all three at full size - and on a
          touch laptop or a tablet the row is wide enough for them, so they
          reappear at `sm`. Nothing became unreachable: the full player is
          opened by tapping the identity block, which is now the widest
          target in the row. Queue keeps its own entry point in the full
          player rather than competing with Next for 44px here. */}
      <button
        type="button"
        aria-label={shuffleControl.actionLabel}
        aria-pressed={shuffle}
        title={shuffleControl.title}
        disabled={!shuffleControl.canShuffle}
        onClick={() => engine?.shuffle()}
        className={[
          "hidden h-11 w-11 shrink-0 place-items-center rounded-full transition-colors hover:bg-surface-hover sm:grid",
          // Chosen, not appended: `shuffleToggleClass` always returns the press
          // and transition classes, so `a || b` would never fall through to the
          // inactive colour and shuffle would never look off. The branch is
          // explicit, and the active branch is still the single shared source.
          shuffle ? shuffleToggleClass(shuffle) : "text-text-muted hover:text-text-primary",
          SHUFFLE_DISABLED_CLASS,
        ].join(" ")}
      >
        <ShuffleIcon size={18} className={shuffleIconClass(shuffle)} />
      </button>
      <button
        type="button"
        aria-label={repeatLabel}
        aria-pressed={rd !== "off"}
        onClick={() => engine?.setRepeat(nextRepeatMode(repeat))}
        className={`hidden h-11 w-11 shrink-0 place-items-center rounded-full transition-colors hover:bg-surface-hover sm:grid ${
          rd !== "off" ? "text-accent" : "text-text-muted hover:text-text-primary"
        }`}
      >
        {rd === "one" ? <RepeatOneIcon size={18} /> : <RepeatIcon size={18} />}
      </button>
      <button
        type="button"
        aria-label={t("player.upNext")}
        onClick={openQueue}
        className="hidden h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary sm:grid"
      >
        <QueueIcon size={20} />
      </button>
      <button
        type="button"
        aria-label={t("player.next")}
        onClick={() => engine?.skip()}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
      >
        <SkipForwardIcon size={20} />
      </button>
      <PlayPauseButton
        playing={isPlaying}
        loading={isLoading}
        label={isPlaying ? t("player.pause") : t("player.play")}
        onToggle={() => engine?.togglePlay()}
        // The bar and the full player both block the toggle while a track is
        // resolving. The mini player showed the spinner and stayed live, so a
        // second tap during the load fired `togglePlay` again - two requests
        // against one intent, and whichever resolved last decided the state the
        // user then saw. Matching the siblings is the whole fix; there is no
        // mini-player-specific reason to be the odd one out.
        disabled={isLoading}
      />
    </div>
  );
}
