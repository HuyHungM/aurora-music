// @vitest-environment jsdom
/**
 * The flip rule every menu in the product shares (`menu-placement.ts`).
 *
 * These are the cases that used to be three different guesses in three
 * different components, so they are worth pinning: the rule is only correct
 * if it answers "how much room would each side give me" rather than "where
 * is the trigger relative to the bottom of the screen", because a surface
 * that has already been rendered is itself an answer to a question the rule
 * is trying to ask.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useMenuOpenUp } from "@/components/ui/menu-placement";

const VIEWPORT_HEIGHT = 768;

/** jsdom paints nothing, so every rect is zero. These are the numbers the
 *  rule is supposed to reason about, and they have to be stated. */
function stubRect(el: HTMLElement, rect: Partial<DOMRect>) {
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect;
}

function setup({
  open = true,
  trigger,
  height = 200,
  surfaceIsHost = false,
}: {
  open?: boolean;
  /** `[top, bottom]` of the trigger. */
  trigger: [number, number];
  height?: number;
  /** The queue's shape: the ref points at the surface, not at a wrapper. */
  surfaceIsHost?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const triggerEl = document.createElement("button");
  const surfaceEl = document.createElement("div");
  let menuEl = surfaceEl;
  if (surfaceIsHost) surfaceEl.setAttribute("role", "menu");
  else {
    const child = document.createElement("div");
    child.setAttribute("role", "menu");
    surfaceEl.appendChild(child);
    stubRect(child, { height });
    menuEl = child;
  }
  stubRect(triggerEl, { top: trigger[0], bottom: trigger[1] });
  if (surfaceIsHost) stubRect(surfaceEl, { height });
  container.append(triggerEl, surfaceEl);

  const view = renderHook(
    ({ isOpen }: { isOpen: boolean }) => {
      const triggerRef = useRef<HTMLElement | null>(null);
      const surfaceRef = useRef<HTMLElement | null>(null);
      triggerRef.current = triggerEl;
      surfaceRef.current = surfaceEl;
      return useMenuOpenUp({ open: isOpen, triggerRef, surfaceRef });
    },
    { initialProps: { isOpen: open } },
  );
  return { ...view, triggerEl, surfaceEl, menuEl };
}

/**
 * jsdom has no `ResizeObserver` and no layout, so the platform's "your size
 * changed" signal has to be stood in for. The hook asks for it by name, so
 * this is the same seam a browser provides - and firing `fire()` is exactly
 * what a browser does when a menu's content loads and it grows.
 */
function stubResizeObserver() {
  const callbacks: Array<() => void> = [];
  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    /** How many surfaces are being watched. */
    get observed() {
      return callbacks.length;
    },
    fire() {
      for (const callback of callbacks) callback();
    },
  };
}

describe("useMenuOpenUp", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reasons in viewport coordinates", () => {
    // Every number below is a distance from the top and the bottom of the
    // window, so the cases are only meaningful against a known height. jsdom
    // settles on 768; if that ever changes, these cases have to be re-read
    // rather than quietly start passing for the wrong reason.
    expect(window.innerHeight).toBe(VIEWPORT_HEIGHT);
  });

  it("leaves a menu alone when the room below clears the player chrome", () => {
    // A trigger 300px up a 768px viewport, a 200px menu: 268px of gap, well
    // past the 120px clearance. Opening upward here would cover the rows the
    // user is reading for no reason.
    expect(setup({ trigger: [260, 300] }).result.current).toBe(false);
  });

  it("flips when the menu would come to rest on the player", () => {
    // Bottom 700: a 200px menu ends 132px BELOW the fold, and the transport
    // is 120px tall. Above there are 460px, so up is the only sane side.
    expect(setup({ trigger: [660, 700] }).result.current).toBe(true);
  });

  it("measures the surface that is actually in the slot", () => {
    // One trigger, two surfaces. The 200px row menu ends 128px above the
    // fold and stays down. The 300px playlist picker that replaces it in the
    // same slot would end 28px above the fold - on top of the transport -
    // while 100px of room sits above, so it flips. A rule that assumed a
    // menu height would get this one wrong in the direction that matters.
    expect(setup({ trigger: [400, 440], height: 200 }).result.current).toBe(false);
    expect(setup({ trigger: [400, 440], height: 300 }).result.current).toBe(true);
  });

  it("reads a surface the host points at directly", () => {
    // The queue's menu is rendered in the panel's layer, so the ref is the
    // surface itself rather than a wrapper containing one.
    expect(setup({ trigger: [660, 700], surfaceIsHost: true }).result.current).toBe(true);
    expect(setup({ trigger: [260, 300], surfaceIsHost: true }).result.current).toBe(false);
  });

  it("refuses to flip into the worse gap", () => {
    // A menu taller than the space on either side is clipped no matter what.
    // Flipping from a 72px shortfall to a 600px one is not a fix, so the
    // surface stays where it is.
    expect(setup({ trigger: [100, 140], height: 700 }).result.current).toBe(false);
  });

  it("picks the roomier side when neither fits", () => {
    // Both sides overflow; 40px of clipping beats 632px of it.
    expect(setup({ trigger: [660, 700], height: 700 }).result.current).toBe(true);
  });

  it("clears a previous flip once the room below comes back", () => {
    // The state outlives one opening: the menu is closed and reopened on the
    // same mount, and a menu that opened upward at the bottom of a list must
    // not still be upward at the top of it, where there is 600px of room
    // below and the top of the screen above. The early return that the
    // cramped branch used to make left the old value standing, so this is
    // the regression that would have shipped as "sometimes it opens the
    // wrong way".
    const view = setup({ trigger: [660, 700] });
    expect(view.result.current).toBe(true);

    // Plenty of room below now.
    stubRect(view.triggerEl, { top: 100, bottom: 140 });
    view.rerender({ isOpen: false });
    view.rerender({ isOpen: true });

    expect(view.result.current).toBe(false);
  });

  it("does nothing while closed, and survives a surface that is not there yet", () => {
    expect(setup({ open: false, trigger: [660, 700] }).result.current).toBe(false);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const triggerEl = document.createElement("button");
    stubRect(triggerEl, { top: 660, bottom: 700 });
    const host = document.createElement("div");
    container.append(triggerEl, host);
    const { result } = renderHook(() => {
      const triggerRef = useRef<HTMLElement | null>(null);
      const surfaceRef = useRef<HTMLElement | null>(null);
      triggerRef.current = triggerEl;
      surfaceRef.current = host;
      return useMenuOpenUp({ open: true, triggerRef, surfaceRef });
    });
    expect(result.current).toBe(false);
  });

  describe("when a taller surface swaps into the same slot", () => {
    /**
     * The row menu and the playlist picker occupy ONE slot: opening the picker
     * replaces the row menu while the menu stays open. `open` does not change,
     * so `placementKey` is the only thing that can tell the rule the surface it
     * is now judging is a different one.
     *
     * These are the numbers from the real failure. A 5-item row menu is ~200px
     * and clears the 120px transport clearance from a trigger at [400, 440] in
     * a 768px viewport, so it stays down. The picker that replaces it in the
     * same slot is ~330px: it ends 158px below the fold, on top of the player
     * bar, while 160px of room sits above. Judged on the row menu's height the
     * picker is left pointing into the transport, where its lower items are
     * visible, unclickable, and blocking "add to playlist" for exactly the
     * users with the most playlists.
     */
    function setupSwap() {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const triggerEl = document.createElement("button");
      const surfaceEl = document.createElement("div");
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      surfaceEl.appendChild(menu);
      stubRect(triggerEl, { top: 400, bottom: 440 });
      stubRect(menu, { height: 200 });
      container.append(triggerEl, surfaceEl);

      const view = renderHook(
        ({ key }: { key: string }) => {
          const triggerRef = useRef<HTMLElement | null>(null);
          const surfaceRef = useRef<HTMLElement | null>(null);
          triggerRef.current = triggerEl;
          surfaceRef.current = surfaceEl;
          return useMenuOpenUp({
            open: true,
            triggerRef,
            surfaceRef,
            placementKey: key,
          });
        },
        { initialProps: { key: "row-menu" } },
      );
      return { ...view, menu };
    }

    it("re-judges the new surface when the key changes", () => {
      const view = setupSwap();
      // The short row menu fits below, so it opens down.
      expect(view.result.current).toBe(false);

      // The picker swaps in, taller, without the menu ever closing.
      stubRect(view.menu, { height: 330 });
      view.rerender({ key: "playlist-picker" });

      expect(view.result.current).toBe(true);
    });

    it("keeps the stale verdict when no key is supplied", () => {
      // The failure itself, stated as a test: the surface changed and the
      // decision did not, because nothing told it to look again. This is the
      // case a host hits by omitting `placementKey` - the queue panel passes
      // one, and the row menu's host now does too.
      const view = setupSwap();
      expect(view.result.current).toBe(false);

      stubRect(view.menu, { height: 330 });
      view.rerender({ key: "row-menu" });

      expect(view.result.current).toBe(false);
    });
  });

  describe("when the surface changes size after the decision", () => {
    /**
     * The playlist picker mounts with a header and an empty list and then
     * fills in, because the list is a server action. Measured 2026-09-27: 131px
     * with one playlist, ~330px with nine. A verdict taken against the 131px
     * version says there is room below, and by the time the ninth playlist
     * lands the lower items are under the fixed player bar - visible,
     * unclickable, and blocking "add to playlist" for exactly the users with
     * the most playlists.
     *
     * `placementKey` cannot see this, which is why the swap case above needed
     * it and this one still failed after it: the surface here never changes
     * identity, only size. The decision has to be re-made when the SIZE
     * changes, which is what the platform's size signal is for.
     */
    it("re-judges when the surface grows past the clearance", () => {
      const observer = stubResizeObserver();
      // The empty picker clears the 120px transport clearance from here.
      const view = setup({ trigger: [400, 440], height: 131 });
      expect(view.result.current).toBe(false);
      expect(observer.observed).toBe(1);

      // The list arrives; the surface is 200px taller and no longer fits.
      stubRect(view.menuEl, { height: 330 });
      act(() => observer.fire());

      expect(view.result.current).toBe(true);
    });

    it("re-judges when the viewport changes", () => {
      // A phone rotation re-derives both numbers while the menu keeps its size,
      // so the size signal stays silent and the decision would be stale in the
      // one direction that matters: a short landscape viewport leaves a menu
      // that fitted in portrait resting on the transport.
      stubResizeObserver();
      const view = setup({ trigger: [400, 440], height: 200 });
      expect(view.result.current).toBe(false);
      expect(window.innerHeight).toBe(VIEWPORT_HEIGHT);

      act(() => {
        Object.defineProperty(window, "innerHeight", {
          value: 520,
          configurable: true,
        });
        window.dispatchEvent(new Event("resize"));
      });

      // 520 - 440 - 200 = -120px of room below, against 200px above.
      expect(view.result.current).toBe(true);
    });
  });
});
