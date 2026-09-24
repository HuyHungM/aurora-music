// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("Button component", () => {
  describe("icon size meets 44px touch target", () => {
    it("icon button renders with h-11 w-11", () => {
      render(
        <Button variant="ghost" size="icon" aria-label="Test icon">
          <span>Icon</span>
        </Button>,
      );
      const btn = screen.getByRole("button", { name: "Test icon" });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });

    it("ghost variant icon button meets 44px", () => {
      render(
        <Button variant="ghost" size="icon" aria-label="Ghost icon">
          <span>Icon</span>
        </Button>,
      );
      const btn = screen.getByRole("button", { name: "Ghost icon" });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });
  });
});
