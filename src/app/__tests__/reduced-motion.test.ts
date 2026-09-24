import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reduced-motion guard (Phase 29): the global stylesheet must keep the
 * prefers-reduced-motion rule that stills spinners, pulses, and slide
 * transitions for users who request it.
 */
describe("reduced motion", () => {
  it("keeps the reduced-motion override in global CSS", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration");
    expect(css).toContain("transition-duration");
  });
});
