"use client";

import { useEffect, useRef, useCallback, type ReactNode } from "react";
import { usePresence } from "@/components/ui/presence";
import { useFocusTrap } from "@/components/ui/focus";
import { XIcon } from "@/components/ui/icons";

/**
 * Modal dialog (Phase 48).
 *
 * THE ONE THAT MATTERS HERE IS THE EXIT. This used to end with
 * `if (!open) return null;`, which reads like a performance optimisation and
 * is actually a hard constraint: the node is destroyed on the same render
 * that flips the flag, so there is no longer anything to animate. No amount
 * of CSS can add a closing animation to an element that no longer exists.
 * The dialog therefore stays mounted for the length of its exit, told it is
 * exiting, and unmounted by `usePresence` when the exit is over.
 *
 * FOUR THINGS THAT EXIT ANIMATION ALONE DOES NOT FIX, all handled here so
 * they are fixed once for every consumer rather than seven times:
 *
 *   1. POINTER EVENTS. The overlay is `fixed inset-0`. While it fades out it
 *      is still covering the whole viewport, so without
 *      `[data-presence="exiting"] { pointer-events: none }` in `globals.css`
 *      an invisible dialog eats every click for the length of its exit.
 *   2. FOCUS. The exit must not keep trapping Tab or holding the
 *      accessibility tree open, so the exiting subtree is `inert`.
 *   3. SCROLL LOCK. `document.body.style.overflow = "hidden"` / `""` is not
 *      nesting-safe: two dialogs open at once meant the first to close
 *      unlocked the page while the second was still on screen. A module
 *      counter makes the lock a shared resource instead of a per-instance
 *      flag, and the pre-existing inline value is captured and restored.
 *   4. CONTAINING BLOCK. `DialogClose` is `absolute right-4 top-4`. With the
 *      panel left `static`, that resolved against the `fixed inset-0`
 *      overlay — the close button landed in the corner of the *viewport*,
 *      far from a `max-w-md` panel centred on a wide screen. Every current
 *      consumer happens to wrap it in its own `relative`, which is why it
 *      was never seen; the panel is now `relative` so the primitive's
 *      contract holds on its own.
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for the dialog (announced on open). */
  label?: string;
}

/**
 * Scroll lock as a shared, counted resource.
 *
 * Module scope, not component scope, because the thing being shared is a
 * property of the document. `previous` captures whatever inline value the
 * body already had, so a host page that legitimately sets `overflow` is
 * restored to it rather than to the empty string.
 */
let scrollLockCount = 0;
let previousBodyOverflow = "";

function acquireScrollLock() {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function releaseScrollLock() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
  }
}

export function Dialog({ open, onClose, children, label }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { mounted, presenceProps } = usePresence(open);

  // `onClose` is caller-supplied and callers routinely pass an inline arrow,
  // so its identity changes on every parent render. Holding it in a ref
  // keeps `handleEscape` - and therefore the focus/lock effect below -
  // stable. Depending on the identity directly meant that any state change
  // originating from a control *inside* the dialog (copy-to-clipboard,
  // enabling sharing) re-ran the effect: cleanup restored focus to the
  // trigger and the re-setup immediately pulled it back to the dialog,
  // restarting keyboard and screen-reader traversal mid-dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCloseRef.current();
    }
  }, []);

  // Keep Tab cycling inside the modal while it is open. Phase 54: this used
  // to be an inline callback duplicated here and nowhere else; it is now the
  // shared `useFocusTrap`, which the full player also needs - see the note on
  // that hook for why `aria-modal="true"` without a trap is a broken promise
  // rather than a missing nicety.
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement;

    document.addEventListener("keydown", handleEscape);
    acquireScrollLock();
    // Move focus into the dialog unless something inside (e.g. an
    // autofocused input) already claimed it.
    if (
      dialogRef.current &&
      !dialogRef.current.contains(document.activeElement)
    ) {
      dialogRef.current.focus();
    }

    // All of the above is undone at CLOSE REQUEST, not at unmount, and that
    // is deliberate: the trigger becomes focusable again immediately, while
    // the dialog is still fading and is already `inert`, so focus is never
    // restored onto something that is on its way out. The `isConnected`
    // guard covers the trigger having been a row inside the surface being
    // closed.
    return () => {
      document.removeEventListener("keydown", handleEscape);
      releaseScrollLock();
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, [open, handleEscape]);

  if (!mounted) return null;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      {...presenceProps}
      // Phase 54: `items-start` + `my-auto` on the panel + `overflow-y-auto` on
      // the overlay is the pattern that survives a SHORT viewport. This
      // overlay had no vertical padding, no scroll and no max height, and the
      // panel had none either, so a dialog taller than the screen was centred
      // and clipped at BOTH edges with no way to reach the actions at the
      // bottom. That is not a theoretical case on mobile: the soft keyboard
      // removes roughly a third of the height, and `create-playlist-dialog`
      // and `playlist-artwork-editor` are both taller than a 360x640 portrait
      // screen on their own.
      //
      // `items-start` + `my-auto` means a short dialog still centres exactly
      // as before, and a tall one scrolls from its top edge instead of being
      // cut off. The padding is safe-area aware because `viewportFit: "cover"`
      // lets the overlay reach under a notch or a home indicator.
      //
      // `overscroll-contain`: this overlay is a scroll container stacked over
      // the page, and a wheel or trackpad flick that runs off the end of a tall
      // dialog would otherwise keep going and scroll the document behind it.
      // The page is already `overflow: hidden` while the dialog is open, so
      // today the chain has nowhere to go - but that is the scroll lock being
      // load-bearing for something unrelated, and the two are released
      // independently. Containment states the intent at the element that has
      // it. It is not global: the page and the sidebar still chain normally,
      // which is what §11 asks for.
      className="presence-backdrop fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto overscroll-contain bg-black/50 p-[max(1rem,env(safe-area-inset-top))_max(1rem,env(safe-area-inset-right))_max(1rem,env(safe-area-inset-bottom))_max(1rem,env(safe-area-inset-left))] backdrop-blur-sm"

      onClick={(e) => {
        if (e.target === overlayRef.current) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        {...presenceProps}
        // `aurora-glass-float` replaces `bg-surface-1 shadow-2xl` (Phase 53,
        // §34). §34's "semi-transparent, with a slightly blurred backdrop, so
        // the custom background is still visible through it" is why the panel
        // is a FLOAT surface and not a chrome one: `--glass-float-alpha` is
        // the firmest of the three, because this is the densest text in the
        // application, and it is still translucent.
        //
        // The overlay above keeps its own `backdrop-blur-sm`. That is a
        // scrim, not glass, and it is the one place two backdrop filters are
        // ever live at once - the scrim and the panel - which is the whole of
        // the blur budget.
        //
        // `my-auto` is what re-centres a short dialog under the overlay's
        // `items-start`; `max-h` is a second, independent guard so the panel
        // can never exceed the viewport even if a future caller re-parents it
        // out of the scrolling overlay. `dvh` rather than `vh` because the
        // keyboard and the browser chrome both change the visual viewport
        // while a dialog is open, and a `vh` box is sized against the largest.
        //
        // `overscroll-contain` for the same reason as the overlay's, and it
        // matters more here: the panel is the scroller a user actually
        // reaches the end of. The two are separate elements, and a tall dialog
        // scrolls its PANEL while a short one never scrolls the overlay at all
        // - so containment has to be on both or the behaviour depends on
        // content height.
        className="presence-pop aurora-glass-float relative my-auto w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-border-subtle p-6 focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export interface DialogTitleProps {
  children: ReactNode;
}

export function DialogTitle({ children }: DialogTitleProps) {
  return (
    <h2 className="text-lg font-semibold text-text-primary">{children}</h2>
  );
}

export interface DialogCloseProps {
  onClick: () => void;
  "aria-label"?: string;
}

export function DialogClose({
  onClick,
  "aria-label": ariaLabel = "Close dialog",
}: DialogCloseProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      /* No local focus styling. The blanket `:focus-visible` outline in
         `globals.css` is the app-wide convention — every other control,
         including `Button`, relies on it. This button used to declare
         `focus:outline-none focus:ring-2`, which both suppressed that rule
         and showed a ring on plain mouse clicks, since `focus:` matches
         any focus, not just keyboard. */
      className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
    >
      <XIcon size={16} />
    </button>
  );
}

export interface DialogActionsProps {
  children: ReactNode;
}

export function DialogActions({ children }: DialogActionsProps) {
  return (
    <div className="mt-4 flex justify-end gap-2">{children}</div>
  );
}
