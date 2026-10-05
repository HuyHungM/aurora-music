// @vitest-environment jsdom
/**
 * The header's ACCOUNT AND SETTINGS COMPOSITION.
 *
 * The mobile header used to carry three things this file pins as absent: a
 * Search shortcut, a compact language switcher, and a standalone Sign out. All
 * three moved — Search to the bottom rail and the `/search` route, the language
 * switcher to `/settings` (which already hosts the full one, so no preference
 * became unreachable), and Sign out behind the Profile menu.
 *
 * These assert the COMPOSITION, which the ProfileMenu suite cannot: that suite
 * renders the menu in isolation and would pass just as happily in a header that
 * still had a Sign out button sitting next to it.
 *
 * Band structure is asserted from the class names rather than from a rendered
 * viewport, because jsdom has no layout — `lg:hidden` and `hidden lg:flex` are
 * the whole contract, and a real width check belongs to the browser pass.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User } from "@/lib/domain";
import { Header } from "@/components/shell/header";
import { LocaleProvider } from "@/components/i18n/locale-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/library",
  useSearchParams: () => new URLSearchParams(),
}));

// The header mounts the shared search field, which navigates. Stubbed so the
// test exercises the header rather than the field's router wiring — and so a
// field that grows a client-only dependency cannot break a composition test.
vi.mock("@/components/search/search-field", () => ({
  SearchField: () => <input aria-label="Search tracks, artists, albums" />,
}));

vi.mock("@/app/actions/auth", () => ({
  signOutUser: vi.fn(async () => undefined),
}));

const user = {
  id: "u1",
  name: "Minh Anh",
  email: "minhanh@example.com",
  image: null,
} as unknown as User;

/** Auth is available so `SignInControl` never renders instead of the account. */
const availability = { enabled: true } as never;

function renderHeader() {
  return render(
    <LocaleProvider initialLocale="en">
      <Header user={user} availability={availability} locale="en" />
    </LocaleProvider>,
  );
}

const header = () => screen.getByRole("banner");

afterEach(cleanup);

describe("header / account and settings composition", () => {
  it("no longer carries a Search shortcut", () => {
    renderHeader();
    // The removed control was a Link to /search with an icon. The FIELD stays —
    // that is the whole point of removing only the redundant shortcut.
    expect(within(header()).queryByRole("link", { name: /search/i })).toBeNull();
    expect(header().querySelector('a[href="/search"]')).toBeNull();
    // And search itself is untouched: the field is still in the header.
    expect(
      within(header()).getByRole("textbox", { name: /search tracks/i }),
    ).toBeTruthy();
  });

  it("no longer carries a language switcher", () => {
    renderHeader();
    // The compact switcher was the only in-header language control below `lg`.
    // Nothing in the header should now claim to change the language; `/settings`
    // hosts the full switcher, so the feature is still reachable.
    const headerHtml = header().innerHTML;
    expect(headerHtml).not.toContain("LocaleSwitcher");
    expect(
      within(header()).queryByRole("button", { name: /language|ngôn ngữ/i }),
    ).toBeNull();
  });

  it("carries a compact Settings link, shown at every width below lg", () => {
    renderHeader();
    const link = within(header()).getByTestId("settings-link-compact");
    expect(link.getAttribute("href")).toBe("/settings");
    // ONE wrapper, one band. The old arrangement gave this slot to the language
    // switcher below `md` and to Settings from `md` up; the wrapper is now
    // simply `lg:hidden`, because the sidebar owns the desktop copy.
    const wrapper = link.parentElement as HTMLElement;
    expect(wrapper.className).toContain("lg:hidden");
    expect(wrapper.className).not.toContain("md:hidden");
    expect(wrapper.className).not.toContain("md:block");
  });

  it("keeps a 44px touch target on the compact Settings control", () => {
    renderHeader();
    // `h-11 w-11` clears 44px. Shrinking it to save space is the regression.
    expect(
      within(header()).getByTestId("settings-link-compact").className,
    ).toMatch(/h-11/);
  });

  it("hides Logout from the navbar below lg", () => {
    renderHeader();
    // jsdom evaluates no media queries, so the desktop Sign out is still in the
    // DOM here — what can be asserted is that it lives ONLY inside the lg-gated
    // block. What this rules out is the actual regression: a sign-out control
    // sitting in the unconditionally-rendered part of the row.
    const forms = [...header().querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      const gated = form.closest(".lg\\:flex");
      expect(
        gated,
        "a sign-out form is reachable at mobile widths",
      ).toBeTruthy();
      expect(gated?.className).toContain("hidden");
    }
    // And with the Profile menu closed there is no mobile sign-out at all.
    expect(within(header()).queryByTestId("profile-menu-signout")).toBeNull();
  });

  it("exposes the account through the Profile control", () => {
    renderHeader();
    const trigger = within(header()).getByTestId("profile-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toContain("Minh Anh");
    // The menu owns its band: below `lg` only, while the desktop block owns
    // `lg` up — one account surface per band, never two at once.
    expect(trigger.parentElement?.className).toContain("lg:hidden");
  });

  it("reveals Sign out only once the Profile menu is open", async () => {
    const user_ = userEvent.setup();
    renderHeader();
    expect(
      within(header()).queryByTestId("profile-menu-signout"),
    ).toBeNull();

    await user_.click(within(header()).getByTestId("profile-trigger"));
    const signOut = within(header()).getByTestId("profile-menu-signout");
    expect(signOut).toBeTruthy();
    // Exactly one mobile logout, and it posts the existing action. `<form>` has
    // no implicit ARIA role, so this is a DOM query rather than a role query.
    const menu = within(header()).getByTestId("profile-menu");
    expect(menu.querySelectorAll("form")).toHaveLength(1);
    expect(signOut.getAttribute("type")).toBe("submit");
  });

  it("keeps the desktop account block, with its own Sign out, for lg and up", () => {
    renderHeader();
    // The desktop copy must not collapse into the popover or vanish: the sidebar
    // footer is `hidden lg:flex`, so the header owns it from `lg` up.
    const gated = header().querySelector(".lg\\:flex");
    expect(gated, "no lg-only account block in the header").toBeTruthy();
    // Avatar chip and its own sign-out, both inside that block.
    expect(gated?.querySelector("form")).toBeTruthy();
    expect(gated?.querySelector("form button")).toBeTruthy();
    // And the popover is NOT inside it, so the two never show together.
    expect(
      within(gated as HTMLElement).queryByTestId("profile-trigger"),
    ).toBeNull();
  });

  it("renders the signed-out affordance instead of the account when signed out", () => {
    render(
      <LocaleProvider initialLocale="en">
        <Header user={null} availability={availability} locale="en" />
      </LocaleProvider>,
    );
    // No Profile control and no Logout for an anonymous visitor.
    expect(within(header()).queryByTestId("profile-trigger")).toBeNull();
    expect(within(header()).queryByTestId("profile-menu-signout")).toBeNull();
    // Settings is still reachable — it is not an account-only route.
    expect(within(header()).getByTestId("settings-link-compact")).toBeTruthy();
  });
});
