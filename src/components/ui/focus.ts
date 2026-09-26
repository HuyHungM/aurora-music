/**
 * Focus helpers for overlay teardown (Phase 23). Focusing an element that
 * the browser refuses (e.g. `display: none`) is a silent no-op, so trying
 * every match in document order and stopping at the first that takes focus
 * reliably reaches the visible trigger without any layout heuristics.
 * In jsdom (no layout) the first match takes focus, keeping tests
 * deterministic.
 */
import { useEffect } from "react";

export function focusFirstByLabel(label: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const matches = document.querySelectorAll(`[aria-label="${label}"]`);
  for (const element of Array.from(matches)) {
    const target = element as HTMLElement;
    if (typeof target.focus !== "function") {
      continue;
    }
    target.focus();
    if (document.activeElement === target) {
      return true;
    }
  }
  return false;
}

/**
 * Selector for the elements a Tab cycle is allowed to land on. Mirrors what
 * a user can actually reach: not disabled, not `tabindex="-1"`, and not
 * inside a `hidden` subtree.
 */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Is this control displayed, as opposed to merely scrolled out of view?
 *
 * The distinction is the point. A control scrolled past the top of a
 * scrollable overlay is still in the tab order — the user scrolls to it, and
 * excluding it would make the Tab cycle skip content that is really there. So
 * this asks "is it displayed", not "is it on screen", and a control that is
 * merely off-screen passes.
 *
 * WHY NOT `offsetParent`. It is tempting — it is the browser's own answer to
 * "is this laid out" and it needs no walking — and it is wrong twice:
 *
 * 1. `offsetParent` is `null` for any element whose containing block chain
 *    reaches the viewport, which includes every `position: fixed` element.
 *    A control that is itself fixed is laid out and tabbable, and the trap
 *    would drop it out of the cycle.
 * 2. `offsetParent` is `null` for EVERY element in jsdom, which does no
 *    layout. The filter therefore matched nothing, `focusable.length` was 0,
 *    and the "nothing to land on" branch swallowed every Tab inside the
 *    dialog. The trap worked, the dialog tests said it did not, and the file's
 *    own header note about behaving in jsdom had been quietly invalidated by
 *    this one line.
 *
 * Walking computed `display` up to the overlay boundary means the same thing
 * in both places, needs no layout, and reads what the author actually wrote.
 */
function isDisplayedWithin(element: HTMLElement, boundary: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node) {
    if (window.getComputedStyle(node).display === "none") {
      return false;
    }
    if (node === boundary) {
      return true;
    }
    node = node.parentElement;
  }
  // Outside the boundary: reachable from this subtree, not our concern here.
  return true;
}

/**
 * Keeps Tab and Shift+Tab cycling inside `ref` while `active` (Phase 54).
 *
 * WHY THIS IS EXTRACTED. `dialog.tsx` had a correct, inline trap. The full
 * player then declared `role="dialog" aria-modal="true"` and a full-viewport
 * takeover WITHOUT one - and `aria-modal="true"` is a promise to assistive
 * technology that everything outside the dialog is hidden. It was not hidden.
 * A screen-reader or keyboard user could Tab straight out of a full-screen
 * takeover and into the page behind it, which is precisely the situation
 * `aria-modal` claims cannot happen. Either the promise or the behaviour was
 * wrong; the behaviour is what the user needs, so the promise is kept and the
 * trap is shared.
 *
 * Registered in the CAPTURE phase on `document`, so it runs before any
 * component's own key handling and cannot be bypassed by a handler that stops
 * propagation.
 */
export function useFocusTrap(
  ref: { current: HTMLElement | null },
  active: boolean,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }
      const scope = ref.current;
      if (!scope) {
        return;
      }
      const focusable = Array.from(
        scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          isDisplayedWithin(element, scope) &&
          // A control scrolled out of a scrollable overlay is still tabbable
          // by design, so `isDisplayedWithin` deliberately tests `display`
          // rather than visibility against a viewport.
          !element.closest("[inert]"),
      );
      if (focusable.length === 0) {
        // Nothing to land on. Swallow the key so focus cannot escape upward
        // into the page behind the overlay.
        event.preventDefault();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active_ = document.activeElement;
      if (event.shiftKey && (active_ === first || !scope.contains(active_))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active_ === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handle, true);
    return () => document.removeEventListener("keydown", handle, true);
  }, [ref, active]);
}
