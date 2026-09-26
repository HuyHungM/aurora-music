"use client";

/**
 * The one presence lifecycle (§24, §28, §29, §30, §31).
 *
 * THE PROBLEM IT SOLVES. Every dismissible surface in this app used to be
 * written as `{open ? <div/> : null}`. That makes an exit animation
 * impossible, not merely absent: the node is destroyed on the same render
 * that flips the flag, so there is no longer anything to animate. Adding a
 * CSS transition does not help, because a transition needs two painted
 * states and the second one is never painted — the element is simply gone.
 * So the fix is structural. The element must stay mounted after `open` goes
 * false, be told it is exiting, and be unmounted by a timer when the exit is
 * over. That is all this file does.
 *
 * WHY A TIMER AND NOT `animationend`. The obvious implementation listens for
 * `animationend`. That couples the component's *lifecycle* to whether the
 * browser chose to paint the motion, which fails in three real ways:
 *
 *   - jsdom runs no animations at all, so `animationend` never fires and
 *     every dismissible component would be stuck mounted in the test suite.
 *   - `prefers-reduced-motion` collapses durations to ~0 (see the blanket
 *     rule in `globals.css`). That still works, but it makes correctness
 *     depend on a `!important` override in a different file.
 *   - A tab that is backgrounded mid-animation, or a display that throttles
 *     compositor work, can drop the event outright — leaving a menu
 *     permanently mounted and invisible.
 *
 * A timer is unconditional, synchronous to reason about, and identical in
 * every environment. The CSS supplies the pixels; the timer owns the mount.
 *
 * WHY `entered` EXISTS AS A SEPARATE STATE. The element must be painted once
 * with no animation before it can animate, otherwise the first frame shows
 * the *final* state and the entrance is invisible. `entering` → `entered`
 * gives that first paint, and keeps the element fully interactive for the
 * whole open life. Only `exiting` is inert.
 *
 * RAPID TOGGLE (§29). Every transition clears the pending timer first, so
 * there is never more than one in flight. Reopening mid-exit cancels the
 * unmount and returns to `entering`; the exit never completes. Closing again
 * restarts a full exit. No state is "stuck", because the only thing that
 * unmounts is a timer that is always cleared before it can fire.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
/**
 * Enter and exit durations, in milliseconds.
 *
 * These MUST match `--p-duration-normal` and `--p-duration-fast` in
 * `globals.css`. They are duplicated rather than read from CSS because
 * `getComputedStyle` would mean a layout read on every open, and because a
 * stylesheet load race would otherwise make the exit outlast the animation
 * (a visible ghost) or underrun it (a snap). `presence.test.tsx` asserts
 * the hook unmounts within this budget; the visual half is CSS's job.
 *
 * Exit is deliberately shorter than enter: see the presence block in
 * `globals.css`.
 */
export const PRESENCE_ENTER_MS = 220;
export const PRESENCE_EXIT_MS = 140;

export type PresenceState = "entering" | "entered" | "exiting";

/**
 * Internal phase. Identical to `PresenceState` plus `unmounted`, the one
 * value that is never rendered — it exists so "the exit finished" is
 * something the hook can remember without keeping the element mounted.
 */
type Phase = PresenceState | "unmounted";

export interface UsePresenceResult {
  /** Safe to render the element only when true. */
  readonly mounted: boolean;
  readonly state: PresenceState;
  /**
   * Spread onto the animated element.
   *
   * Carries `inert` as well as the state attribute, deliberately. While a
   * surface is fading out it is still in the layout — that is the whole
   * point — so without `inert` it keeps its tab stops and stays announced
   * to screen readers, and an invisible dialog is still a dialog to
   * assistive tech. Putting it here rather than in each consumer means a
   * new dismissible surface cannot forget it; there is exactly one place
   * where "exiting implies uninteractable" is decided.
   *
   * Pointer events are handled separately, by the
   * `[data-presence="exiting"]` rule in `globals.css`.
   */
  readonly presenceProps: {
    "data-presence": PresenceState;
    inert: boolean;
  };
}

export function usePresence(
  open: boolean,
  options: {
    /** Overridable so a test does not have to wait 220ms for an entrance. */
    enterMs?: number;
    exitMs?: number;
    /**
     * Runs once the exit finishes and the element is about to unmount.
     * This is where focus returns to the trigger (§33): later than the
     * close request, so focus is never restored onto an element that is
     * still on screen, and earlier than the unmount, so the trigger is
     * focused before the old surface disappears.
     */
    onExited?: () => void;
  } = {},
): UsePresenceResult {
  const { enterMs = PRESENCE_ENTER_MS, exitMs = PRESENCE_EXIT_MS, onExited } =
    options;

  /*
   * ONE PIECE OF STATE, AND EVERYTHING ELSE IS DERIVED.
   *
   * `phase` records only what a TIMER can change: that the entrance
   * finished ("entered") or that the exit finished ("unmounted"). Whether the
   * element is showing, and which of the three visible states it is in, is
   * then a pure function of `open` and `phase`, computed below during
   * render.
   *
   * This shape is not stylistic. Storing "entering" and "exiting" as state
   * means every open and every close has to `setState` from inside an
   * effect, which React's compiler-aware lint rules correctly flag as a
   * cascading render, and which in practice is how presence implementations
   * grow a render/settle race. Deriving them means the effect body only ever
   * arms a timer; the state change happens in the timer callback, where it
   * is an event rather than a synchronous effect body update.
   */
  const [phase, setPhase] = useState<Phase>(() =>
    open ? "entering" : "unmounted",
  );

  /*
   * RECORD THE MOUNT DURING RENDER, NOT IN AN EFFECT.
   *
   * React's documented "adjusting state when props change" pattern, and it
   * is load-bearing twice over.
   *
   * First, correctness of the mount itself. If `phase` were only advanced
   * inside `useEffect`, then on the render where `open` flips true the
   * element would still be absent — the effect has not run yet — and any
   * consumer effect keyed on `open` would see a null ref. The classic
   * casualty is "move focus into the panel when it opens": it fires while
   * the panel is not in the DOM, the guard silently passes, and focus
   * simply never arrives. No error, no warning, one unusable dialog per
   * open. React discards this render and re-renders immediately, so the
   * single commit that follows already contains the element.
   *
   * Second, and less obviously: without this, opening and closing again
   * within the same tick leaves `phase` at "unmounted", so
   * `mounted` computes false and the exit branch never arms a timer. The
   * element would snap out of existence instead of animating — precisely
   * the rapid-toggle case this primitive exists to get right.
   *
   * It cannot loop: the condition is false as soon as `phase` has left
   * "unmounted", and only a timer puts it back.
   */
  if (open && phase === "unmounted") {
    setPhase("entering");
  }

  let state: PresenceState;
  if (open) {
    // Opening always starts an entrance, including when it interrupts an
    // exit that had not finished — the rapid-toggle case, where the element
    // never unmounts because the exit timer is cancelled below.
    state = phase === "entered" ? "entered" : "entering";
  } else {
    // Closed but not yet finished exiting. If the exit already completed,
    // `mounted` is false below and nothing renders this.
    state = "exiting";
  }
  const mounted = open || phase !== "unmounted";

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onExitedRef = useRef(onExited);
  // Latest-value ref, written in an effect rather than during render:
  // assigning a ref while rendering is a render side effect, and React may
  // discard a render. Consumers almost always pass an inline arrow, so this
  // also keeps the timer effect from re-arming on every render.
  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();

    if (open) {
      // Land in `entered` once the entrance is over. The element is already
      // mounted, interactive and correctly positioned the whole time; this
      // only decides whether the enter motion is still running.
      timerRef.current = setTimeout(() => setPhase("entered"), enterMs);
    } else if (phase !== "unmounted") {
      timerRef.current = setTimeout(() => {
        setPhase("unmounted");
        onExitedRef.current?.();
      }, exitMs);
    }

    return clearTimer;
    // `phase` is deliberately NOT a dependency. It changes when a timer
    // fires, and re-running the effect on that change would re-arm the
    // timer that just fired — the classic "never finishes exiting" loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, enterMs, exitMs, clearTimer]);

  // Nothing to be present for: released on unmount so a pending exit can
  // never fire into a dead component.
  useEffect(() => clearTimer, [clearTimer]);

  return {
    mounted,
    state,
    presenceProps: { "data-presence": state, inert: state === "exiting" },
  };
}

export interface PresenceProps {
  open: boolean;
  /**
   * Which presence vocabulary to use. Each maps to a keyframe pair in
   * `globals.css`; see the presence block there for why they differ.
   *
   *   backdrop — opacity only; a backdrop that slides looks broken
   *   pop      — dialog and popover; fade with a whisper of scale
   *   sheet    — bottom sheet; rises, does not grow
   *   menu     — context menu; drifts away from its trigger
   */
  variant: "backdrop" | "pop" | "sheet" | "menu";
  /** A menu that opens upward drifts the other way. */
  direction?: "up" | "down";
  children: ReactNode;
  /** Applied to the animated element. */
  className?: string;
  /** Escape hatch for the rare element that is not a single host node. */
  as?: ElementType;
  enterMs?: number;
  exitMs?: number;
  onExited?: () => void;
  /**
   * Forwarded to the animated host. `Presence` deliberately imposes no role
   * of its own — it is a lifecycle, not a widget — so whatever the surface
   * must be announced as (`role="dialog"`, `aria-label`, `aria-modal`,
   * `role="menu"`) is passed through here. These are spread last so the
   * caller stays authoritative: `presenceProps` is applied first, so a
   * `data-presence` supplied by accident cannot override the lifecycle.
   */
  role?: string;
  id?: string;
  "aria-label"?: string;
  "aria-modal"?: boolean | "true" | "false";
  "aria-hidden"?: boolean | "true" | "false";
  "data-testid"?: string;
}

/**
 * The component form. Everything with an enter and an exit should use this
 * rather than hand-rolling `{open && ...}` plus a bespoke timer — the timer
 * bookkeeping is the part that is easy to get subtly wrong, and §28 exists
 * so that there is exactly one place it can be wrong.
 */
export function Presence({
  open,
  variant,
  direction = "down",
  children,
  className,
  as,
  enterMs,
  exitMs,
  onExited,
  ...hostProps
}: PresenceProps) {
  const { mounted, presenceProps } = usePresence(open, {
    enterMs,
    exitMs,
    onExited,
  });

  if (!mounted) {
    return null;
  }

  const Host = (as ?? "div") as ElementType;
  const variantClass =
    variant === "menu" && direction === "up"
      ? "presence-menu presence-menu-up"
      : `presence-${variant}`;

  return (
    <Host
      {...presenceProps}
      className={variantClass + (className ? ` ${className}` : "")}
      {...hostProps}
    >
      {children}
    </Host>
  );
}
