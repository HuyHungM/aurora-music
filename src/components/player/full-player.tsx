"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { resolveArtworkUrl } from "@/lib/domain";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { formatPlaybackTime } from "@/lib/player/format";
import { Artwork } from "@/components/ui/artwork";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayerLikeButton } from "@/components/tracks/liked-tracks";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { identityToTrack } from "@/lib/music/identity-track";
import { focusFirstByLabel, useFocusTrap } from "@/components/ui/focus";
import { usePresence } from "@/components/ui/presence";
import { Button } from "@/components/ui/button";
import { AutoplayButton } from "@/components/player/autoplay-button";
import {
  nextRepeatMode,
  PlayPauseButton,
  repeatDisplay,
  SeekSlider,
  shuffleIconClass,
  shuffleToggleClass,
  SHUFFLE_DISABLED_CLASS,
  useShuffleControl,
} from "@/components/ui/player-controls";
import {
  QueueIcon,
  ShuffleIcon,
  RepeatIcon,
  RepeatOneIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
  VolumeMuteIcon,
  XIcon,
} from "@/components/ui/icons";

export function FullPlayer() {
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isLoading = useMusicEngineState((s) => s.isResolving);
  const currentTime = useMusicEngineState((s) => s.position);
  const duration = useMusicEngineState((s) => s.duration);
  const volume = useMusicEngineState((s) => s.volume);
  const muted = useMusicEngineState((s) => s.muted);
  const shuffle = useMusicEngineState((s) => s.shuffle);
  // One shared source for availability and labels: see `useShuffleControl`.
  const shuffleControl = useShuffleControl();
  const repeat = useMusicEngineState((s) => s.repeat);
  const { t } = useLocale();
  const rd = repeatDisplay(repeat);
  const repeatLabel =
    rd === "one" ? t("player.repeatOne") : rd === "all" ? t("player.repeatAll") : t("player.repeatOff");
  // Full-player visibility is local UI chrome state, not engine state.
  const isFullPlayerOpen = usePlayerStore((s) => s.isFullPlayerOpen);
  const closeFullPlayer = usePlayerStore((s) => s.closeFullPlayer);
  const openQueue = usePlayerStore((s) => s.openQueue);
  const dialogRef = useRef<HTMLDivElement>(null);
  const expandPlayerLabel = t("player.expandPlayer");
  const { mounted: fullPlayerMounted, presenceProps: fullPlayerPresence } =
    usePresence(isFullPlayerOpen);

  useEffect(() => {
    if (!isFullPlayerOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFullPlayer();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // Announce the dialog on open unless focus already landed inside.
    if (
      dialogRef.current &&
      !dialogRef.current.contains(document.activeElement)
    ) {
      dialogRef.current.focus();
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Return focus to the trigger in the mini player.
      focusFirstByLabel(expandPlayerLabel);
    };
  }, [isFullPlayerOpen, closeFullPlayer, expandPlayerLabel]);

  // Phase 54: this surface declares `role="dialog"` AND `aria-modal="true"`
  // and covers the entire viewport, but it had no Tab trap - so Tab walked
  // straight out of a full-screen takeover and into the page behind it, which
  // is exactly what `aria-modal` tells a screen reader cannot happen. It now
  // shares the one trap `Dialog` uses rather than keeping a second copy of
  // the same logic in a third file.
  useFocusTrap(dialogRef, isFullPlayerOpen);

  // Presence (Phase 48). Split deliberately from the track check below: when
  // playback stops there is no track to animate, so a full-screen takeover
  // with nothing in it must vanish immediately rather than fade an empty
  // viewport. When the user dismisses the player, `isFullPlayerOpen` goes
  // false with content still present, and that is the case that animates.
  //
  // It uses the `pop` vocabulary, not `sheet`: a sheet rises from an edge it
  // visibly shares with the page, and this surface has no edge — it covers
  // the whole viewport, so approaching the viewer is the only motion that
  // reads as depth.
  if (!currentTrack) return null;
  if (!fullPlayerMounted) return null;

  const artworkUrl = resolveArtworkUrl(currentTrack.artwork);
  const artistName = currentTrack.artists[0]?.name ?? "";
  const displayVolume = muted ? 0 : volume;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label={t("player.nowPlayingDialog")}
      aria-modal="true"
      tabIndex={-1}
      {...fullPlayerPresence}
      className="presence-pop fixed inset-0 z-sheet flex flex-col overflow-hidden bg-background-subtle focus:outline-none lg:hidden"
    >
      {/* Ambient artwork wash: restrained, contrast-safe, static. */}
      {artworkUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={artworkUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-20 blur-2xl"
        />
      ) : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-accent/[0.18] via-transparent to-transparent"
        />
      )}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background-subtle/40 via-background-subtle/85 to-background-subtle"
      />

      {/* Top inset so the close control clears the iOS status bar once
          `viewportFit: "cover"` is active; side insets clear a landscape
          notch. Zero everywhere else, so browser mode is unchanged. */}
      <div className="relative flex items-center justify-between px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <span className="t-eyebrow">{t("player.nowPlayingTitle")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t("player.closePlayer")}
          onClick={closeFullPlayer}
        >
          <XIcon size={20} />
        </Button>
      </div>

      {/* PHASE 54 - an intentional landscape composition.

          In portrait this is one column that scrolls, and that is correct. In
          landscape it was still that same column: the artwork is `max-w-[19rem]`
          (304px) tall, so on an 812x375 phone it claimed 81% of the height
          and pushed every control below the fold, leaving the user to scroll a
          layout that had 800px of width going unused. The column did not
          break - it scrolled, which is why nothing looked broken - it just
          spent the one resource landscape has in abundance (width) on the one
          thing landscape cannot afford (height).

          So below 560px of height, and only when the viewport is at least as
          wide as it is tall, this becomes a two-column grid: artwork on the
          left filling the height it actually has, and identity + seek +
          transport + secondary controls stacked on the right. The children are
          placed explicitly rather than relying on source order, because a grid
          that auto-places five children into two columns alternates them across
          the rows - which would put the seek bar under the artwork.

          The portrait layout is untouched: every rule here is scoped to
          `landscape-short`, which is false in portrait at any height. */}
      <div
        // Phase 54, re-measured in the browser at 667x375 and 812x375: this
        // container was `landscape-short:overflow-y-visible` and the artwork
        // carried `landscape-short:max-h-[min(100%,18rem)]`. Both were wrong
        // and together they hid five controls off the bottom of the screen.
        //
        // `min(100%, 18rem)` computes to `none` here, because a percentage
        // max-height against an indefinite containing block - the auto-sized
        // row a `row-span-4` grid item spans - is guaranteed-invalid. So the
        // artwork stayed at its intrinsic 280px from `pixelSize`, the grid
        // became 19px taller than the panel, and `overflow-y: visible` removed
        // the only thing that could have made the difference. Measured at
        // 667x375: Mute, Volume, Up next, Like and Actions all sat at
        // top=350 bottom=394 in a 375px-tall viewport, with no scroller. Five
        // controls, including the only route to the queue, unreachable.
        //
        // Three changes, and the first is the one that matters most:
        //   1. `min-h-0`. `flex-1` still resolves to `min-height: auto`, so
        //      this box could not shrink below its content and overflowed the
        //      panel instead of scrolling inside it. This is the actual bug.
        //   2. The scroller is KEPT in landscape (`overflow-y-auto`, not
        //      `visible`). A layout that is tight at one height must not
        //      become unreachable at another; `justify-center` replaces
        //      `justify-end` because in grid mode `justify-*` maps to the
        //      inline axis and would otherwise push both columns right.
        //   3. The artwork cap is a LENGTH (`min(18rem, 52svh)`), not a
        //      percentage, so it actually binds. 52svh of a 375px-tall phone
        //      is 195px, which fits the grid inside the panel, and because
        //      max-w and max-h carry the same value the square stays square.
        //      The cap is applied on both axes deliberately: capping only
        //      the height would leave a 280x195 box.
        // The landscape rhythm is deliberately tighter than the portrait one
        // (`gap-y-2`, no top padding, a 4px bottom pad) and that is measured,
        // not stylistic. With the portrait spacing the grid overflowed a
        // 375px-tall landscape phone by 35px, so the volume slider, the queue
        // button, Like and Actions started below the fold on the two most
        // common landscape phone sizes. `gap-y-4` -> `gap-y-2` recovers 24px,
        // `pt-2` -> `pt-0` another 8px, and the bottom pad 12 more, which is
        // enough for the whole player to fit at 375px with room to spare.
        //
        // The scroller stays regardless. It is not there because this
        // arithmetic is correct for one height; it is there because a
        // landscape phone is also the case where the on-screen keyboard, a
        // split-screen app, or a 320px viewport can make the available height
        // smaller than any of these numbers. Nothing in this panel may be
        // reachable only by a layout that happens to fit.
        //
        // `overscroll-contain`: this is a full-screen sheet, so running off
        // the end of its content must not continue into the page behind it.
        // Without it a flick at the bottom of the panel scrolls the document
        // the user cannot see, and the sheet appears to move on its own.
        className="relative flex min-h-0 flex-1 flex-col items-center justify-end gap-5 overflow-y-auto overscroll-contain pb-[calc(2rem+env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-4 landscape-short:grid landscape-short:auto-cols-[auto_1fr] landscape-short:items-center landscape-short:justify-center landscape-short:gap-x-8 landscape-short:gap-y-2 landscape-short:pb-[calc(0.25rem+env(safe-area-inset-bottom))] landscape-short:pt-0">
        <Artwork
          src={artworkUrl}
          alt={currentTrack.title}
          size="large"
          pixelSize={280}
          rounded="rounded-2xl"
          eager
          // In landscape the artwork is bounded by BOTH axes with the same
          // length, so the square stays square and actually fits. Phase 54
          // re-measurement: `min(100%, 18rem)` was guaranteed-invalid here
          // (percentage max-height against the indefinite row a `row-span-4`
          // item spans), so the cap silently did nothing and the artwork sat
          // at its intrinsic 280px from `pixelSize`, pushing five controls
          // off a 375px-tall screen. `min(18rem, 52svh)` is a real length:
          // 195px on a 375px-tall phone, 288px once the viewport is 554px or
          // taller, which is also the height at which the landscape-short
          // variant stops applying. The cap is on both axes because the
          // fallback artwork is a `<span>` with an inline width and height
          // (see `ui/artwork.tsx`) - max-w and max-h are not set inline, so
          // they are the only properties that can beat it, and applying
          // max-h alone would leave a 280x195 box.
          className="h-auto w-full max-w-[19rem] shadow-lg landscape-short:col-start-1 landscape-short:row-start-1 landscape-short:row-span-4 landscape-short:max-h-[min(18rem,52svh)] landscape-short:max-w-[min(18rem,52svh)]"
        />

        <div className="w-full max-w-sm text-center landscape-short:col-start-2 landscape-short:row-start-1">
          <h2 className="t-page-title break-words">{currentTrack.title}</h2>
          <p className="mt-1 truncate text-sm text-text-secondary">{artistName}</p>
        </div>

        <div className="w-full max-w-sm landscape-short:col-start-2 landscape-short:row-start-2">
          <SeekSlider
            position={currentTime}
            duration={duration}
            onSeek={(v) => engine?.seek(v)}
          />
          <div className="flex justify-between text-[11px] tabular-nums text-text-muted">
            <span>{formatPlaybackTime(currentTime)}</span>
            <span>{formatPlaybackTime(duration)}</span>
          </div>
        </div>

        <div
          className="flex items-center gap-1.5 landscape-short:col-start-2 landscape-short:row-start-3"
          role="group"
          aria-label={t("player.controls")}
        >
          <Button
            variant="ghost"
            size="icon"
            className={`h-11 w-11 ${shuffleToggleClass(shuffle)} ${SHUFFLE_DISABLED_CLASS}`}
            disabled={!shuffleControl.canShuffle}
            aria-label={shuffleControl.actionLabel}
            aria-pressed={shuffle}
            title={shuffleControl.title}
            onClick={() => engine?.shuffle()}
          >
            <ShuffleIcon size={20} className={shuffleIconClass(shuffle)} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={t("player.previous")}
            onClick={() => engine?.previous()}
          >
            <SkipBackIcon size={20} />
          </Button>
          <PlayPauseButton
            playing={isPlaying}
            loading={isLoading}
            label={isPlaying ? t("player.pause") : t("player.play")}
            onToggle={() => engine?.togglePlay()}
            size={24}
            primary
            disabled={isLoading}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={t("player.next")}
            onClick={() => engine?.skip()}
          >
            <SkipForwardIcon size={20} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={repeatLabel}
            aria-pressed={rd !== "off"}
            onClick={() => engine?.setRepeat(nextRepeatMode(repeat))}
          >
            {rd === "one" ? (
              <RepeatOneIcon size={20} className="text-accent" />
            ) : (
              <RepeatIcon size={20} className={rd === "all" ? "text-accent" : ""} />
            )}
          </Button>
        </div>

        {/* `min-w-0` on the range and `shrink-0` on the icon buttons is load-
            bearing, not decoration. A `flex-1` range input still refuses to
            shrink below its intrinsic width (`min-width: auto`), so on a
            360px phone this row overflowed and the shortfall was shared out
            across every button — a declared 44px touch target came back 20px
            wide. The slider is the only item here that should give way, and a
            control should never end up smaller than the target it declares. */}
        <div className="flex w-full max-w-sm items-center gap-2 landscape-short:col-start-2 landscape-short:row-start-4">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0"
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
            className="aurora-touch min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-accent"
          />
          <AutoplayButton size={20} />
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0"
            aria-label={t("player.upNext")}
            onClick={openQueue}
          >
            <QueueIcon size={20} />
          </Button>
          <PlayerLikeButton />
          <TrackActionMenu
            track={identityToTrack(currentTrack)}
            showAddToPlaylist
          />
        </div>
      </div>
    </div>
  );
}
