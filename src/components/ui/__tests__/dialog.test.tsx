// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  /**
   * Phase 49 regression. `handleEscape` was memoized on the caller-supplied
   * `onClose`, and callers pass an inline arrow, so the focus/lock effect
   * re-ran on every parent render. Its cleanup restores focus to the trigger
   * and its setup pulls focus back to the dialog, so any state change from a
   * control *inside* the dialog (the real case is the share dialog's
   * "Copy link" / "Enable sharing" buttons) yanked focus out of the field the
   * user was on and restarted traversal from the top of the dialog.
   */
  it("keeps focus where it is when the parent re-renders", async () => {
    const user = userEvent.setup();

    function ReopenHarness() {
      const [open, setOpen] = useState(false);
      const [copied, setCopied] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="Confirm action">
            <input aria-label="Share link" />
            <button type="button" onClick={() => setCopied(true)}>
              Copy link
            </button>
            <span>{copied ? "Copied" : ""}</span>
          </Dialog>
        </>
      );
    }

    render(<ReopenHarness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);

    const input = screen.getByLabelText("Share link");
    await user.click(input);
    expect(document.activeElement).toBe(input);

    // A state change from a control inside the dialog re-renders the parent,
    // which re-creates the inline `onClose`. Clicking the button is what
    // focuses it, so that is the element whose focus must survive.
    const copy = screen.getByRole("button", { name: "Copy link" });
    await user.click(copy);
    expect(screen.getByText("Copied")).toBeTruthy();

    // Without the fix the effect re-ran: cleanup restored focus to the
    // trigger, then setup pulled it back to the dialog container. Either way
    // the button below loses it.
    expect(document.activeElement).toBe(copy);
    expect(document.activeElement).not.toBe(trigger);
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
    // Focus returns at CLOSE REQUEST, not at unmount: the dialog is still
    // fading out, so waiting for it to disappear would be asserting the
    // wrong moment. `inert` is what makes returning early safe.
    expect(document.activeElement).toBe(trigger);
    // ...and the dialog is still in the document, mid-exit, and out of the
    // accessibility tree. Queried by attribute rather than by role on
    // purpose: an inert element is hidden from assistive tech, so a role
    // query failing to find it would be the contract working, not breaking.
    const exiting = document.querySelector<HTMLElement>(
      '[data-presence="exiting"][role="dialog"]',
    );
    expect(exiting).toBeTruthy();
    expect(exiting?.hasAttribute("inert")).toBe(true);
    // Once the exit is over it is genuinely gone.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
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
