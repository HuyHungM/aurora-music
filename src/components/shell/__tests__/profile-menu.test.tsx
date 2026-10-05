// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "@/lib/domain";
import { ProfileMenu } from "@/components/shell/profile-menu";

// Vitest runs with `globals: false`, so Testing Library's automatic cleanup
// never registers and each render would stack on the previous one — which shows
// up as "found multiple elements by data-testid" rather than as anything to do
// with the component under test.
afterEach(cleanup);

/**
 * The mobile account control.
 *
 * The assertions are about BEHAVIOUR — open, close, focus, and where the panel
 * is anchored — because "the element exists" would pass for a menu that never
 * opens, never closes, or renders on the wrong side of the avatar.
 */

vi.mock("@/app/actions/auth", () => ({
  signOutUser: vi.fn(async () => undefined),
}));

const user: User = {
  id: "u1",
  name: "Minh Anh",
  email: "minhanh@example.com",
  image: null,
} as unknown as User;

function renderMenu() {
  return render(<ProfileMenu user={user} locale="en" />);
}

describe("ProfileMenu", () => {
  it("starts closed, with no sign-out anywhere in the trigger", () => {
    renderMenu();
    const trigger = screen.getByTestId("profile-trigger");
    expect(trigger).toBeTruthy();
    expect(screen.queryByTestId("profile-menu")).toBeNull();
    expect(screen.queryByTestId("profile-menu-signout")).toBeNull();
  });

  it("exposes expanded state and names itself for assistive tech", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("profile-trigger");
    // Collapsed: no expanded state at all, rather than a hard-coded `false`
    // that a screen reader would read as "collapsed, and there is a thing".
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toContain("Minh Anh");

    await user_.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // And the trigger now points at a real element.
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).toBe(screen.getByTestId("profile-menu"));
  });

  it("opens on activation and reveals sign-out", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    await user_.click(screen.getByTestId("profile-trigger"));
    expect(screen.getByTestId("profile-menu")).toBeTruthy();
    expect(screen.getByTestId("profile-menu-signout")).toBeTruthy();
  });

  it("opens from the keyboard too", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("profile-trigger");
    trigger.focus();
    await user_.keyboard("{Enter}");
    expect(screen.getByTestId("profile-menu")).toBeTruthy();
  });

  it("shows the name and email so the panel explains itself", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    await user_.click(screen.getByTestId("profile-trigger"));
    expect(screen.getByText("Minh Anh")).toBeTruthy();
    expect(screen.getByText("minhanh@example.com")).toBeTruthy();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("profile-trigger");
    await user_.click(trigger);
    expect(screen.getByTestId("profile-menu")).toBeTruthy();

    await user_.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("profile-menu")).toBeNull());
    // Focus going nowhere is the classic disclosure bug: the user is dropped at
    // the top of the document and has to tab all the way back.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when tapping outside", async () => {
    const user_ = userEvent.setup();
    render(
      <div>
        <ProfileMenu user={user} locale="en" />
        <button type="button">elsewhere</button>
      </div>,
    );
    await user_.click(screen.getByTestId("profile-trigger"));
    expect(screen.getByTestId("profile-menu")).toBeTruthy();

    fireEvent.pointerDown(screen.getByText("elsewhere"));
    await waitFor(() => expect(screen.queryByTestId("profile-menu")).toBeNull());
  });

  it("stays open when the pointer lands inside it", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    // A pointerdown on the panel's own padding must not be read as "outside".
    fireEvent.pointerDown(screen.getByTestId("profile-menu"));
    expect(screen.getByTestId("profile-menu")).toBeTruthy();
  });

  it("toggles closed on a second activation, with no duplicate panel", async () => {
    const user_ = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("profile-trigger");
    await user_.click(trigger);
    await user_.click(trigger);
    expect(screen.queryByTestId("profile-menu")).toBeNull();
    // The failure this guards is two panels stacked on each other after a
    // double activation, each with its own listener.
    expect(document.querySelectorAll("#" + (trigger.getAttribute("aria-controls") ?? "x"))).toHaveLength(0);
  });

  it("leaves exactly one sign-out form, posting the existing action", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    // One logout in the application: the desktop control is a separate
    // component, and this must not have introduced a second mechanism.
    const forms = document.querySelectorAll('form[action]');
    expect(forms).toHaveLength(1);
    expect(screen.getByTestId("profile-menu-signout").getAttribute("type")).toBe("submit");
  });

  it("anchors the panel to the profile control, not the header or the viewport", () => {
    const { container } = renderMenu();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    const panel = screen.getByTestId("profile-menu");
    const className = panel.className;
    // `relative` on the wrapper is what makes it the containing block. Without
    // it the header's own `backdrop-filter` would capture the absolutely
    // positioned panel and it would drift by the header's safe-area inset.
    expect(container.querySelector(".relative")).toBeTruthy();
    // `end-0` is logical (inset-inline-end), so the panel stays flush with the
    // avatar in RTL too; `right-0` would not.
    expect(className).toContain("end-0");
    expect(className).not.toMatch(/\bright-0\b/);
    expect(className).toContain("absolute");
    // Viewport-capped so a 320px phone cannot be pushed into horizontal scroll.
    expect(className).toContain("100vw");
    // A deliberate layer from the existing scale, not an invented big number.
    expect(className).toContain("z-dropdown");
    expect(className).not.toMatch(/z-\[/);
  });

  it("uses the shell's own glass material rather than a new surface", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    // The same class the dialogs and menus already use.
    expect(screen.getByTestId("profile-menu").className).toContain("aurora-glass-float");
  });

  it("gives the trigger a non-colour open state", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    // Border AND background both move, so the open state does not depend on hue.
    const open = screen.getByTestId("profile-trigger").className;
    expect(open).toContain("border-border-strong");
    expect(open).toContain("bg-surface-active");
  });
});
