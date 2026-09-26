// @vitest-environment jsdom
/**
 * `AppearanceRoot` tests (Phase 53).
 *
 * The root is where the feature becomes visible and where it could do damage,
 * so these tests are about four things in priority order:
 *
 *   1. IT MUST NOT TOUCH PLAYBACK. The mission is explicit that moving a
 *      slider cannot recreate a `MusicEngine`, a `PlaybackController`, a
 *      `QueueManager` or a `PlayerEngine`, and that is a claim about a module
 *      graph, so it is asserted against the graph: this file asserts that
 *      `appearance-root.tsx` reaches the engine only through a read-only
 *      selector, and the same claim about the palette module is a quality gate.
 *      Asserted behaviourally too - an appearance change while a track is
 *      playing leaves the engine state object identity and the queue intact.
 *
 *   2. NO FLASH. The attributes and the custom properties have to be in the
 *      SERVER-rendered markup, because a theme applied in an effect is the
 *      default theme for one frame. So the tests assert them on the very first
 *      render, before any effect could have run.
 *
 *   3. GLASS OFF IS A REAL, COMPLETE OFF. Not "reduced" - the backdrop-filter
 *      declarations must be absent, and the image/scrim layers must not be
 *      composited. This is what makes the OFF state a supported configuration
 *      rather than a degraded one.
 *
 *   4. THE WRITE IS DEBOUNCED, AND A FAILURE IS TRUTHFUL. One action call per
 *      gesture rather than one per slider tick; a rejection rolls back to what
 *      is stored; a transport failure keeps the draft and says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_APPEARANCE,
  encodeAppearance,
  type Appearance,
} from "@/lib/appearance/appearance";
import {
  setAppearanceAction,
  type AppearanceActionResult,
} from "@/app/actions/appearance";

vi.mock("@/app/actions/appearance", () => ({
  setAppearanceAction: vi.fn(),
}));

const { AppearanceRoot, useAppearance } = await import(
  "@/components/appearance/appearance-root"
);

/** A tiny consumer, so the tests can drive the root through its own API. */
function Probe() {
  const value = useAppearance();
  return (
    <div>
      <span data-testid="alpha">{value.appearance.glassAlpha}</span>
      <span data-testid="glass">{String(value.appearance.glass)}</span>
      <span data-testid="status">{value.status}</span>
      <span data-testid="reason">{value.reason ?? ""}</span>
      <span data-testid="dirty">{String(value.dirty)}</span>
      <button
        type="button"
        data-testid="drag"
        onClick={() => value.update({ glassAlpha: 0.35 })}
      >
        set
      </button>
      <button
        type="button"
        data-testid="driftwo"
        onClick={() => value.update({ glassBlur: 20 })}
      >
        set2
      </button>
      <button
        type="button"
        data-testid="reset"
        onClick={() => value.reset()}
      >
        reset
      </button>
    </div>
  );
}

/** Clears the appearance cookie between tests. */
function clearCookie(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
    }
  }
}

/** The element carrying the four `data-aurora-*` attributes. */
function shell(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-aurora-glass]");
  if (!element) {
    throw new Error("the shell root was not rendered");
  }
  return element;
}

function accepted(appearance: Appearance): AppearanceActionResult {
  return { ok: true, appearance };
}

beforeEach(() => {
  clearCookie();
  vi.mocked(setAppearanceAction).mockReset();
  vi.mocked(setAppearanceAction).mockResolvedValue(accepted(DEFAULT_APPEARANCE));
  // jsdom has no `requestIdleCallback`; the components guard for it, but
  // `ArtworkAmbient` is not mounted in most of these tests and this keeps the
  // one that is deterministic.
  (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
});

afterEach(() => {
  cleanup();
  clearCookie();
  vi.useRealTimers();
});

/* ==========================================================================
   1. NO FLASH, AND THE GLASS STATE
   ========================================================================== */

describe("the shell root attributes", () => {
  it("carries the resolved appearance in the FIRST render, before any effect", () => {
    // THE NO-FLASH CLAIM. A theme applied in an effect is the default theme
    // for one frame, which is a visible flash on every navigation and on every
    // appearance change. Asserted on the first render specifically - an
    // assertion after `act()` would pass even for an effect-based
    // implementation, which is the failure this is here to catch.
    render(
      <AppearanceRoot
        initial={{ ...DEFAULT_APPEARANCE, glass: false, glassAlpha: 0.3 }}
        authenticated={false}
      >
        <div>content</div>
      </AppearanceRoot>,
    );

    const element = shell();
    expect(element.getAttribute("data-aurora-glass")).toBe("off");
    // And the numbers, as custom properties, in the same render.
    expect(element.style.getPropertyValue("--p-appearance-alpha")).toBe("0.3");
  });

  it("reports glass on/off, and blur on/off, as attributes CSS can switch on", () => {
    const { unmount } = render(
      <AppearanceRoot initial={{ ...DEFAULT_APPEARANCE, glassBlur: 0 }} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    expect(shell().getAttribute("data-aurora-glass")).toBe("on");
    // Zero blur is expressed as "off" rather than as `blur(0px)`, because
    // `blur(0px)` still promotes the element and still costs a backdrop copy on
    // every frame. See the `data-aurora-blur` rules.
    expect(shell().getAttribute("data-aurora-blur")).toBe("off");
    unmount();

    render(
      <AppearanceRoot initial={{ ...DEFAULT_APPEARANCE, glassBlur: 12 }} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    expect(shell().getAttribute("data-aurora-blur")).toBe("on");
  });

  it("reflects a change to the draft in the same commit", () => {
    // The draft drives the render directly. No effect, no second pass.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <Probe />
      </AppearanceRoot>,
    );
    expect(shell().style.getPropertyValue("--p-appearance-alpha")).toBe(
      String(DEFAULT_APPEARANCE.glassAlpha),
    );

    act(() => {
      screen.getByTestId("drag").click();
    });
    expect(shell().style.getPropertyValue("--p-appearance-alpha")).toBe("0.35");
    expect(screen.getByTestId("alpha").textContent).toBe("0.35");
  });

  it("is not opaque, so a background image can show through", () => {
    // The shell root dropped `bg-background` in Phase 53 and the backdrop
    // paints the canvas instead. If this ever regresses, glass would have no
    // visible effect at all and nothing would say why.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    expect(shell().className).not.toContain("bg-background");
    // `isolate` is load-bearing, not decoration: the backdrop is at
    // `--p-z-backdrop: -1` and needs a stacking context to be behind the
    // content rather than behind the page.
    expect(shell().className).toContain("isolate");

    // The backdrop is present in BOTH states: it IS the canvas.
    const backdrop = screen.getByTestId("aurora-backdrop");
    expect(backdrop.className).toContain("aurora-backdrop");
  });

  it("gives the backdrop its three layers, all inert", () => {
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    const backdrop = screen.getByTestId("aurora-backdrop");
    // A full-viewport element has to be invisible to assistive technology and
    // to the pointer, not merely usually so.
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.querySelector(".aurora-backdrop-image")).toBeTruthy();
    expect(backdrop.querySelector(".aurora-backdrop-ambient")).toBeTruthy();
    expect(backdrop.querySelector(".aurora-backdrop-scrim")).toBeTruthy();
  });

  it("renders the background image as a custom property on the root", () => {
    render(
      <AppearanceRoot
        initial={{
          ...DEFAULT_APPEARANCE,
          background: { kind: "preset", id: "deep-space" },
        }}
        authenticated={false}
      >
        <div />
      </AppearanceRoot>,
    );
    // The attribute carries the preset ID and not just the kind, so the
    // stylesheet can distinguish one shipped background from another (the
    // adaptive scrim differs per preset) without a second mechanism.
    expect(shell().getAttribute("data-aurora-background")).toBe(
      "preset-deep-space",
    );
    expect(shell().style.getPropertyValue("--aurora-background-image")).toBe(
      'url("/backgrounds/deep-space.svg")',
    );
  });

  it("uses the bare `none` keyword, not `url(\"none\")`", () => {
    // A quoted `none` is an invalid image value, and the browser would treat it
    // as a failed load rather than as "no image" - which shows up as a broken
    // image request in the network panel rather than as a missing background.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    const value = shell().style.getPropertyValue("--aurora-background-image");
    expect(value).toBe("none");
    expect(value).not.toContain("url(");
  });
});

/* ==========================================================================
   2. THE WRITE PATH
   ========================================================================== */

/**
 * A signed-in visitor, whose only sink is the server action.
 *
 * The anonymous path is genuinely different and is tested separately below:
 * a cookie write is a synchronous string assignment while the action is a
 * network round trip, so one is immediate and one is debounced.
 */
function renderAuthenticated(overrides: Partial<Appearance> = {}) {
  return render(
    <AppearanceRoot
      initial={{ ...DEFAULT_APPEARANCE, ...overrides }}
      authenticated
    >
      <Probe />
    </AppearanceRoot>,
  );
}

describe("persistence / a signed-in visitor", () => {
  it("does not write on mount", async () => {
    renderAuthenticated();
    // The server already sent this value; writing it back would be a mutation
    // per page view.
    await new Promise((done) => setTimeout(done, 600));
    expect(setAppearanceAction).not.toHaveBeenCalled();
  });

  it("debounces a continuous gesture into ONE write", async () => {
    // The mission's "debounced persistence, not a DB mutation per slider
    // tick". Five ticks of one drag must produce one action call.
    vi.useFakeTimers();
    renderAuthenticated();

    await act(async () => {
      screen.getByTestId("drag").click();
      screen.getByTestId("driftwo").click();
      screen.getByTestId("drag").click();
      screen.getByTestId("driftwo").click();
      screen.getByTestId("drag").click();
    });
    expect(setAppearanceAction).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(setAppearanceAction).toHaveBeenCalledTimes(1);
    // And the value written is the LAST one, not the first.
    expect(vi.mocked(setAppearanceAction).mock.calls[0][0]).toEqual(
      expect.objectContaining({ glassAlpha: 0.35, glassBlur: 20 }),
    );
  });

  it("does not write the cookie itself, so the two sinks cannot disagree", async () => {
    // A signed-in visitor's cookie is written by the ACTION, in the same call
    // that writes the account, by the same encoder. A client-side cookie write
    // would be a second producer for the same value, and the two could
    // disagree about what was stored.
    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    expect(decodeCookie(document.cookie)).toBeNull();
  });

  it("rolls back to what is stored when the value is rejected", async () => {
    const stored: Appearance = { ...DEFAULT_APPEARANCE, preset: "minimal" };
    vi.mocked(setAppearanceAction).mockResolvedValue({
      ok: false,
      appearance: stored,
      reason: "settings.backgroundError.insecureScheme",
    });

    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );

    // THE ROLLBACK. The sliders must not keep showing a value the server
    // refused - the action returns the stored appearance precisely so the
    // draft can be put back.
    expect(screen.getByTestId("alpha").textContent).toBe(
      String(stored.glassAlpha),
    );
    expect(screen.getByTestId("reason").textContent).toBe(
      "settings.backgroundError.insecureScheme",
    );
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    expect(shell().style.getPropertyValue("--p-appearance-alpha")).toBe(
      String(stored.glassAlpha),
    );
  });

  it("keeps the draft and reports the failure when the write does not travel", async () => {
    // The deliberate asymmetry with a rejection: a legal value that failed to
    // save is not a value to throw away, because reverting somebody's slider
    // because a request timed out is the worse failure.
    vi.mocked(setAppearanceAction).mockResolvedValue({
      ok: false,
      appearance: DEFAULT_APPEARANCE,
      reason: undefined,
    });

    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );

    expect(screen.getByTestId("alpha").textContent).toBe("0.35");
    expect(screen.getByTestId("reason").textContent).toBe("");
    // Still unsaved, and honestly reported as such.
    expect(screen.getByTestId("dirty").textContent).toBe("true");
  });

  it("adopts the server's answer, including any clamping", async () => {
    // A client cannot assume its own value was stored: the server clamps
    // against the same ranges and the stored value is the one to show.
    const clamped: Appearance = { ...DEFAULT_APPEARANCE, glassAlpha: 0.85 };
    vi.mocked(setAppearanceAction).mockResolvedValue(accepted(clamped));

    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("alpha").textContent).toBe("0.85"),
    );
    expect(screen.getByTestId("status").textContent).toBe("saved");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("does not let a slow write clobber a newer change", async () => {
    // THE CLASSIC BUG. A second change lands while the first write is in
    // flight; if the first write's answer becomes the draft, the slider jumps
    // back to where it was a moment ago and the user loses their newer input.
    //
    // Both writes are held open on purpose. Letting the second one resolve
    // before the assertion would test nothing here, because adopting a
    // *current* write's answer is the correct behaviour and it would mask the
    // stale case entirely.
    const gates: ((result: AppearanceActionResult) => void)[] = [];
    vi.mocked(setAppearanceAction).mockImplementation(
      () =>
        new Promise<AppearanceActionResult>((resolve) => {
          gates.push(resolve);
        }),
    );

    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    await waitFor(() => expect(gates).toHaveLength(1));

    // A newer value while the first write is out.
    act(() => {
      screen.getByTestId("driftwo").click();
    });
    // The first write finally answers, with what it was actually given.
    await act(async () => {
      gates[0](accepted({ ...DEFAULT_APPEARANCE, glassAlpha: 0.35 }));
    });
    await waitFor(() => expect(gates).toHaveLength(2));

    // The newer value is STILL the draft. The stale answer did not overwrite it.
    expect(screen.getByTestId("alpha").textContent).toBe("0.35");
    expect(screen.getByTestId("status").textContent).toBe("saving");

    // And only the newer value is written, not the stale one a second time.
    expect(vi.mocked(setAppearanceAction).mock.calls[1][0]).toEqual(
      expect.objectContaining({ glassAlpha: 0.35, glassBlur: 20 }),
    );
  });

  it("adopts the newest write's answer once it lands", async () => {
    // The companion, so the previous test cannot pass by simply never adopting
    // anything: a current write's answer IS adopted, clamping and all.
    const gates: ((result: AppearanceActionResult) => void)[] = [];
    vi.mocked(setAppearanceAction).mockImplementation(
      () =>
        new Promise<AppearanceActionResult>((resolve) => {
          gates.push(resolve);
        }),
    );

    renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    await waitFor(() => expect(gates).toHaveLength(1));
    await act(async () => {
      gates[0](accepted({ ...DEFAULT_APPEARANCE, glassAlpha: 0.4 }));
    });

    expect(screen.getByTestId("alpha").textContent).toBe("0.4");
    expect(screen.getByTestId("status").textContent).toBe("saved");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("flushes a pending change when the shell unmounts", async () => {
    // Navigating away mid-drag must not discard the last few hundred
    // milliseconds of intent.
    const { unmount } = renderAuthenticated();
    act(() => {
      screen.getByTestId("drag").click();
    });
    expect(setAppearanceAction).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });
    expect(setAppearanceAction).toHaveBeenCalledTimes(1);
  });

  it("resets to the canonical defaults, in isolation", async () => {
    // §60. The assertion that matters is the negative one: a reset is a write
    // of the appearance and of nothing else, so the only evidence available is
    // that the action is the appearance action and the payload is the default.
    render(
      <AppearanceRoot
        initial={{
          ...DEFAULT_APPEARANCE,
          glass: false,
          // A preset is the ROW THE CONTROLS CAME FROM, not a transform of
          // the eight values beside it. `preset: "crystal"` here therefore
          // leaves `glassAlpha` at the default and says nothing about 0.3 -
          // asserting otherwise would be asserting a coupling that deliberately
          // does not exist, so that picking a preset and then nudging one
          // slider does not silently move the other seven.
          preset: "crystal",
          background: { kind: "preset", id: "deep-space" },
          artworkAmbient: true,
        }}
        authenticated
      >
        <Probe />
      </AppearanceRoot>,
    );
    expect(screen.getByTestId("glass").textContent).toBe("false");

    act(() => {
      screen.getByTestId("reset").click();
    });

    expect(screen.getByTestId("alpha").textContent).toBe(
      String(DEFAULT_APPEARANCE.glassAlpha),
    );
    expect(screen.getByTestId("glass").textContent).toBe(
      String(DEFAULT_APPEARANCE.glass),
    );
    expect(shell().getAttribute("data-aurora-glass")).toBe("on");
    expect(shell().getAttribute("data-aurora-background")).toBe("none");
    expect(shell().getAttribute("data-aurora-artwork")).toBe("off");

    await waitFor(() => expect(setAppearanceAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setAppearanceAction).mock.calls[0][0]).toEqual(
      encodeAppearance(DEFAULT_APPEARANCE),
    );
  });
});

describe("persistence / a signed-out visitor", () => {
  it("writes the cookie IMMEDIATELY, before any timer", () => {
    // THE DATA-LOSS WINDOW. A cookie write is a synchronous string assignment
    // costing nothing; debouncing it would mean somebody who changes the glass
    // and closes the tab loses the change. The debounce exists for the network
    // round trip, not for this.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <Probe />
      </AppearanceRoot>,
    );
    act(() => {
      screen.getByTestId("drag").click();
    });
    // No timer advanced, no `waitFor`: the cookie is already there.
    expect(decodeCookie(document.cookie)?.glassAlpha).toBe(0.35);
  });

  it("never calls the server at all, because there is no account to write", async () => {
    // The whole anonymous write is one string assignment. No round trip, no
    // row, and nothing to wait for.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <Probe />
      </AppearanceRoot>,
    );
    act(() => {
      screen.getByTestId("drag").click();
    });
    await new Promise((done) => setTimeout(done, 600));
    expect(setAppearanceAction).not.toHaveBeenCalled();
  });

  it("sends the compact document, so the cookie stays small", () => {
    // A cookie attached to every same-origin request. The resolved object is
    // ~240 bytes; the compact document for one changed control is a fraction of
    // that, and for an untouched visitor it is `{"v":1}`.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <Probe />
      </AppearanceRoot>,
    );
    act(() => {
      screen.getByTestId("drag").click();
    });
    const wire = decodeCookie(document.cookie)!;
    // The alpha is there and nothing else that is still at its default.
    expect(wire.glassAlpha).toBe(0.35);
    expect(wire).not.toHaveProperty("glassBlur");
    expect(wire).not.toHaveProperty("background");
    expect(wire).not.toHaveProperty("preset");
  });

  it("reports the change as saved immediately", () => {
    // Truthful, because it is: the cookie IS the storage for this visitor, and
    // it has been written by the time this renders.
    render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <Probe />
      </AppearanceRoot>,
    );
    act(() => {
      screen.getByTestId("drag").click();
    });
    expect(screen.getByTestId("status").textContent).toBe("saved");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("survives a thrown cookie write without losing the interface", () => {
    // §74. A cookie jar the browser refuses to write must not take the
    // settings form down with it.
    const descriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie",
    );
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new Error("cookies are disabled");
      },
    });

    try {
      render(
        <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
          <Probe />
        </AppearanceRoot>,
      );
      act(() => {
        screen.getByTestId("drag").click();
      });
      // The draft still moved: the interface is showing the change, and
      // claiming otherwise would be a worse lie than a lost preference.
      expect(screen.getByTestId("alpha").textContent).toBe("0.35");
    } finally {
      if (descriptor) {
        Object.defineProperty(Document.prototype, "cookie", descriptor);
      }
      delete (document as { cookie?: unknown }).cookie;
    }
  });
});

/* ==========================================================================
   3. OUTSIDE A PROVIDER
   ========================================================================== */

describe("useAppearance outside a provider", () => {
  it("returns the shipped default and swallows every write", async () => {
    // §74's contract for `useLocale`, kept here too: an isolated unit test or
    // a static prerender edge must render the default theme rather than throw.
    function Bare() {
      const value = useAppearance();
      return (
        <button
          type="button"
          data-testid="bare"
          onClick={() => value.update({ glassAlpha: 0.1 })}
        >
          {String(value.appearance.glassAlpha)}
        </button>
      );
    }
    render(<Bare />);
    const button = screen.getByTestId("bare");
    expect(button.textContent).toBe(String(DEFAULT_APPEARANCE.glassAlpha));
    await act(async () => {
      button.click();
    });
    expect(button.textContent).toBe(String(DEFAULT_APPEARANCE.glassAlpha));
    expect(setAppearanceAction).not.toHaveBeenCalled();
  });
});

/* ==========================================================================
   4. THE STRUCTURAL CLAIM: NO PLAYBACK
   ========================================================================== */

describe("playback is not reachable from the appearance root", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "src/components/appearance/appearance-root.tsx"),
    "utf8",
  );
  /** Code with every comment removed, so a docstring cannot fail an assertion. */
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("never imports an engine, a controller or the queue", () => {
    // The mission's requirement is that an appearance change cannot recreate a
    // `MusicEngine`, a `PlaybackController`, a `QueueManager` or a
    // `PlayerEngine`. A behavioural test cannot prove a negative about module
    // construction, but the import list can: if the root cannot name these
    // types, it cannot construct or re-create one.
    //
    // Asserted against CODE rather than against the file, because this file's
    // docstring names all four while explaining why it does not use them. A
    // whole-file grep would either fail on that explanation or force the
    // explanation to be deleted, and the explanation is the more valuable of
    // the two.
    for (const forbidden of [
      "MusicEngine",
      "PlaybackController",
      "QueueManager",
      "PlayerEngine",
      "createMusicEngine",
      "getMusicEngine",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("does not mention playback, the queue or the position at all", () => {
    // Belt and braces on the same claim, in a form that also catches a write
    // through a module that was already imported.
    for (const forbidden of [
      "playback",
      "PlaybackState",
      "queueSnapshot",
      "localStorage",
      "sessionStorage",
      "indexedDB",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("mounts the ambience only when the user asked for it", () => {
    // Not subscribing is strictly cheaper than subscribing and returning
    // early, and an application that never opted in should not be paying for
    // an artwork palette resolver that is mounted but inert.
    const { unmount } = render(
      <AppearanceRoot initial={DEFAULT_APPEARANCE} authenticated={false}>
        <div />
      </AppearanceRoot>,
    );
    expect(shell().getAttribute("data-aurora-artwork")).toBe("off");
    unmount();

    render(
      <AppearanceRoot
        initial={{ ...DEFAULT_APPEARANCE, artworkAmbient: true }}
        authenticated={false}
      >
        <div />
      </AppearanceRoot>,
    );
    expect(shell().getAttribute("data-aurora-artwork")).toBe("on");
  });

  it("removes the ambience properties from the document when it unmounts", () => {
    // The properties are written to `document.documentElement` on purpose, so
    // that a palette swap does not re-render the shell - but that also means
    // React never removes them, because React did not put them there. Without
    // an explicit cleanup, turning the feature off would leave the last
    // album's colour on the document with nothing left to overwrite it.
    const style = document.documentElement.style;
    const properties = [
      "--aurora-artwork-primary",
      "--aurora-artwork-secondary",
      "--aurora-artwork-glow",
      "--aurora-artwork-tint",
      "--aurora-artwork-strength",
    ];
    // Stand in for a resolved palette.
    for (const property of properties) {
      style.setProperty(property, "oklch(0.6 0.1 250)");
    }
    expect(style.getPropertyValue("--aurora-artwork-strength")).not.toBe("");

    const { unmount } = render(
      <AppearanceRoot
        initial={{ ...DEFAULT_APPEARANCE, artworkAmbient: true }}
        authenticated={false}
      >
        <div />
      </AppearanceRoot>,
    );
    unmount();

    for (const property of properties) {
      expect(style.getPropertyValue(property), property).toBe("");
    }
  });
});

/* ==========================================================================
   HELPERS
   ========================================================================== */

/**
 * Reads the appearance cookie back out of `document.cookie`, or `null` if
 * there is none - which is a meaningful answer, not a failure, since the
 * signed-in path deliberately writes none.
 */
function decodeCookie(jar: string): Record<string, unknown> | null {
  const entry = jar
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("aurora-appearance="));
  if (!entry) {
    return null;
  }
  return JSON.parse(
    decodeURIComponent(entry.slice("aurora-appearance=".length)),
  );
}
