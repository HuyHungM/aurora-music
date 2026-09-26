// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  InfiniteListeningCoordinator,
  KeepListeningStatus,
} from "@/lib/listening/coordinator";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/listening", () => ({
  setKeepListeningAction: vi.fn(),
}));

vi.mock("@/lib/listening/instance", () => ({
  getKeepListeningCoordinator: vi.fn(),
  subscribeKeepListeningCoordinator: vi.fn(() => () => undefined),
}));

import { KeepListeningToggle } from "@/components/player/keep-listening-toggle";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { setKeepListeningAction } from "@/app/actions/listening";
import { getKeepListeningCoordinator } from "@/lib/listening/instance";
import { resetKeepListeningSaveState } from "@/lib/listening/use-keep-listening";

/**
 * The autoplay row in the queue panel.
 *
 * The control's own semantics (pressed state, label, tooltip, active
 * treatment, glyph) are covered in `autoplay-control.test.tsx`; this file
 * covers the row that wraps it — the explanation, the spelled-out state, the
 * write and its rollback, and the availability rules.
 *
 * Three properties are under test:
 *
 *  1. DEFAULT — the feature is OFF until the listener asks for it, and the
 *     control is OFF by default, not ON.
 *  2. HONESTY — the rendered state comes from the coordinator, never from a
 *     second local copy, and a failed write rolls the toggle back.
 *  3. HONESTY ABOUT AVAILABILITY — an anonymous listener gets no control,
 *     because there is no account to store the preference on.
 */

function status(overrides: Partial<KeepListeningStatus> = {}): KeepListeningStatus {
  return {
    enabled: false,
    authenticated: true,
    generating: false,
    exhausted: false,
    error: null,
    generatedTotal: 0,
    ...overrides,
  };
}

/**
 * A coordinator double that satisfies the contract the component relies on:
 * a referentially stable `getState()` that returns a NEW object only when
 * something changed, plus `setEnabled`.
 */
function fakeCoordinator(initial: Partial<KeepListeningStatus> = {}) {
  let current = status(initial);
  const setEnabled = vi.fn((enabled: boolean) => {
    if (current.enabled === enabled) return;
    current = { ...current, enabled };
  });
  return {
    setEnabled,
    getState: () => current,
    set(next: Partial<KeepListeningStatus>) {
      current = { ...current, ...next };
    },
  } as unknown as InfiniteListeningCoordinator & {
    setEnabled: ReturnType<typeof vi.fn>;
    set: (next: Partial<KeepListeningStatus>) => void;
  };
}

function renderToggle() {
  return render(
    <LocaleProvider initialLocale="en">
      <KeepListeningToggle />
    </LocaleProvider>,
  );
}

function control() {
  return screen.getByRole("button", { name: /autoplay/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The save result is a module-level singleton shared by every surface, so it
  // has to be reset explicitly or one test's rollback alert leaks into the next.
  resetKeepListeningSaveState();
  vi.mocked(setKeepListeningAction).mockResolvedValue({ ok: true, enabled: true });
});

afterEach(() => {
  cleanup();
});

describe("the autoplay row: default state", () => {
  it("renders off, because the feature is opt-in (§57)", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(fakeCoordinator());
    renderToggle();
    expect(control().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("reports on when the coordinator is on", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(
      fakeCoordinator({ enabled: true }),
    );
    renderToggle();
    expect(control().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("On")).toBeTruthy();
  });

  // One interactive control per surface. A second toggle in the settings, or a
  // second copy of the preference anywhere, would let two surfaces disagree.
  it("renders exactly one control", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(fakeCoordinator());
    renderToggle();
    expect(screen.getAllByRole("button", { name: /autoplay/i })).toHaveLength(1);
  });
});

describe("the autoplay row: availability", () => {
  // An anonymous listener has no account to persist the preference, so a
  // control that cannot save would be a lie.
  it("renders nothing for an anonymous listener", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(
      fakeCoordinator({ authenticated: false }),
    );
    const { container } = renderToggle();
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button", { name: /autoplay/i })).toBeNull();
  });

  // Before the PlayerHost effect creates the coordinator there is no state to
  // bind to; rendering a guess would flash the wrong value on hydration.
  it("renders nothing before a coordinator exists", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(null);
    const { container } = renderToggle();
    expect(container.textContent).toBe("");
  });
});

describe("the autoplay row: toggling", () => {
  it("tells the coordinator first, then persists", async () => {
    const coordinator = fakeCoordinator();
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(coordinator);
    renderToggle();

    await userEvent.setup().click(control());

    await waitFor(() => {
      expect(coordinator.setEnabled).toHaveBeenCalledWith(true);
    });
    expect(setKeepListeningAction).toHaveBeenCalledWith(true);
  });

  it("turns off again, asking for the opposite of the current value", async () => {
    const coordinator = fakeCoordinator({ enabled: true });
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(coordinator);
    renderToggle();

    await userEvent.setup().click(control());

    await waitFor(() => {
      expect(coordinator.setEnabled).toHaveBeenCalledWith(false);
    });
    expect(setKeepListeningAction).toHaveBeenCalledWith(false);
  });

  // A failed write must not leave the control showing a setting that was never
  // saved — that is a lie the listener will discover only after a reload.
  it("rolls the toggle back and reports the failure", async () => {
    vi.mocked(setKeepListeningAction).mockResolvedValue({
      ok: false,
      error: "Failed to update preference",
    });
    const coordinator = fakeCoordinator();
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(coordinator);
    renderToggle();

    await userEvent.setup().click(control());

    expect(await screen.findByRole("alert")).toBeTruthy();
    // Rolled back: the coordinator was told to go on, then to go back off.
    expect(coordinator.setEnabled).toHaveBeenNthCalledWith(1, true);
    expect(coordinator.setEnabled).toHaveBeenNthCalledWith(2, false);
  });

  /**
   * Phase 49 regression. A server action's body try/catches and resolves
   * `{ok:false}`, but the transport rejects on a network drop. The unguarded
   * `await` then skipped BOTH the rollback and `setSaveState({pending:false})`,
   * so the control stayed flipped to a value that was never persisted and
   * `toggle` early-returns forever after — the setting cannot be changed again
   * in that session, from any surface bound to the coordinator.
   */
  it("rolls back and re-enables when the write rejects", async () => {
    vi.mocked(setKeepListeningAction).mockRejectedValue(
      new Error("network down"),
    );
    const coordinator = fakeCoordinator();
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(coordinator);
    renderToggle();

    await userEvent.setup().click(control());

    // The failure is surfaced, not swallowed.
    expect(await screen.findByRole("alert")).toBeTruthy();
    // Rolled back: told on, then told back off.
    expect(coordinator.setEnabled).toHaveBeenNthCalledWith(1, true);
    expect(coordinator.setEnabled).toHaveBeenNthCalledWith(2, false);

    // And the control is live again: a second click reaches the action. This
    // is the assertion that matters — a stuck `pending` would make this a
    // silent no-op and the whole control permanently dead.
    await userEvent.setup().click(control());
    await waitFor(() => {
      expect(vi.mocked(setKeepListeningAction)).toHaveBeenCalledTimes(2);
    });
  });

  it("cannot be double-toggled while the write is in flight", async () => {
    let release!: () => void;
    vi.mocked(setKeepListeningAction).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, enabled: true });
      }),
    );
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(fakeCoordinator());
    renderToggle();

    const button = control();
    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(true);
    });
    await userEvent.setup().click(button).catch(() => undefined);
    expect(setKeepListeningAction).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  it("does nothing when no coordinator is present", async () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(null);
    renderToggle();
    // Nothing to click, so nothing can be called.
    expect(setKeepListeningAction).not.toHaveBeenCalled();
  });
});

describe("the autoplay row: reflects coordinator activity", () => {
  // The row keeps no second copy of the state, so coordinator progress shows
  // up without anything being told to re-render.
  it("announces that it is generating", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(
      fakeCoordinator({ enabled: true, generating: true }),
    );
    renderToggle();
    expect(screen.getByText("Finding more music...")).toBeTruthy();
  });

  it("stays interactive while generating", () => {
    vi.mocked(getKeepListeningCoordinator).mockReturnValue(
      fakeCoordinator({ enabled: true, generating: true }),
    );
    renderToggle();
    expect(control().hasAttribute("disabled")).toBe(false);
    expect(control().getAttribute("aria-pressed")).toBe("true");
  });
});
