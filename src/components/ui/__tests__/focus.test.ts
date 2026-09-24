// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { focusFirstByLabel } from "@/components/ui/focus";

describe("focusFirstByLabel", () => {
  it("focuses the first match and reports success", () => {
    document.body.innerHTML =
      '<button aria-label="Up next">a</button><button aria-label="Up next">b</button>';
    const first = document.querySelectorAll("button")[0] as HTMLElement;
    expect(focusFirstByLabel("Up next")).toBe(true);
    expect(document.activeElement).toBe(first);
    document.body.innerHTML = "";
  });

  it("returns false when nothing matches", () => {
    document.body.innerHTML = "";
    expect(focusFirstByLabel("Up next")).toBe(false);
  });
});
