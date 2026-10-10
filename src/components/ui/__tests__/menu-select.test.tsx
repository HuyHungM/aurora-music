// @vitest-environment jsdom
/**
 * The shared `MenuSelect` (§32.11 — the shadcn-style select: a button trigger
 * over a check-marked menu, drawn by the product rather than the OS).
 *
 * The properties pinned here are the ones that make six enumerated controls
 * read as one control, because that split is the component's whole argument
 * and it is easy to erode one class at a time:
 *
 *   1. It is a button over a menu, not a `<select>`. The closed control shows
 *      the selected LABEL and a chevron; the open one is `menuitemradio`
 *      rows with a check mark on the current value.
 *   2. The trigger matches `Select`'s: the same label vocabulary, the same
 *      44px height, the same quiet border, the same right padding reserving
 *      the chevron's room, the same unpainted fill.
 *   3. The menu matches the track menus': `presence-menu` layer, float
 *      surface, `menuitemradio` + `aria-checked`. One tab stop while closed;
 *      arrows move between rows while open; Escape closes; focus returns.
 *   4. `onChange` receives the STORED value, never the label — the labels are
 *      translated sentences and the value is what persists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MenuSelect } from "../menu-select";

afterEach(cleanup);

const OPTIONS = [
  { value: "subtle", label: "Subtle" },
  { value: "balanced", label: "Balanced" },
  { value: "immersive", label: "Immersive" },
  { value: "custom", label: "Custom" },
] as const;

function renderSelect(props: Partial<Parameters<typeof MenuSelect>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <MenuSelect
      id="ambient-preset"
      label="Preset"
      value="balanced"
      options={OPTIONS}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange };
}

function trigger() {
  return screen.getByTestId("ambient-preset");
}

function openMenu() {
  fireEvent.click(trigger());
  return screen.getByRole("menu");
}

describe("MenuSelect", () => {
  it("is a button trigger showing the selected label, not a select", () => {
    renderSelect();
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    // The STORED value is "balanced"; the trigger shows the word for it.
    expect(button.textContent).toContain("Balanced");
    expect(button.textContent).not.toContain("balanced");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("names its trigger after the label, shared with the menu", () => {
    renderSelect();
    const button = trigger();
    // `aria-labelledby` points at the visible label span, so the name a screen
    // reader hears and the label a sighted user reads are one element.
    const labelId = button.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Preset");
  });

  it("opens a check-marked menu and checks exactly the current value", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(trigger());

    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(4);
    for (const item of items) {
      const value = item.getAttribute("data-testid")?.replace("ambient-preset-", "");
      expect(item.getAttribute("aria-checked")).toBe(
        value === "balanced" ? "true" : "false",
      );
    }
    // The check lives on the selected row only, and it is a glyph, not colour.
    const selected = within(menu).getByTestId("ambient-preset-balanced");
    expect(selected.querySelector("svg")).not.toBeNull();
    expect(
      within(menu).getByTestId("ambient-preset-subtle").querySelector("svg"),
    ).toBeNull();
    expect(screen.getByTestId("ambient-preset")).toBeTruthy();
  });

  it("reports the STORED value, not the label, and closes on choice", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSelect();
    await user.click(trigger());
    await user.click(screen.getByTestId("ambient-preset-immersive"));

    // The labels are translated sentences; the value is what persists and
    // what a preset restores. Conflating them is how a rename silently resets
    // everyone's preference.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("immersive");
    // The menu leaves with the choice — choosing is dismissing. Through the
    // presence exit, so `waitFor` like every other menu test in the repo.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("does not call onChange when the current value is re-chosen", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSelect();
    await user.click(trigger());
    await user.click(screen.getByTestId("ambient-preset-balanced"));

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "ambient-preset",
    );
  });

  it("closes on an outside pointer and returns focus to the trigger", async () => {
    renderSelect();
    openMenu();
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "ambient-preset",
    );
  });

  it("moves focus between rows with the arrow keys and chooses with Enter", async () => {
    const user = userEvent.setup();
    const { onChange } = renderSelect();
    await user.click(trigger());

    // Opening focuses the selected row, so Down moves to the next one.
    expect(
      document.activeElement?.getAttribute("data-testid"),
    ).toBe("ambient-preset-balanced");

    await user.keyboard("{ArrowDown}");
    expect(
      document.activeElement?.getAttribute("data-testid"),
    ).toBe("ambient-preset-immersive");

    await user.keyboard("{ArrowUp}");
    expect(
      document.activeElement?.getAttribute("data-testid"),
    ).toBe("ambient-preset-balanced");

    await user.keyboard("{Enter}");
    // Re-choosing the current value reports nothing — there is no new intent —
    // but the menu still dismisses.
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("opens from the keyboard and keeps the check column aligned", async () => {
    const user = userEvent.setup();
    renderSelect();
    trigger().focus();
    await user.keyboard("{ArrowDown}");

    const menu = screen.getByRole("menu");
    expect(menu).toBeTruthy();
    // The check column is always rendered, so labels never shift when the
    // value changes: every row has the slot, checked or not.
    for (const item of within(menu).getAllByRole("menuitemradio")) {
      expect(item.querySelector("span.grid")).not.toBeNull();
    }
  });

  it("keeps a per-option testid, so a test can name a VALUE not a position", async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.click(trigger());
    expect(screen.getByTestId("ambient-preset-immersive").textContent).toContain(
      "Immersive",
    );
  });

  it("matches the shared trigger treatment: height, chevron room, unpainted fill", () => {
    renderSelect();
    const button = trigger();
    // `h-11`: the 44px height every other control in the panel occupies,
    // stated rather than summed.
    expect(button.className).toContain("h-11");
    // `pr-10`: the reservation keeping a long label clear of the chevron.
    expect(button.className).toContain("pr-10");
    // NO `bg-*`: `aurora-glass-nested` already fills above any utility, and
    // every neighbour is border-and-nested-glass with no explicit fill.
    expect(button.className).not.toMatch(/\bbg-/);
    // The chevron is decoration over the control's own hit target: one glyph,
    // hidden from the reader, unable to swallow the click.
    const chevrons = button.querySelectorAll("svg");
    expect(chevrons).toHaveLength(1);
    expect(chevrons[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(chevrons[0]!.getAttribute("class")).toContain("pointer-events-none");
  });

  it("leaves the app-wide focus outline to do the work", () => {
    renderSelect();
    const button = trigger();
    // Same invariant as `Select`: this control must NOT suppress the global
    // `:focus-visible` outline. The complementary accent border stays.
    expect(button.className).not.toContain("focus:outline-none");
    expect(button.className).not.toMatch(/\bfocus:ring-/);
    expect(button.className).toContain("focus:border-accent");
  });

  it("is a disabled control that says why, rather than a greyed-out mystery", () => {
    render(
      <MenuSelect
        id="background-dim"
        label="Background dim"
        value="0.6"
        options={[{ value: "0.6", label: "60%" }]}
        onChange={() => undefined}
        disabled
        hint="Pick a background first."
      />,
    );
    const button = screen.getByTestId("background-dim");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain("disabled:cursor-not-allowed");
    // The reason, associated with the control rather than merely printed
    // above it.
    expect(screen.getByText("Pick a background first.")).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe(
      screen.getByText("Pick a background first.").id,
    );
  });

  it("associates no hint when there is none, rather than an empty reference", () => {
    renderSelect();
    expect(trigger().getAttribute("aria-describedby")).toBeNull();
  });
});
