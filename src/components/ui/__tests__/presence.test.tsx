// @vitest-environment jsdom
/**
 * The presence lifecycle, tested directly (Phase 48).
 *
 * These are the tests that make the primitive trustworthy enough for the
 * rest of the app to delegate to it. They cover the four properties every
 * dismissible surface now depends on, and each one is a way the previous
 * `{open ? <div/> : null}` pattern was broken:
 *
 *   1. the element outlives `open=false` long enough to animate out
 *   2. it is genuinely gone afterwards, so nothing leaks
 *   3. rapid toggling cannot strand it mounted or unmounted
 *   4. it leaves the accessibility tree while exiting, so it neither traps
 *      focus nor swallows clicks
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  Presence,
  usePresence,
  PRESENCE_ENTER_MS,
  PRESENCE_EXIT_MS,
} from "@/components/ui/presence";

afterEach(() => {
  cleanup();
});

function Harness({
  open: controlledOpen,
  exitMs,
  label = "panel",
}: {
  open?: boolean;
  exitMs?: number;
  label?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  return (
    <>
      <button type="button" onClick={() => setUncontrolled((v) => !v)}>
        toggle
      </button>
      <Presence
        open={open}
        variant="pop"
        exitMs={exitMs}
        role="dialog"
        aria-label={label}
      >
        panel body
      </Presence>
    </>
  );
}

function exitingNode(): HTMLElement | null {
  // Deliberately NOT a role query. An element that is `inert` is removed
  // from the accessibility tree, which is the entire point of marking it
  // inert — so a `getByRole` lookup would be asserting the opposite of the
  // contract. The question being asked here is "is it still in the
  // document, and is it marked as leaving".
  return document.querySelector<HTMLElement>('[data-presence="exiting"]');
}

describe("usePresence / Presence", () => {
  it("mounts when opened and starts in the entering state", () => {
    render(<Harness open />);
    const panel = screen.getByRole("dialog", { name: "panel" });
    expect(panel.getAttribute("data-presence")).toBe("entering");
  });

  it("settles into entered once the entrance is over", async () => {
    render(<Harness open />);
    await waitFor(
      () => {
        expect(
          screen.getByRole("dialog", { name: "panel" }).getAttribute("data-presence"),
        ).toBe("entered");
      },
      { timeout: PRESENCE_ENTER_MS + 500 },
    );
  });

  it("stays mounted after close so the exit can play", async () => {
    const { rerender } = render(<Harness open />);
    rerender(<Harness open={false} />);
    // This is the assertion the old implementation could not have made: the
    // element is still here, one tick after it was told to close.
    expect(exitingNode()).toBeTruthy();
  });

  it("unmounts once the exit completes", async () => {
    const { rerender } = render(<Harness open />);
    rerender(<Harness open={false} />);
    await waitFor(
      () => {
        expect(screen.queryByRole("dialog", { name: "panel" })).toBeNull();
      },
      { timeout: PRESENCE_EXIT_MS + 500 },
    );
  });

  it("marks the element inert while exiting, and not otherwise", async () => {
    const { rerender } = render(<Harness open />);
    const panel = screen.getByRole("dialog", { name: "panel" });
    expect(panel.hasAttribute("inert")).toBe(false);
    rerender(<Harness open={false} />);
    // The CSS rule that makes it unclickable lives in globals.css; this
    // asserts the attribute that rule keys on is actually applied.
    expect(exitingNode()?.hasAttribute("inert")).toBe(true);
  });

  it("survives open -> immediate close without stranding the element", async () => {
    const { rerender } = render(<Harness open={false} />);
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    // It must still be mounted (exiting), then clean up on schedule. If the
    // mount were only recorded in an effect, `phase` would still read
    // "unmounted" here and the element would snap away with no exit at all.
    expect(exitingNode()).toBeTruthy();
    await waitFor(
      () => {
        expect(screen.queryByRole("dialog", { name: "panel" })).toBeNull();
      },
      { timeout: PRESENCE_EXIT_MS + 500 },
    );
  });

  it("survives close -> immediate reopen without stranding the element", async () => {
    const { rerender } = render(<Harness open />);
    rerender(<Harness open={false} />);
    // Reopening mid-exit must cancel the pending unmount, not race it.
    rerender(<Harness open />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, PRESENCE_EXIT_MS + 120));
    });
    const panel = screen.getByRole("dialog", { name: "panel" });
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("data-presence")).not.toBe("exiting");
  });
  it("calls onExited once, after the exit, not before", async () => {
    const calls: number[] = [];
    function ExitSpy() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
          <Presence
            open={open}
            variant="pop"
            exitMs={40}
            onExited={() => calls.push(Date.now())}
            role="dialog"
            aria-label="panel"
          >
            panel body
          </Presence>
        </>
      );
    }
    render(<ExitSpy />);
    screen.getByRole("button", { name: "close" }).click();
    // Not called synchronously: focus restoration must not happen while the
    // element is still on screen.
    expect(calls).toHaveLength(0);
    await waitFor(
      () => {
        expect(calls).toHaveLength(1);
      },
      { timeout: 1000 },
    );
    expect(screen.queryByRole("dialog", { name: "panel" })).toBeNull();
  });

  it("does not fire a pending exit into an unmounted component", async () => {
    const { unmount } = render(<Harness open />);
    // No assertion needed beyond "this does not warn or throw": the hook
    // clears its timer on unmount, so React never processes a state update
    // on a dead component.
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, PRESENCE_EXIT_MS + 120));
    });
    expect(screen.queryByRole("dialog", { name: "panel" })).toBeNull();
  });

  it("applies the requested variant class and merges className", () => {
    render(
      <Presence open variant="menu" direction="up" className="extra">
        <span data-testid="child" />
      </Presence>,
    );
    const host = screen.getByTestId("child").parentElement as HTMLElement;
    expect(host.className).toContain("presence-menu-up");
    expect(host.className).toContain("extra");
  });

  it("exposes stable duration constants that match the CSS tokens", () => {
    // If these drift from globals.css the exit either outlasts the
    // animation (a visible ghost) or cuts it short (a snap). The CSS
    // values are --p-duration-normal / --p-duration-fast.
    expect(PRESENCE_ENTER_MS).toBe(220);
    expect(PRESENCE_EXIT_MS).toBe(140);
  });
});

describe("usePresence", () => {
  it("reports mounted synchronously on the opening render", () => {
    // The property that makes "move focus into the panel on open" work.
    // If `mounted` lagged a render behind `open`, every consumer effect
    // keyed on `open` would see a null ref.
    const { result } = renderHook(() => usePresence(true));
    expect(result.current.mounted).toBe(true);
    expect(result.current.state).toBe("entering");
  });

  it("starts unmounted when closed, with nothing to show", () => {
    const { result } = renderHook(() => usePresence(false));
    expect(result.current.mounted).toBe(false);
  });

  it("keeps `mounted` true for the exit budget after close", async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => usePresence(open, { exitMs: 40 }),
      { initialProps: { open: true } },
    );
    expect(result.current.mounted).toBe(true);
    rerender({ open: false });
    expect(result.current.mounted).toBe(true);
    expect(result.current.state).toBe("exiting");
    await waitFor(() => {
      expect(result.current.mounted).toBe(false);
    });
  });

  it("puts `inert` on the props exactly while exiting", async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => usePresence(open, { exitMs: 40 }),
      { initialProps: { open: true } },
    );
    expect(result.current.presenceProps.inert).toBe(false);
    rerender({ open: false });
    expect(result.current.presenceProps.inert).toBe(true);
    await waitFor(() => {
      expect(result.current.mounted).toBe(false);
    });
  });

  it("cancels a pending exit when reopened, so it never unmounts", async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => usePresence(open, { exitMs: 40 }),
      { initialProps: { open: true } },
    );
    rerender({ open: false });
    rerender({ open: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(result.current.mounted).toBe(true);
    expect(result.current.state).not.toBe("exiting");
  });

  it("does not call onExited when an exit is interrupted", async () => {
    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        usePresence(open, {
          exitMs: 40,
          onExited: () => calls.push(1),
        }),
      { initialProps: { open: true } },
    );
    rerender({ open: false });
    rerender({ open: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    // The element never left, so it never finished leaving.
    expect(calls).toHaveLength(0);
  });
});
