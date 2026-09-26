// @vitest-environment jsdom
/**
 * Shuffle control: icon, state, and interaction (shuffle-control audit).
 *
 * Shuffle is the control most likely to rot silently, because nothing about it
 * is load-bearing: a malformed glyph still renders, a colour-only active state
 * still "works", and a control that is simply absent from one surface still
 * leaves the other three correct. Each of those three failures shipped before
 * this file existed, so each is pinned here.
 *
 * Every assertion is against RENDERED OUTPUT - path data, class names, ARIA,
 * and the accessibility tree - because a comment claiming a design is not a
 * test of one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import { PlayerBar } from "@/components/player/player-bar";
import { MiniPlayer } from "@/components/player/mini-player";
import { FullPlayer } from "@/components/player/full-player";
import { shuffleIconClass, shuffleToggleClass } from "@/components/ui/player-controls";
import {
  AutoContinueIcon,
  QueueIcon,
  RadioIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
} from "@/components/ui/icons";
// Both locale files export their message tree as the default export; there is no
// named export to import.
import en from "@/lib/i18n/en";
import viLocale from "@/lib/i18n/vi";

/** The `d` of every path in a rendered icon, in document order. */
function pathsOf(node: React.ReactElement): string[] {
  const { container } = render(node);
  const data = Array.from(container.querySelectorAll("path"))
    .map((p) => p.getAttribute("d") ?? "")
    .filter(Boolean);
  cleanup();
  return data;
}

function track(id: string) {
  // Built on the project's own playable fixture, plus `artists` - `MiniPlayer`
  // reads `currentTrack.artists[0].name`, so a track without that array makes
  // the mini player throw rather than render, and four of the surface tests
  // below were failing on a missing region for exactly that reason.
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    artists: [{ name: "Artist", id: "a1" }],
  });
}

function resetStore() {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    error: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    queue: [],
    playOrder: [],
    position: -1,
    shuffle: false,
    repeat: "off",
    isQueueOpen: false,
    isFullPlayerOpen: false,
    qualifiedTrackKey: null,
  });
}

let unmountFacade: (() => void) | undefined;
let surface: FakeAudioSurface | undefined;

beforeEach(() => {
  resetStore();
  surface = new FakeAudioSurface();
  usePlayerStore.getState().bindEngine(new PlayerEngine(surface));
  unmountFacade = mountTestFacade();
  // Shuffle needs an established current track: QueueManager pins the playing
  // track to position 0 when it randomises, so a toggle with position -1 is a
  // deliberate no-op rather than a bug.
  const t = track("t1");
  usePlayerStore.setState({
    currentTrack: t,
    queue: [t],
    playOrder: [0],
    position: 0,
  });
});

afterEach(() => {
  cleanup();
  unmountFacade?.();
  unmountFacade = undefined;
  surface = undefined;
  usePlayerStore.getState().bindEngine(null);
});

/** Vietnamese is the shipped default locale in tests. */
const OFF_NAME = viLocale.player.enableShuffle;
const ON_NAME = viLocale.player.disableShuffle;

/**
 * Region elements, not `within()` wrappers. The shuffle lookup below takes a
 * root and queries it directly, so the helpers hand back the element itself -
 * asking `within(bar()).getByRole("region")` would search for a region nested
 * inside the bar and find nothing.
 */
function bar(): HTMLElement {
  return screen.getByRole("region", { name: viLocale.player.bar });
}

function mini(): HTMLElement {
  return screen.getByRole("region", { name: viLocale.player.miniPlayer });
}

function full(): HTMLElement {
  return screen.getByRole("dialog", { name: viLocale.player.nowPlayingTitle });
}

/**
 * The shuffle toggle inside a surface. Selected by ARIA rather than by icon or
 * by position, so the assertions are about the control and not about the shape
 * of the row it happens to sit in.
 */
function shuffleButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(
    'button[aria-pressed][aria-label*="ngẫu nhiên"]',
  );
  if (!button) {
    throw new Error(`no shuffle toggle in ${root.getAttribute("aria-label")}`);
  }
  return button;
}

/**
 * The full active treatment as actually applied: the ring from the button, the
 * colour from the icon. Returns a normalised string so two surfaces can be
 * compared without also comparing their button boxes and base classes, which
 * they legitimately set for themselves.
 */
function activeTreatment(button: HTMLElement | null): string {
  if (!button) return "(missing)";
  const pick = (el: Element | null, ...prefixes: string[]) =>
    (el?.getAttribute("class") ?? "")
      .split(" ")
      .filter((c) => prefixes.some((p) => c.startsWith(p)))
      .sort()
      .join(" ");
  return [
    `button[${pick(button, "ring-")}]`,
    `icon[${pick(button.querySelector("svg"), "text-accent")}]`,
  ].join(" ");
}

describe("shuffle icon", () => {
  const shuffle = pathsOf(<ShuffleIcon />);

  it("is a well-formed glyph with no duplicated path data", () => {
    // The previous icon carried `m20 2-4 4` and `m16 6 4-4` twice each. They
    // render identically, so the duplication was invisible and free of visible
    // consequence - which is exactly why it survived. Asserted on the data.
    expect(shuffle.length).toBe(4);
    expect(new Set(shuffle).size).toBe(shuffle.length);
  });

  it("has an arrowhead at BOTH right-hand ends", () => {
    // The distinguishing feature of shuffle is two crossing lines each capped by
    // an arrow. The old glyph's "arrowhead" was `m20 2-4 4` plus its reverse
    // `m16 6 4-4` - one segment drawn twice, i.e. a bare diagonal tick, not a
    // chevron - and nothing capped the lower line at all.
    const chevrons = shuffle.filter((d) => /^m18 /.test(d));
    expect(chevrons).toHaveLength(2);
    for (const chevron of chevrons) {
      // A chevron is two segments in one path: `m18 <y> 4 4-4 4`.
      expect(chevron).toMatch(/^m18 [\d.]+ 4 [\d.]+-4 [\d.]+$/);
    }
  });

  it("crosses its two lines, which is what separates it from repeat", () => {
    // One line starts low-left and ends high-right, the other the reverse. The
    // crossing is the meaning; repeat's two lines never meet.
    const lines = shuffle.filter((d) => /^M2 /.test(d));
    expect(lines).toHaveLength(2);
    const ascends = lines.filter((d) => d.includes("H22") && d.indexOf("l6-9") > 0);
    const descends = lines.filter((d) => d.includes("H22") && d.indexOf("l6 9") > 0);
    expect(ascends).toHaveLength(1);
    expect(descends).toHaveLength(1);
    // Both terminate on x=22, where the two arrowhead vertices sit, so neither
    // line is left dangling. The old first line stopped at x=15.
    for (const line of lines) {
      expect(line.endsWith("H22")).toBe(true);
    }
  });

  it("shares no path data with repeat, repeat-one, autoplay, queue or radio", () => {
    // The whole reason this control is auditable separately: these six sit in
    // one row and are mistaken for each other. Comparing rendered path data is
    // the only honest check - a comment about the design proves nothing.
    for (const [name, other] of [
      ["repeat", <RepeatIcon key="r" />],
      ["repeat-one", <RepeatOneIcon key="r1" />],
      ["autoplay", <AutoContinueIcon key="a" />],
      ["queue", <QueueIcon key="q" />],
      ["radio", <RadioIcon key="rad" />],
    ] as const) {
      const others = pathsOf(other);
      expect(others.length, name).toBeGreaterThan(0);
      const shared = shuffle.filter((d) => others.includes(d));
      expect(shared, `shuffle shares a path with ${name}`).toEqual([]);
    }
  });

  it("is not a superset or subset of repeat, so the two cannot collapse", () => {
    // RepeatOne is Repeat plus a numeral, and repeat's two lines are
    // horizontal - it never crosses. Comparing path COUNTS would be a proxy
    // for the same idea, and the old shuffle icon happened to have four paths
    // like repeat does, so a count check would have passed on a broken glyph.
    // Set membership is the real question: does either icon's geometry appear
    // inside the other?
    const repeat = pathsOf(<RepeatIcon />);
    const repeatOne = pathsOf(<RepeatOneIcon />);
    const share = (a: string[], b: string[]) => a.filter((d) => b.includes(d));
    expect(share(shuffle, repeat)).toEqual([]);
    expect(share(repeat, shuffle)).toEqual([]);
    // RepeatOne must be repeat plus exactly one extra path - its numeral - and
    // that numeral must not be one of shuffle's paths. (The difference is taken
    // the other way round from the two checks above on purpose: here we want
    // what repeat-one ADDS, because repeat's four paths are all expected to
    // still be there.)
    const addedByRepeatOne = repeatOne.filter((d) => !repeat.includes(d));
    expect(addedByRepeatOne).toHaveLength(1);
    expect(addedByRepeatOne).not.toContain(shuffle.find((d) => d.startsWith("m18")));
  });
});

describe("shuffle active state", () => {
  it("changes SHAPE as well as colour, so it survives greyscale", () => {
    // This is the defect the audit found: all three shuffle toggles used
    // `text-accent` and nothing else, so "on" was a hue. The project's own
    // AutoplayButton had already established a ring; shuffle was the outlier.
    const on = shuffleToggleClass(true);
    const off = shuffleToggleClass(false);
    expect(on).toContain("ring-2");
    expect(on).toContain("ring-accent/50");
    expect(off).not.toContain("ring-2");
    // The button must NOT carry a text colour. `Button variant="ghost"` already
    // sets `text-text-secondary`, and a caller-added `text-accent` loses to it
    // on stylesheet order - measured in the running app: the button placement
    // resolved the icon to lab(73.81 0.94 -3.65), i.e. still muted, while the
    // icon placement resolved lab(50.20 44.95 -67.73), the real accent. A
    // `text-accent` here would look correct in the DOM and do nothing.
    expect(on).not.toContain("text-accent");
    // The colour lives on the icon instead, where nothing competes with it.
    expect(shuffleIconClass(true)).toBe("text-accent");
    expect(shuffleIconClass(false)).toBe("");
    // The only difference between the two button states is the active ring;
    // everything else is shared so the surfaces cannot drift apart. Compared as
    // class SETS rather than as strings: joining leaves a trailing space when
    // the active classes are stripped off the end, and a whitespace difference
    // is not the signal this test exists to catch.
    const classes = (s: string) => new Set(s.split(" ").filter(Boolean));
    const onClasses = classes(on);
    const offClasses = classes(off);
    const added = [...onClasses].filter((c) => !offClasses.has(c)).sort();
    expect(added).toEqual(["ring-2", "ring-accent/50"]);
    // Nothing is removed between the two states, so the button cannot lose a
    // class - and therefore cannot change size - when it is switched on.
    const removed = [...offClasses].filter((c) => !onClasses.has(c));
    expect(removed).toEqual([]);
    expect(offClasses.size).toBeGreaterThan(0);
  });

  it("does not animate layout, so the button cannot shift or resize", () => {
    const cls = shuffleToggleClass(true);
    // A `ring` is painted outside the box and a `transition` on colour and
    // box-shadow costs no reflow. `transition-all` would also animate width and
    // height, which is the layout shift this control must not have.
    expect(cls).toContain("transition-[color,box-shadow]");
    expect(cls).not.toContain("transition-all");
    expect(cls).not.toContain("animate-");
    expect(cls).not.toContain("scale-");
    expect(cls).not.toContain("rotate-");
  });

  it("uses the project's reduced-motion-gated press feedback", () => {
    // `aurora-press` is declared only under `prefers-reduced-motion:
    // no-preference`, so a reduced-motion visitor gets the state change with no
    // animation at all, and nothing has to be special-cased here.
    expect(shuffleToggleClass(true)).toContain("aurora-press");
  });
});

describe("shuffle control states", () => {
  it("OFF: reports itself unpressed, with no active treatment", () => {
    render(<PlayerBar />);
    const button = shuffleButton(bar());
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.className).not.toContain("ring-2");
    expect(button?.getAttribute("title")).toBe(
      viLocale.player.shuffleOff,
    );
  });

  it("ON: reports itself pressed, with the active ring on the button and the accent on the icon", () => {
    render(<PlayerBar />);
    fireEvent.click(shuffleButton(bar()));
    const button = shuffleButton(bar());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // The ring is the shape change, and it belongs on the button.
    expect(button.className).toContain("ring-2");
    expect(button.className).not.toContain("text-accent");
    // The colour belongs on the icon, or `text-text-secondary` silently wins.
    // Asserted on the rendered DOM rather than on the helper, so a surface
    // that puts the colour back on the button fails here.
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class")).toBe("text-accent");
    expect(button.getAttribute("title")).toBe(viLocale.player.shuffleOn);
  });

  it("toggles the CANONICAL store, not a local flag", () => {
    // If a surface kept its own boolean, this would pass while the queue kept
    // playing in order. Asserting against the store is what makes it a state
    // test rather than a click test.
    render(<PlayerBar />);
    expect(usePlayerStore.getState().shuffle).toBe(false);
    fireEvent.click(shuffleButton(bar()) as HTMLButtonElement);
    expect(usePlayerStore.getState().shuffle).toBe(true);
    expect(usePlayerStore.getState().playOrder).toHaveLength(1);
  });

  it("reflects a programmatic state change with no click at all", () => {
    // Session restore, a queue action, or another surface can all set shuffle.
    // Nothing may be left stale.
    const { rerender } = render(<PlayerBar />);
    fireEvent.click(shuffleButton(bar()) as HTMLButtonElement);
    act(() => {
      usePlayerStore.setState({ shuffle: false });
    });
    rerender(<PlayerBar />);
    const button = shuffleButton(bar());
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.className).not.toContain("ring-2");
  });

  it("survives rapid toggling and settles on the true final state", () => {
    render(<PlayerBar />);
    const press = () =>
      fireEvent.click(
        shuffleButton(bar()) as HTMLButtonElement,
      );
    press();
    press();
    press();
    expect(usePlayerStore.getState().shuffle).toBe(true);
    let button = shuffleButton(bar());
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.className).toContain("ring-2");
    press();
    expect(usePlayerStore.getState().shuffle).toBe(false);
    button = shuffleButton(bar());
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.className).not.toContain("ring-2");
  });

  it("declares a real button with a full touch target", () => {
    render(<PlayerBar />);
    const button = shuffleButton(bar());
    // A native <button>, so Enter and Space activate it and it is in the tab
    // order, without a single key handler in the component.
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("disabled")).toBe(false);
    // The target is the button box, not the glyph: a fixed square is declared
    // and no padding class shrinks the hit area down toward the icon.
    expect(button.className).toMatch(/h-1[01] w-1[01]/);
    expect(button.className).not.toMatch(/\bp-\d/);
    // Note on `type`: the `Button` primitive spreads caller props onto a
    // <button> with no default `type`, so these controls inherit the HTML
    // default of `submit`. Harmless here - none of the player surfaces is
    // inside a <form> - and changing a shared primitive is wider than this
    // bugfix, so it is reported rather than silently changed. The mini player
    // sets `type="button"` because its raw buttons always have.
  });

  it("is reachable and operable from the keyboard", () => {
    // A native <button> inside a labelled group is tabbable and activates on
    // both Enter and Space without a single key handler, which is the point of
    // using the element rather than a div. Asserted structurally so a future
    // refactor to a div fails here.
    render(<PlayerBar />);
    const group = within(bar()).getByRole("group", { name: "Điều khiển phát" });
    const button = within(group as HTMLElement).getByRole("button", { name: OFF_NAME });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(
      within(group as HTMLElement).getByRole("button", { name: ON_NAME }),
    ).toBeTruthy();
  });

  it("carries no nested accessible name from its icon", () => {
    // The icon is aria-hidden (see `base()` in icons.tsx), so the button has
    // exactly one name. If an icon ever lost that attribute the button would
    // gain a second, conflicting label.
    render(<PlayerBar />);
    const button = shuffleButton(bar());
    const svg = button?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe(OFF_NAME);
  });
});

describe("shuffle across every surface", () => {
  it("exists in the mini player, which had repeat but no shuffle", () => {
    // The asymmetry this pins: the mini bar offered Repeat and Autoplay but no
    // way to see or change the one transport mode that changes what plays next.
    render(<MiniPlayer />);
    const button = shuffleButton(mini());
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(shuffleButton(mini()).getAttribute("aria-pressed")).toBe("true");
  });

  it("orders shuffle immediately before repeat on every surface", () => {
    // Position is part of the muscle memory: shuffle-then-repeat is the
    // convention in every player, and a surface that reversed them would read
    // as a different app.
    for (const [name, surface] of [
      ["bar", <PlayerBar key="b" />],
      ["mini", <MiniPlayer key="m" />],
      ["full", <FullPlayer key="f" />],
    ] as const) {
      usePlayerStore.setState({ isFullPlayerOpen: true });
      const { unmount } = render(surface);
      const root =
        name === "full" ? full() : name === "bar" ? bar() : mini();
      const labels = Array.from(root.querySelectorAll("button")).map(
        (b) => b.getAttribute("aria-label") ?? "",
      );
      const shuffleAt = labels.findIndex((l) => l.includes("ngẫu nhiên"));
      const repeatAt = labels.findIndex((l) => l.startsWith("Repeat"));
      expect(shuffleAt, name).toBeGreaterThanOrEqual(0);
      expect(repeatAt, name).toBeGreaterThan(shuffleAt);
      unmount();
      cleanup();
    }
  });

  it("shows the same state in the bar, the mini player and the full player", () => {
    // The brief's own example: turn shuffle on in one surface, and every other
    // surface must already agree. Rendered together, in one tree, so a
    // per-surface copy of the flag would show up as a disagreement.
    usePlayerStore.setState({ isFullPlayerOpen: true });
    render(
      <>
        <PlayerBar />
        <MiniPlayer />
        <FullPlayer />
      </>,
    );
    // Clicked in the BAR; read from all three. If any surface kept its own
    // boolean, the two it did not click would still read "off" here.
    fireEvent.click(shuffleButton(bar()));
    for (const root of [bar(), mini(), full()]) {
      const button = shuffleButton(root);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.getAttribute("title")).toBe(viLocale.player.shuffleOn);
      expect(button.className).toContain("ring-2");
    }
  });

  it("gives every surface the identical active treatment", () => {
    usePlayerStore.setState({ isFullPlayerOpen: true });
    render(
      <>
        <PlayerBar />
        <MiniPlayer />
        <FullPlayer />
      </>,
    );
    fireEvent.click(shuffleButton(bar()));
    const active = [bar(), mini(), full()].map((root) =>
      activeTreatment(shuffleButton(root)),
    );
    // The three surfaces legitimately differ in button size and base colour
    // classes, so the comparison is on the ACTIVE treatment only - which is the
    // part that used to drift.
    expect(active[0]).toBe("button[ring-2 ring-accent/50] icon[text-accent]");
    expect(new Set(active).size).toBe(1);
  });

  it("is the same DOM shape in every surface apart from declared size", () => {
    // The last drift vector: a surface that rebuilt the control from scratch
    // would still agree on state but lose the shared treatment. Asserted on the
    // properties that define the control, with the two things each surface
    // sets for itself (its button box, and the glyph size that follows from it)
    // excluded from the comparison.
    usePlayerStore.setState({ isFullPlayerOpen: true });
    render(
      <>
        <PlayerBar />
        <MiniPlayer />
        <FullPlayer />
      </>,
    );
    fireEvent.click(shuffleButton(bar()));
    const roots = [bar(), mini(), full()];
    const signature = (root: HTMLElement) => {
      const b = shuffleButton(root);
      return [
        b.tagName,
        b.getAttribute("aria-pressed"),
        b.getAttribute("aria-label"),
        b.getAttribute("title"),
        // One icon, one accessible name, contributed by the icon: none.
        b.querySelectorAll("svg").length,
        b.querySelector("svg")?.getAttribute("aria-hidden"),
        b.querySelector("svg")?.getAttribute("class"),
      ].join("|");
    };
    expect(new Set(roots.map(signature)).size).toBe(1);

    // Base class names are deliberately NOT in the signature: the bar and the
    // full player use the `Button` primitive (`inline-flex`), while the mini
    // player uses a raw `<button>` (`grid`), because that is how each row's own
    // controls are built. Requiring them to match would mean restyling three
    // unrelated rows. What must match is the ACTIVE treatment, which is
    // asserted separately above, and the ARIA contract pinned here.

    // Glyph size is declared per surface, and the two compact surfaces share
    // 18px while the full player uses 20px - a real, intentional difference.
    const glyphs = roots.map(
      (root) => shuffleButton(root).querySelector("svg")?.getAttribute("width") ?? "",
    );
    expect(glyphs).toEqual(["18", "18", "20"]);

    // A FINDING, pinned rather than asserted as correct: `Button` with
    // `size="icon"` already emits `h-11 w-11`, and every caller in the repo
    // ALSO passes an explicit `h-* w-*`. Where the two agree (the full player,
    // the mini player) the duplication is harmless. Where they disagree - the
    // bar's four transport buttons, including this one - the button carries
    // BOTH `h-10 w-10` and `h-11 w-11`, and the box that actually renders is
    // decided by stylesheet order rather than by the author's intent. The bar's
    // real hit target is therefore not knowable from the source.
    //
    // Not fixed here: the primitive is responsible, and the brief's own rule is
    // not to fix an alignment problem by patching individual instances. The
    // repair is one `compact` entry in `Button`'s size map plus a change at the
    // four call sites in the bar - a shared-primitive change to the whole
    // transport row, which is wider than a shuffle icon bugfix. See REMAINING
    // RISKS.
    const declaredBoxes = roots.map((root) =>
      (shuffleButton(root).className.match(/\bh-\d+ w-\d+\b/g) ?? [])
        .slice()
        .sort()
        .join(" "),
    );
    expect(declaredBoxes).toEqual([
      // Bar: the two values genuinely disagree.
      "h-10 w-10 h-11 w-11",
      // Mini player: a raw button, so exactly one box, declared once.
      "h-11 w-11",
      // Full player: the primitive and the caller agree, so it is stated twice.
      "h-11 w-11 h-11 w-11",
    ]);
  });
});

describe("shuffle disabled state", () => {
  /** Empty the queue: `playOrder` is what decides availability, not `queue`. */
  function clearQueue() {
    usePlayerStore.setState({ queue: [], playOrder: [], position: -1 });
  }

  it("is disabled when the queue is empty, and says why", () => {
    // The real defect this audit found in the running app: with nothing queued
    // the button accepted the click, reported no change, and explained nothing.
    // `toggleShuffle` returns early on an empty playOrder, so the control was
    // live-looking and inert.
    clearQueue();
    render(<PlayerBar />);
    const button = shuffleButton(bar());
    expect(button.hasAttribute("disabled")).toBe(true);
    // The tooltip explains the condition instead of reporting a state that
    // cannot change.
    expect(button.getAttribute("title")).toBe(viLocale.player.shuffleUnavailable);
    // Still announced as a toggle: dropping aria-pressed would change the role.
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not pretend to be interactive: no pointer, no hover paint", () => {
    // A disabled element still matches :hover in CSS, so without these the
    // ghost variant's hover:bg-surface-2 would still fire and the control would
    // look live.
    clearQueue();
    render(<PlayerBar />);
    const cls = shuffleButton(bar()).className;
    expect(cls).toContain("disabled:pointer-events-none");
    expect(cls).toContain("disabled:opacity-50");
    expect(cls).toContain("disabled:hover:bg-transparent");
  });

  it("a click while disabled changes nothing", () => {
    clearQueue();
    render(<PlayerBar />);
    const button = shuffleButton(bar());
    fireEvent.click(button);
    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(shuffleButton(bar()).getAttribute("aria-pressed")).toBe("false");
  });

  it("re-enables as soon as the queue is populated, with no reload", () => {
    // Availability is read from the store, so it tracks the queue rather than
    // being decided once at mount.
    clearQueue();
    render(<PlayerBar />);
    expect(shuffleButton(bar()).hasAttribute("disabled")).toBe(true);
    act(() => {
      const t = track("t2");
      usePlayerStore.setState({ queue: [t], playOrder: [0], position: 0 });
    });
    const button = shuffleButton(bar());
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe(viLocale.player.shuffleOff);
  });

  it("disables on every surface at once", () => {
    clearQueue();
    usePlayerStore.setState({ isFullPlayerOpen: true });
    render(
      <>
        <PlayerBar />
        <MiniPlayer />
        <FullPlayer />
      </>,
    );
    for (const root of [bar(), mini(), full()]) {
      const button = shuffleButton(root);
      // `getAttribute` returns `string | null`, and vitest's message parameter
      // is `string | undefined` - so coerce rather than pass null through.
      expect(button.hasAttribute("disabled"), root.getAttribute("aria-label") ?? "?").toBe(true);
      expect(button.getAttribute("title")).toBe(viLocale.player.shuffleUnavailable);
    }
  });
});

describe("shuffle localization", () => {
  it("has action and state strings in both locales", () => {
    for (const locale of [viLocale, en]) {
      expect(locale.player.enableShuffle.length).toBeGreaterThan(0);
      expect(locale.player.disableShuffle.length).toBeGreaterThan(0);
      expect(locale.player.shuffleOn.length).toBeGreaterThan(0);
      expect(locale.player.shuffleOff.length).toBeGreaterThan(0);
      expect(locale.player.shuffleUnavailable.length).toBeGreaterThan(0);
      // A state string must not be a copy of the action string, or the tooltip
      // would tell a visitor to do the thing they have already done.
      expect(locale.player.shuffleOn).not.toBe(locale.player.enableShuffle);
      expect(locale.player.shuffleOff).not.toBe(locale.player.disableShuffle);
      expect(locale.player.shuffleOn).not.toBe(locale.player.shuffleOff);
      // The unavailable string must not read as a state, or a disabled control
      // would claim to be on or off.
      expect(locale.player.shuffleUnavailable).not.toBe(locale.player.shuffleOn);
      expect(locale.player.shuffleUnavailable).not.toBe(locale.player.shuffleOff);
    }
  });

  it("keeps the two locales structurally identical", () => {
    expect(Object.keys(viLocale.player).sort()).toEqual(
      Object.keys(en.player).sort(),
    );
  });

  it("is actually translated, not copied", () => {
    // Guards against a locale file being filled in with the English string,
    // which type-checks perfectly and ships untranslated.
    expect(viLocale.player.shuffleOn).not.toBe(en.player.shuffleOn);
    expect(viLocale.player.shuffleOff).not.toBe(en.player.shuffleOff);
    expect(viLocale.player.shuffleUnavailable).not.toBe(en.player.shuffleUnavailable);
  });
});
