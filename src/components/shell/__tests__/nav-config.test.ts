import { describe, expect, it } from "vitest";
import { isActivePath, navItems } from "@/components/shell/nav-config";

describe("nav-config", () => {
  it("exposes the four primary destinations", () => {
    expect(navItems.map((item) => item.href)).toEqual(["/", "/search", "/library", "/radio"]);
  });

  it("matches the root exactly for the home item", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/search", "/")).toBe(false);
  });

  it("matches a route prefix for nested paths", () => {
    expect(isActivePath("/library/playlists/abc", "/library")).toBe(true);
    expect(isActivePath("/library", "/library")).toBe(true);
    expect(isActivePath("/searching", "/search")).toBe(false);
  });
});