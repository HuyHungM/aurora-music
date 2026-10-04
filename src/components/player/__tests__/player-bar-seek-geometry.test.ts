/**
 * Player-bar responsive geometry, asserted at the SOURCE.
 *
 * The property under test is a class-list relationship between three widths and
 * three breakpoints, which is exactly the thing a rendered comparison cannot
 * check without a real layout engine at every width. Asserting the strings
 * keeps the ladder honest: `lg` must be reachable, and the width must grow with
 * the room rather than staying stuck at one size.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bar = readFileSync(
  join(process.cwd(), "src", "components", "player", "player-bar.tsx"),
  "utf8",
);

/** The seek + time block's class list. */
function seekBlockClasses(): string {
  const match = bar.match(/<div className="([^"]*(?:xl:flex|2xl:w-48)[^"]*)">\s*<SeekSlider/);
  if (!match?.[1]) {
    throw new Error("could not locate the seek block in player-bar.tsx");
  }
  return match[1];
}

describe("player bar: seek reachability", () => {
  it("renders seek from lg, not only from xl", () => {
    // The regression: `hidden ... xl:flex` meant no scrub and no time readout
    // between 1024 and 1279px.
    const classes = seekBlockClasses();
    expect(classes).toContain("hidden");
    expect(classes).toContain("lg:flex");
    expect(classes).not.toContain("xl:flex");
  });

  it("widens the seek block as the room appears", () => {
    // Monotonic by construction: each breakpoint's width must be larger than
    // the one before it, so the slider never looks the same size twice or
    // shrinks at a wider viewport.
    const classes = seekBlockClasses();
    const widths = [
      classes.match(/(?:^|\s)w-(\d+)/)?.[1],
      classes.match(/xl:w-(\d+)/)?.[1],
      classes.match(/2xl:w-(\d+)/)?.[1],
    ].map((value) => Number(value));

    for (const width of widths) {
      expect(Number.isFinite(width)).toBe(true);
    }
    expect(widths[0]).toBeLessThan(widths[1] as number);
    expect(widths[1]).toBeLessThan(widths[2] as number);
  });

  it("keeps the bar a three-track grid so the zones cannot overlap", () => {
    // `minmax(0,1fr)_auto_minmax(0,1fr)` with `min-w-0` children is what makes
    // "no overflow onto the transport column" a structural property rather than
    // a width that has to be re-checked by hand.
    expect(bar).toContain(
      "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
    expect(bar).toContain("justify-self-end");
    expect(bar).toContain("flex min-w-0 items-center gap-3 justify-self-end");
  });

  it("leaves the volume slider xl-gated", () => {
    // Deliberate and load-bearing: the volume slider appears at the same
    // breakpoint the seek block widens, so adding seek at `lg` did NOT also
    // pull a second 96px control into the secondary zone at 1024px.
    expect(bar).toContain("aurora-touch hidden w-24 accent-accent xl:block");
  });

  it("does not touch the full player's seek, which is unconditional", () => {
    // The mobile takeover has its own seek at every width; this change is
    // scoped to the desktop bar only.
    const full = readFileSync(
      join(process.cwd(), "src", "components", "player", "full-player.tsx"),
      "utf8",
    );
    expect(full).toContain("<SeekSlider");
    // No breakpoint gate wrapping it.
    expect(full).not.toMatch(/hidden[^"]*"[^"]*<SeekSlider/);
  });
});
