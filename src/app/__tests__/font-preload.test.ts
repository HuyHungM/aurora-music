import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Font preload guard: the mono face is defined only as a CSS variable
 * with no rendered consumer, so it must not preload its woff2 (Chrome
 * reports "preloaded but not used"). The primary sans face stays
 * preloaded for initial rendering.
 */
function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") {
        continue;
      }
      out.push(...sourceFiles(full));
    } else if (/\.(tsx|ts|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("font preload", () => {
  it("does not preload the unused mono face", () => {
    const layout = readFileSync(
      resolve(process.cwd(), "src/app/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/Geist_Mono\([\s\S]*preload:\s*false/);
  });

  it("keeps the primary sans face preloaded", () => {
    const layout = readFileSync(
      resolve(process.cwd(), "src/app/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/Geist\([\s\S]*subsets/);
    expect(layout).not.toMatch(/Geist\([^)]*preload:\s*false/);
  });

  it("has no rendered consumer of the mono face", () => {
    // If this fails, a real font-mono consumer exists: re-enable
    // preloading for Geist_Mono instead of weakening this guard.
    const offenders = sourceFiles(resolve(process.cwd(), "src")).filter(
      (file) => {
        if (file.endsWith("globals.css") || file.endsWith("layout.tsx")) {
          return false;
        }
        const content = readFileSync(file, "utf8");
        return (
          /\bfont-mono\b/.test(content) ||
          /var\(--font-geist-mono\)/.test(content) ||
          /var\(--font-mono\)/.test(content)
        );
      },
    );
    expect(offenders).toEqual([]);
  });
});
