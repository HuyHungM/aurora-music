// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";

afterEach(() => {
  cleanup();
});

function Harness({ label = "Confirm action" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} label={label}>
        <button type="button">Confirm</button>
        <button type="button">Cancel</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("announces an accessible name", async () => {
    const user = userEvent.setup();
    render(<Harness label="Delete playlist" />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(
      screen.getByRole("dialog", { name: "Delete playlist" }),
    ).toBeTruthy();
  });

  it("moves focus into the dialog on open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm action" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps Tab inside the dialog and restores focus on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);

    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps autofocused inputs focused instead of stealing focus", async () => {
    const user = userEvent.setup();
    function AutoFocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="Form">
            <input aria-label="Name" autoFocus />
          </Dialog>
        </>
      );
    }
    render(<AutoFocusHarness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Name" }),
    );
  });

  it("closes on overlay click without losing the page", async () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="Confirm action">
        <button type="button">Confirm</button>
      </Dialog>,
    );
    const presentation = screen
      .getByRole("dialog", { name: "Confirm action" })
      .parentElement as HTMLElement;
    // fireEvent dispatches directly on the overlay (no hit-testing), so
    // the target check inside the component is what decides.
    fireEvent.click(presentation);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
