"use client";

import type { EngineRepeatMode } from "@/lib/music/music-engine";
import { useMusicEngineState } from "@/lib/music/use-music-engine";
import { useLocale } from "@/components/i18n/locale-provider";
import { Button } from "@/components/ui/button";
import { PauseIcon, PlayIcon } from "@/components/ui/icons";

/** Shared repeat vocabulary so bar/mini/full can never drift apart. */
export function repeatDisplay(repeat: EngineRepeatMode): "off" | "all" | "one" {
  if (repeat === "track") return "one";
  if (repeat === "queue") return "all";
  return "off";
}

export function nextRepeatMode(repeat: EngineRepeatMode): EngineRepeatMode {
  if (repeat === "off") return "queue";
  if (repeat === "queue") return "track";
  return "off";
}

/**
 * Shared shuffle vocabulary so bar/mini/full can never drift apart.
 *
 * Sibling to `repeatDisplay`, and for the same reason. Shuffle is rendered in
 * more than one surface, and each one used to hand-write its own active-state
 * classes independently. So the active treatment is defined once, here, and a
 * new surface calls these two functions rather than re-deciding the styling.
 *
 * The treatment is a SHAPE change as well as a colour change, because a colour
 * on its own is invisible in a greyscale render, close to invisible against
 * `text-text-secondary`, and unusable for a colour-blind visitor. The project's
 * own `AutoplayButton` had already established the ring; shuffle was the
 * outlier, and this is where it was brought in line.
 *
 * The two halves go on DIFFERENT elements, and that split is not cosmetic:
 *
 * - The RING goes on the button, which is where a `box-shadow` is visible.
 * - The COLOUR goes on the ICON (`shuffleIconClass`), not on the button.
 *
 * Why the colour cannot live on the button: `Button variant="ghost"` already
 * sets `text-text-secondary`, and a caller-added `text-accent` is the same CSS
 * specificity, so the winner is decided by the order the two utilities appear in
 * the generated stylesheet - not by the order they appear in the class
 * attribute. Measured in the running app at 1000x700, same origin, real
 * stylesheet:
 *
 *   `text-accent` on the BUTTON -> icon colour lab(73.81 0.94 -3.65)  (muted)
 *   `text-accent` on the ICON   -> icon colour lab(50.20 44.95 -67.73) (accent)
 *
 * The button placement loses, and loses silently: no error, no warning, the
 * class is plainly in the DOM. An earlier version of this refactor put the
 * colour on the button and had to be corrected. The icon has no competing
 * colour rule, and it paints via `stroke="currentColor"`, so `text-accent` on
 * the icon is what actually reaches the glyph. `AutoplayButton` still carries
 * this same latent conflict on its own button; see REMAINING RISKS.
 *
 * `aurora-press` is the project's existing press feedback, declared only under
 * `prefers-reduced-motion: no-preference`, so it costs a reduced-motion visitor
 * nothing. `transition-[color,box-shadow]` is what makes the ring fade rather
 * than snap; the global reduced-motion rule collapses the duration, so the state
 * change is still reported, just instantly. Neither animates layout, so nothing
 * shifts and the button keeps the same box in both states - measured at 44x44
 * before and after.
 *
 * `shrink-0` keeps the declared hit target from being squeezed below its floor
 * by a tight flex row, which is what `AutoplayButton` does for the same reason.
 */
export function shuffleToggleClass(enabled: boolean): string {
  return [
    "aurora-press shrink-0 transition-[color,box-shadow]",
    enabled ? "ring-2 ring-accent/50" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Icon-side half of the shuffle active treatment. See `shuffleToggleClass`. */
export function shuffleIconClass(enabled: boolean): string {
  return enabled ? "text-accent" : "";
}

/**
 * Everything about the shuffle control that is the same on every surface:
 * the canonical state, whether it can be used at all, and the three labels.
 *
 * The four surfaces each used to assemble these independently, which is how they
 * came to disagree. Labels in particular had drifted - some carried a tooltip
 * and some did not - and a control's accessible name, its pressed state, and
 * its tooltip are one fact, not three.
 *
 * `canShuffle` is the DISABLED state, and it is a real condition rather than a
 * precaution. `QueueManager` randomises the play order, so with nothing in the
 * queue there is no order to randomise: the store's `toggleShuffle` returns
 * early on an empty `playOrder`. Before this, that surfaced as a button that
 * accepted the click, reported no change, and offered no explanation - the
 * control looked broken rather than unavailable. The brief for this audit is
 * explicit that shuffle must not be marked disabled merely because the current
 * state is unknown, and equally explicit that a genuine cannot-use condition
 * should be represented; an empty queue is the genuine one.
 *
 * `aria-pressed` stays on the control while it is disabled. A toggle that
 * cannot currently be toggled is still a toggle, and dropping the attribute
 * would change the role a screen reader announces.
 */
export function useShuffleControl(): {
  shuffle: boolean;
  canShuffle: boolean;
  actionLabel: string;
  stateLabel: string;
  title: string;
} {
  const { t } = useLocale();
  const shuffle = useMusicEngineState((s) => s.shuffle);
  // Subscribe to `playOrder`, not `queue`: `queue` is reference-stable across a
  // reorder by design, so selecting only `queue` makes useSyncExternalStore bail
  // out and this control would go stale when the queue changes underneath it.
  const canShuffle = useMusicEngineState((s) => s.playOrder.length > 0);
  const stateLabel = shuffle ? t("player.shuffleOn") : t("player.shuffleOff");
  return {
    shuffle,
    canShuffle,
    // The accessible name states the ACTION; the tooltip states the STATE. The
    // same split `AutoplayButton` uses, for the same reason: a static
    // "Shuffle" tells a screen-reader user the control exists and nothing about
    // what it does now.
    actionLabel: shuffle ? t("player.disableShuffle") : t("player.enableShuffle"),
    stateLabel,
    // When shuffle cannot be used, say why instead of reporting a state that
    // cannot change.
    title: canShuffle ? stateLabel : t("player.shuffleUnavailable"),
  };
}

/**
 * Disabled styling for the shuffle control.
 *
 * A disabled element still matches `:hover` in CSS, so the `hover:bg-*` and
 * `hover:text-*` utilities the ghost and mini variants carry would still fire
 * and the control would look live. `pointer-events-none` removes the misleading
 * hover and the pointer interaction together, and `disabled:` variants drop the
 * hover styling explicitly, so the control reads as unavailable rather than as
 * merely unresponsive.
 */
export const SHUFFLE_DISABLED_CLASS =
  "disabled:pointer-events-none disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-inherit";

export function PlayPauseButton({
  playing,
  loading,
  label,
  onToggle,
  size = 22,
  primary = false,
  disabled = false,
}: {
  playing: boolean;
  loading?: boolean;
  label: string;
  onToggle: () => void;
  size?: number;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={primary ? "primary" : "ghost"}
      size="icon"
      aria-label={label}
      // A spinner with no machine-readable state is decoration. `aria-busy` is
      // the part a screen reader can announce and a test can assert, and it is
      // the same signal `AutoplayButton` already publishes for its badge. Left
      // to the caller for `disabled` on purpose: the bar disables on
      // `!currentTrack || isLoading` and the full player on `isLoading` alone,
      // and a primitive that second-guessed that would break the difference.
      aria-busy={loading || undefined}
      onClick={onToggle}
      disabled={disabled}
      className={primary ? "h-12 w-12 aurora-press" : "h-11 w-11 aurora-press"}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-5 w-5 animate-spin rounded-full border-2 border-text-muted border-t-transparent"
        />
      ) : playing ? (
        <PauseIcon size={size} />
      ) : (
        <PlayIcon size={size} />
      )}
    </Button>
  );
}

export function SeekSlider({
  position,
  duration,
  onSeek,
  label,
}: {
  position: number;
  duration: number;
  onSeek: (value: number) => void;
  label?: string;
}) {
  const { t } = useLocale();
  const resolvedLabel = label ?? t("player.seek");
  const max = duration > 0 ? duration : 1;
  const value = Math.min(Math.max(position, 0), max);
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={1}
      value={value}
      aria-label={resolvedLabel}
      onChange={(event) => onSeek(Number(event.currentTarget.value))}
      onKeyDown={(e) => {
        const step = 5;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          onSeek(Math.min(position + step, max));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onSeek(Math.max(position - step, 0));
        } else if (e.key === "Home") {
          e.preventDefault();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onSeek(max);
        }
      }}
      className="aurora-touch w-full select-none accent-accent focus-visible:outline-2 focus-visible:outline-accent"
    />
  );
}


