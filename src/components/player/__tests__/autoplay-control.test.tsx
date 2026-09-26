// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  InfiniteListeningCoordinator,
  KeepListeningStatus,
} from "@/lib/listening/coordinator";

/**
 * The autoplay control's visible contract.
 *
 * The feature itself is covered behaviourally elsewhere — the coordinator has
 * 31 tests for WHEN it generates and what it appends, and `actions/listening`
 * covers the persistence. What is under test here is the part a listener
 * actually looks at, and the four ways that can quietly go wrong:
 *
 *  1. STATE HONESTY — the rendered ON/OFF is the coordinator's state, never a
 *     local copy, so the icon cannot claim autoplay is on when the queue is
 *     not being continued.
 *  2. ONE VISUAL LANGUAGE — the player and the queue panel render the same
 *     control, so they cannot drift into two icons, two colours or two
 *     tooltips for one feature.
 *  3. DISTINCTNESS — the glyph must not be shuffle, repeat, radio or the
 *     queue button it sits next to. This is asserted against the actual path
 *     data, not against a comment about the design.
 *  4. ACCESSIBILITY — a real `aria-pressed`, an action-shaped accessible name,
 *     and a tooltip that states the current state.
 */

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let current: unknown = null;
  return {
    get: () => current,
    set(next: unknown) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    reset() {
      current = null;
      listeners.clear();
    },
  };
});

const subscriptionSpies = vi.hoisted(() => ({ subscribe: vi.fn() }));

// Mirrors `lib/listening/instance.ts` exactly — a module-level singleton plus a
// notify-on-every-change listener set — so the component under test is bound
// to the real contract rather than to a stub that never fires.
vi.mock("@/lib/listening/instance", () => ({
  getKeepListeningCoordinator: () => store.get(),
  subscribeKeepListeningCoordinator: (listener: () => void) => {
    subscriptionSpies.subscribe(listener);
    return store.subscribe(listener);
  },
}));

vi.mock("@/app/actions/listening", () => ({
  setKeepListeningAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

import { AutoplayButton } from "@/components/player/autoplay-button";
import { KeepListeningToggle } from "@/components/player/keep-listening-toggle";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { setKeepListeningAction } from "@/app/actions/listening";
import { resetKeepListeningSaveState } from "@/lib/listening/use-keep-listening";
import {
  AutoContinueIcon,
  QueueIcon,
  RadioIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipForwardIcon,
} from "@/components/ui/icons";

function baseStatus(
  overrides: Partial<KeepListeningStatus> = {},
): KeepListeningStatus {
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
 * A coordinator double that keeps the one property the UI depends on:
 * `getState()` returns a NEW object whenever something changed, and the store
 * is notified. Returning a fresh object every call would make React loop.
 */
function installCoordinator(overrides: Partial<KeepListeningStatus> = {}) {
  let state = baseStatus(overrides);
  const coordinator = {
    getState: () => state,
    setEnabled(enabled: boolean) {
      if (state.enabled === enabled) return;
      state = { ...state, enabled };
      store.set(coordinator);
    },
  };
  store.set(coordinator);
  return coordinator as unknown as InfiniteListeningCoordinator & {
    setEnabled: (enabled: boolean) => void;
  };
}

function renderIn(ui: React.ReactElement) {
  return render(<LocaleProvider initialLocale="en">{ui}</LocaleProvider>);
}

function autoplayButton() {
  return screen.getByRole("button", { name: /autoplay/i });
}

beforeEach(() => {
  store.reset();
  subscriptionSpies.subscribe.mockClear();
  resetKeepListeningSaveState();
  vi.mocked(setKeepListeningAction).mockResolvedValue({ ok: true, enabled: true });
});

afterEach(() => {
  cleanup();
});

describe("autoplay control: state and semantics", () => {
  it("renders off, and names the action it will perform", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);

    const button = autoplayButton();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Turn autoplay on");
    // A static "Autoplay" label would tell a screen-reader user the control
    // exists and nothing about what pressing it does.
    expect(button.getAttribute("aria-label")).not.toBe("Autoplay");
  });

  it("renders on, names the opposite action, and shows the active treatment", () => {
    installCoordinator({ enabled: true });
    renderIn(<AutoplayButton />);

    const button = autoplayButton();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Turn autoplay off");
    // The active state is accent colour AND a ring — a shape change, so it
    // survives a greyscale render and a future light theme.
    expect(button.className).toContain("text-accent");
    expect(button.className).toContain("ring-2");
  });

  it("leaves the off state visually neutral", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);

    const className = autoplayButton().className;
    expect(className).not.toContain("text-accent");
    expect(className).not.toContain("ring-2");
  });

  it("turns autoplay on when pressed, and persists it", async () => {
    const coordinator = installCoordinator();
    renderIn(<AutoplayButton />);

    await userEvent.setup().click(autoplayButton());

    await waitFor(() => {
      expect(coordinator.getState().enabled).toBe(true);
    });
    expect(setKeepListeningAction).toHaveBeenCalledWith(true);
    expect(autoplayButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("reports the current state in its tooltip", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);
    expect(autoplayButton().getAttribute("title")).toBe("Autoplay: Off");

    installCoordinator({ enabled: true });
    renderIn(<AutoplayButton />);
    // Two controls in one tree is not the case under test; read the second.
    expect(screen.getAllByRole("button", { name: /autoplay/i })[1].getAttribute("title")).toBe(
      "Autoplay: On",
    );
  });
});

describe("autoplay control: reads the runtime state", () => {
  // §15: the icon must show what the coordinator is doing. A local copy would
  // go stale the moment generation finished or a save failed.
  it("follows the coordinator without being clicked", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);
    expect(autoplayButton().getAttribute("aria-pressed")).toBe("false");

    act(() => store.set(installCoordinator({ enabled: true, generating: true })));

    expect(autoplayButton().getAttribute("aria-pressed")).toBe("true");
  });

  // PlayerHost creates the coordinator in an effect, so the control mounts
  // before the thing it reads exists. Collapsing the two store bindings into
  // one is only safe if that transition still re-renders.
  it("appears once a coordinator is created after mount", () => {
    renderIn(<AutoplayButton />);
    expect(screen.queryByRole("button", { name: /autoplay/i })).toBeNull();

    act(() => store.set(installCoordinator()));

    expect(screen.getByRole("button", { name: /autoplay/i })).toBeTruthy();
  });

  it("disappears again if the coordinator goes away", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);
    act(() => store.set(null));
    expect(screen.queryByRole("button", { name: /autoplay/i })).toBeNull();
  });
});

describe("autoplay control: cost of staying in sync", () => {
  // §28: the icon state should be cheap. A control that re-subscribes per
  // render would be an unbounded listener leak; a control that needs two store
  // bindings to read one object is paying twice for one fact.
  it("takes exactly one coordinator subscription, and it does not grow", () => {
    installCoordinator();
    renderIn(<AutoplayButton />);

    expect(subscriptionSpies.subscribe.mock.calls).toHaveLength(1);

    for (const next of [
      { enabled: true },
      { enabled: true, generating: true },
      { enabled: false },
    ]) {
      act(() => store.set(installCoordinator(next)));
    }

    expect(subscriptionSpies.subscribe.mock.calls).toHaveLength(1);
    expect(store.listenerCount()).toBe(1);
  });

  it("releases its subscription on unmount", () => {
    installCoordinator();
    const { unmount } = renderIn(<AutoplayButton />);
    expect(store.listenerCount()).toBe(1);
    unmount();
    expect(store.listenerCount()).toBe(0);
  });
});

describe("autoplay control: availability", () => {
  // An anonymous listener has no account to store the preference on.
  it("renders nothing for an anonymous listener", () => {
    installCoordinator({ authenticated: false });
    const { container } = renderIn(<AutoplayButton />);
    expect(container.textContent).toBe("");
  });
});

describe("autoplay control: generating state", () => {
  it("marks itself busy without replacing the icon", () => {
    installCoordinator({ enabled: true, generating: true });
    const { container } = renderIn(<AutoplayButton />);

    const button = autoplayButton();
    expect(button.getAttribute("aria-busy")).toBe("true");
    // The icon must stay: a control that swaps its glyph while working looks
    // like it changed identity, and the badge must not read as an audio
    // spinner.
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("is not busy when it is not generating", () => {
    installCoordinator({ enabled: true });
    const { container } = renderIn(<AutoplayButton />);
    expect(autoplayButton().getAttribute("aria-busy")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("never animates the icon itself", () => {
    installCoordinator({ enabled: true });
    const { container } = renderIn(<AutoplayButton />);
    // A looping animation on the glyph would run for as long as autoplay is
    // on, which is a noise generator, not an affordance.
    expect(container.querySelector("svg")?.className.baseVal ?? "").not.toContain("animate");
  });
});

describe("autoplay control: one visual language across surfaces", () => {
  it("the queue panel offers the same control, not a second dialect", () => {
    installCoordinator();
    renderIn(<KeepListeningToggle />);

    const buttons = screen.getAllByRole("button", { name: /autoplay/i });
    // Exactly one. The row used to pair a decorative icon with a separate
    // switch pill, leaving two interactive-looking halves.
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("Turn autoplay on");
    expect(buttons[0].getAttribute("title")).toBe("Autoplay: Off");
  });

  it("the queue row spells the state out in text as well as colour", () => {
    installCoordinator({ enabled: true });
    renderIn(<KeepListeningToggle />);
    // A high-contrast or greyscale reader gets the state from this, not from
    // the accent colour.
    expect(screen.getByText("On")).toBeTruthy();
  });
});

describe("the autoplay glyph is not another transport glyph", () => {
  function pathsOf(element: ReactElement): string[] {
    const { container } = render(element);
    const data = [...container.querySelectorAll("path")].map(
      (node) => node.getAttribute("d") ?? "",
    );
    cleanup();
    return data;
  }

  const autoplay = pathsOf(<AutoContinueIcon />);

  it("shares no path data with shuffle, repeat, repeat-one or the queue button", () => {
    // §4: they must never share the same icon. Comparing the rendered path
    // data is the only honest way to assert that without a pixel diff — a
    // comment about the design proves nothing.
    for (const [name, other] of [
      ["shuffle", <ShuffleIcon key="s" />],
      ["repeat", <RepeatIcon key="r" />],
      ["repeat-one", <RepeatOneIcon key="r1" />],
      ["queue", <QueueIcon key="q" />],
      ["radio", <RadioIcon key="rad" />],
      ["skip-forward", <SkipForwardIcon key="n" />],
    ] as const) {
      const others = pathsOf(other);
      expect(others.length, name).toBeGreaterThan(0);
      const shared = autoplay.filter((d) => others.includes(d));
      expect(shared, `autoplay shares a path with ${name}`).toEqual([]);
    }
  });

  it("is an open one-way flow, not a closed loop", () => {
    // The decisive difference from `RepeatIcon` is not the styling, it is the
    // topology: repeat is a closed ring with an arrowhead at both ends, this
    // is a strand that leaves and does not come back. So — exactly one
    // relative-moveto path, the arrowhead, and no second one anywhere.
    expect(autoplay).toHaveLength(3);
    const arrowheads = autoplay.filter((d) => d.startsWith("m"));
    expect(arrowheads).toHaveLength(1);
  });
});
