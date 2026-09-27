"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Which way a menu opens. One rule, one place (§30).
 *
 * WHY IT IS A SEPARATE FILE. Every menu in the product is
 * `position: absolute` inside a `relative` wrapper, so every one of them
 * starts life at `top-full` - below its trigger - unless something says
 * otherwise. `TrackActionMenu`, the playlist picker it swaps in, and the
 * queue's row menu all needed that "otherwise", and each of them had grown
 * its own copy of the decision. Three copies of a geometric rule is three
 * chances to be wrong in three slightly different ways, so the rule moved
 * here and the menus ask.
 *
 * WHY IT MEASURES INSTEAD OF GUESSING. The obvious implementation compares
 * the TRIGGER's distance to the bottom of the viewport against a guessed
 * menu height. That guess is wrong in both directions: a row menu is five
 * items, the playlist picker that replaces it in the same slot is a header
 * plus a search box plus a scrolling list, and a menu whose items wrap is
 * taller than either. The number that is actually known - and the only one
 * that cannot be guessed - is the height of the surface that was really
 * rendered. So this hook takes the surface's own rect after it is in the
 * DOM and decides from that.
 *
 * WHY `useLayoutEffect`. A decision that lands after paint is a visible
 * jump: the menu is drawn going one way and then redrawn going the other.
 * `useLayoutEffect` runs after the DOM is mutated and before the browser
 * paints, so the surface is measurable AND the corrected position is what
 * the user ever sees.
 *
 * WHY IT CANNOT LOOP. The effect depends on when the surface is opened and
 * which surface is in the slot - not on the value it produces. A flip
 * therefore re-renders the menu without re-running the decision, so there
 * is no oscillation to defend against.
 */

/**
 * How much room a menu keeps between its bottom edge and the bottom of the
 * viewport, in pixels.
 *
 * This is not "does it fit" - a menu that ends one pixel above the fold is
 * technically on screen and practically unusable. It is the fixed player
 * chrome (an 88px desktop bar; 112px on the phone layout, where the mini
 * player is lifted 4rem clear of the safe area) plus a little breathing
 * room, so a menu never comes to rest on top of the transport the user is
 * about to press.
 */
const BOTTOM_CLEARANCE_PX = 120;

/**
 * The gap between a trigger and its menu, in pixels. Mirrors the `mt-1` /
 * `mb-1` utility the CSS-positioned menus use, for the hosts that place the
 * surface themselves instead of anchoring it to the trigger.
 */
export const MENU_TRIGGER_GAP_PX = 4;

export function useMenuOpenUp({
  open,
  triggerRef,
  surfaceRef,
  placementKey = "",
}: {
  /** Presence `mounted`, not `open`: the surface has to exist to measure. */
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  /**
   * The surface, or the element that contains it. A menu anchored to its
   * own trigger passes the trigger's wrapper (the hook looks up the
   * `[role="menu"]` inside it, which is how it also finds the playlist
   * picker that swaps into the same slot); a menu a host places itself -
   * the queue's, which renders in the panel's own layer because the queue
   * list is a scroll container - passes the surface directly.
   */
  surfaceRef: RefObject<HTMLElement | null>;
  /**
   * Changes when the surface MOVES without the menu reopening, so a host
   * that positions the surface itself can re-run the decision. Omitted by
   * menus anchored to their trigger, which cannot move under the menu.
   */
  placementKey?: string;
}): boolean {
  const [openUp, setOpenUp] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const host = surfaceRef.current;
    const trigger = triggerRef.current;
    if (!host || !trigger) return;
    const surface = host.matches("[role='menu']")
      ? host
      : host.querySelector("[role='menu']");
    if (!surface) return;
    // The trigger's rect and the surface's HEIGHT, deliberately not the
    // surface's own rect: whichever way the surface happens to be rendered
    // right now would otherwise decide the question, and a menu already
    // sitting below the trigger would report itself as cramped and flip -
    // to a place it never needed to be. Height plus the trigger's position
    // answers "how much room would each side give me" without reference to
    // the answer.
    const triggerRect = trigger.getBoundingClientRect();
    const height = surface.getBoundingClientRect().height;
    const gapBelow = window.innerHeight - triggerRect.bottom - height;
    if (gapBelow >= BOTTOM_CLEARANCE_PX) {
      // Room below, so down it goes - and this branch is what CLEARS a
      // previous flip. Without it, a menu that opened upward near the bottom
      // of one list would still be upward at the top of the next one, where
      // the room below is plentiful and the room above is the top of the
      // screen. `setOpenUp` with an unchanged value is free, so this costs
      // nothing on the way to a flip either.
      setOpenUp(false);
      return;
    }
    // Below is cramped. Above is the other side of the same trigger, and it
    // is only worth flipping when it is the roomier of the two - a flip into
    // a worse gap would trade a clipped bottom for a clipped top.
    setOpenUp(triggerRect.top - height > gapBelow);
  }, [open, placementKey, surfaceRef, triggerRef]);

  return openUp;
}
