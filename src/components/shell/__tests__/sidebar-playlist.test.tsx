// @vitest-environment jsdom
/**
 * The sidebar playlist link (Stitch rail).
 *
 * The rail lists the listener's REAL playlists, and each entry is a `Link`
 * to that playlist's own route. The two things a rail link can get wrong —
 * and the two this pins — are that it must point at the playlist it names,
 * and that it must say where you are. `aria-current` is asserted only on the
 * EXACT route: a prefix match would light up every playlist whose id happens
 * to extend another's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SidebarPlaylistLink } from "../sidebar-playlist";

const mocks = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  mocks.pathname = "/";
});

describe("SidebarPlaylistLink", () => {
  it("links to the playlist it names, with the title as its accessible name", () => {
    render(
      <SidebarPlaylistLink playlist={{ id: "pl-1", title: "Night Drive" }} />,
    );
    const link = screen.getByRole("link", { name: "Night Drive" });
    expect(link.getAttribute("href")).toBe("/library/playlists/pl-1");
    expect(link.getAttribute("aria-current")).toBeNull();
  });

  it("marks the link current on its own route", () => {
    mocks.pathname = "/library/playlists/pl-1";
    render(
      <SidebarPlaylistLink playlist={{ id: "pl-1", title: "Night Drive" }} />,
    );
    expect(
      screen.getByRole("link", { name: "Night Drive" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("does not treat a longer id with the same prefix as current", () => {
    mocks.pathname = "/library/playlists/pl-1-extra";
    render(
      <SidebarPlaylistLink playlist={{ id: "pl-1", title: "Night Drive" }} />,
    );
    expect(
      screen.getByRole("link", { name: "Night Drive" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});
