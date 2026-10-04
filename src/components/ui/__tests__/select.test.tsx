// @vitest-environment jsdom
/**
 * The shared `Select` (§32.11).
 *
 * The properties pinned here are the ones that make the trigger OURS while the
 * popup stays the platform's, because that split is the component's whole
 * argument and it is easy to erode one class at a time:
 *
 *   1. It is still a `<select>`. Not a `div` with a `role`, not a button over a
 *      list — those give up the mobile picker and the screen reader's
 *      announcement in exchange for a popup no web technology can style
 *      anyway.
 *   2. `appearance-none`, so the platform's own arrow is not drawn on top of
 *      ours.
 *   3. `pr-10`, which is the ONLY thing keeping a long selected label from
 *      running under the chevron once the native arrow's space reservation is
 *      gone. Removing it looks fine at `Subtle` and breaks at `Immersive`.
 *   4. The chevron is `pointer-events-none`, because it is decoration over the
 *      control's own hit target.
 *   5. The label is `font-medium text-text-primary` on a 6px gap, the panel's
 *      label vocabulary, and the trigger has NO `bg-*` of its own while every
 *      `<option>` does — the closed control is ours to leave unfilled, the open
 *      one is the platform's and can only be reached per option.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "../select";

afterEach(cleanup);

const OPTIONS = [
  { value: "subtle", label: "Subtle" },
  { value: "balanced", label: "Balanced" },
  { value: "immersive", label: "Immersive" },
  { value: "custom", label: "Custom" },
] as const;

function renderSelect(props: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <Select
      id="ambient-preset"
      label="Preset"
      value="balanced"
      options={OPTIONS}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange, select: screen.getByLabelText("Preset") as HTMLSelectElement };
}

describe("Select", () => {
  it("is a real select, so the platform's picker and announcement survive", () => {
    // The property everything else rests on. A `role="combobox"` div would pass
    // a "has the right role" test and fail a phone.
    const { select } = renderSelect();
    expect(select.tagName).toBe("SELECT");
    expect(select).toBeInstanceOf(HTMLSelectElement);
  });

  it("labels itself with a real label element", () => {
    const { select } = renderSelect();
    // `getByLabelText` resolves only through an actual `<label for>`, so this
    // is asserting the association, not an aria attribute we hand-wrote.
    expect(select.id).toBe("ambient-preset");
    expect(document.querySelector(`label[for="${select.id}"]`)?.textContent).toBe(
      "Preset",
    );
  });

  it("labels itself in the panel's LABEL vocabulary, at the panel's gap", () => {
    // The association is pinned by the test above; the label is reached here
    // through the SAME `label[for=…]` selector rather than by its text, so this
    // asserts the visible label and cannot pass against an orphan one.
    const { select } = renderSelect();
    const label = document.querySelector<HTMLLabelElement>(
      `label[for="${select.id}"]`,
    );
    expect(label).not.toBeNull();
    // `text-sm font-medium text-text-primary` is what the disclosure buttons,
    // the switch rows and every `AppearanceSlider` label in this panel use. All
    // three are asserted so that neither the weight nor the colour can drift
    // alone: a label at medium weight in `--fg-secondary` still reads dim, and
    // the two tokens only mean anything together.
    expect(label!.className).toContain("font-medium");
    expect(label!.className).toContain("text-text-primary");
    expect(label!.className).not.toContain("text-text-secondary");
    // The 6px label-to-control gap. `AppearanceSlider` gets it from the
    // `gap-1.5` of its flex column; a standalone label states it, and a label
    // whose spacing differs from its neighbours reads as belonging to another
    // panel.
    expect(label!.className).toContain("mb-1.5");
    // `block` is what makes that margin do anything at all — `mb-1.5` on an
    // inline element is silently ignored, so dropping it would void the gap
    // above with every assertion in this test still green.
    expect(label!.className).toContain("block");
  });

  it("removes the platform arrow, and reserves the room ours needs", () => {
    const { select } = renderSelect();
    expect(select.className).toContain("appearance-none");
    // The reservation. Without it a long value runs under the chevron.
    expect(select.className).toContain("pr-10");
    // And it replaces the old `px-3`, which set BOTH sides and would now
    // re-narrow the left edge the padding was meant to keep.
    expect(select.className).not.toMatch(/\bpx-3\b/);
    expect(select.className).toContain("pl-3");
  });

  it("is the height of its neighbours, stated rather than summed", () => {
    // MEASURED: `py-2` on a `text-sm` select renders 38px, under the 40–44px
    // band every other control in the panel occupies and under the touch floor
    // a finger is held to anyway — a settings page where one row is a different
    // size from the disclosure directly above it. `h-11` states it once, and
    // `py-0` stops the padding from adding to it.
    const { select } = renderSelect();
    expect(select.className).toContain("h-11");
    expect(select.className).toContain("py-0");
    expect(select.className).not.toMatch(/\bpy-2\b/);
  });

  it("leaves the app-wide focus outline to do the work", () => {
    // Same treatment as every other form control in the product. This test used
    // to pin `focus:outline-none` + `focus:ring-2 focus:ring-accent/25`, which
    // encoded a defect: `focus:outline-none` is (0,2,0) and so outranks the
    // blanket `:focus-visible` outline in `globals.css`, which killed it, and
    // the 25%-alpha `box-shadow` left behind measured ~1.9:1 against the canvas
    // — invisible, and dropped outright under `forced-colors: active`.
    //
    // The assertion is now the negative one, because that is the invariant that
    // matters: this control must NOT suppress the global rule. Re-adding either
    // utility fails here, which is the point — the outline is the
    // WCAG-conformant indicator and it only applies if nothing overrides it.
    const { select } = renderSelect();
    expect(select.className).not.toContain("focus:outline-none");
    expect(select.className).not.toMatch(/\bfocus:ring-/);
    // The complementary indicator stays: solid accent, well above 3:1.
    expect(select.className).toContain("focus:border-accent");
  });

  it("draws one decorative chevron that cannot swallow a click", () => {
    const { container } = render(
      <Select
        id="ambient-preset"
        label="Preset"
        value="balanced"
        options={OPTIONS}
        onChange={() => undefined}
      />,
    );
    const chevrons = container.querySelectorAll("svg");
    expect(chevrons).toHaveLength(1);
    const chevron = chevrons[0]!;
    // Decorative: the select already announces its value.
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    // And it must not become the click target — a click landing on the span
    // would not open the popup.
    expect(chevron.getAttribute("class")).toContain("pointer-events-none");
  });

  it("reports the STORED value, not the label", () => {
    const { select } = renderSelect({ value: "immersive" });
    // The labels are translated sentences; the value is what persists and what
    // a preset restores. Conflating them is how a rename silently resets
    // everyone's preference.
    expect(select.value).toBe("immersive");
  });

  it("changes with the platform's own change event", () => {
    const { onChange, select } = renderSelect();
    fireEvent.change(select, { target: { value: "custom" } });
    expect(onChange).toHaveBeenCalledWith("custom");
  });

  it("shows every option with its own value and label", () => {
    const { select } = renderSelect();
    const rendered = [...select.options];
    expect(rendered.map((option) => option.value)).toEqual([
      "subtle",
      "balanced",
      "immersive",
      "custom",
    ]);
    expect(rendered.map((option) => option.textContent)).toEqual([
      "Subtle",
      "Balanced",
      "Immersive",
      "Custom",
    ]);
  });

  it("keeps a per-option testid, so a test can name a VALUE not a position", () => {
    renderSelect();
    expect(
      screen.getByTestId("ambient-preset-immersive").getAttribute("value"),
    ).toBe("immersive");
  });

  it("paints its options opaque AND leaves its trigger unpainted, because those are two different surfaces", () => {
    // The asymmetry is the property, so both halves live in one test: a reader
    // who finds "the select has no background" must not have to read two more
    // screens to learn that its options do.
    //
    // WHY THE TRIGGER IS UNPAINTED. `[data-aurora-glass="on"] .aurora-glass-nested`
    // already sets `background-color` at (0,2,0), above any Tailwind utility, so
    // a `bg-surface-elevated` on the `<select>` was inert in Glass Mode — and
    // once Glass is off it made this the ONLY filled control in a panel of
    // border-and-nested-glass neighbours.
    const { select } = renderSelect();
    // `\b` so a VARIANT background (`hover:bg-…`, `disabled:bg-…`) fails too,
    // not just a bare one: any `bg-` here is a second source of truth fighting
    // the nested-glass rule above it.
    expect(select.className).not.toMatch(/\bbg-/);

    // WHY THE OPTIONS ARE PAINTED ANYWAY. The popup is drawn by the operating
    // system, so it inherits NOTHING from the trigger — not this control's
    // `aurora-glass-nested`, not its translucent fill. Each `<option>` is the
    // only declaration that reaches the rows the user actually reads while the
    // menu is open, and a translucent option over whatever the popup paints
    // behind it is unreadable in dark mode.
    //
    // EVERY option, not the first: the fill is declared per element in the
    // map, so one row losing it is invisible until someone opens the menu at
    // that row — and it fails the test before it ships.
    for (const option of [...select.options]) {
      expect(option.className).toContain("bg-surface-elevated");
    }
  });

  it("is a disabled control that says why, rather than a greyed-out mystery", () => {
    render(
      <Select
        id="background-dim"
        label="Background dim"
        value="0.6"
        options={[{ value: "0.6", label: "60%" }]}
        onChange={() => undefined}
        disabled
        hint="Pick a background first."
      />,
    );
    const select = screen.getByLabelText("Background dim") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.className).toContain("disabled:cursor-not-allowed");
    // The reason, associated with the control rather than merely printed
    // above it.
    expect(screen.getByText("Pick a background first.")).toBeTruthy();
    expect(
      select.getAttribute("aria-describedby"),
    ).toBe(screen.getByText("Pick a background first.").id);
  });

  it("associates no hint when there is none, rather than an empty reference", () => {
    const { select } = renderSelect();
    expect(select.getAttribute("aria-describedby")).toBeNull();
  });
});