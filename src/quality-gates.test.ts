import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository-wide quality gates (Phase 24): dependencies, environment
 * classification, test isolation, and public-asset hygiene. Each assertion
 * protects a reviewed invariant; update the allowlists only while
 * reviewing the change they guard.
 */

const rootDir = resolve(process.cwd());

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("dependency gates", () => {
  it("does not reintroduce intentionally removed dependencies", () => {
    const pkg = readJson(join(rootDir, "package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Removed in Phase 22 (unused; verified zero imports repo-wide).
    expect(pkg.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("better-sqlite3");
  });
});

describe("environment gates", () => {
  it("keeps server-only credentials out of public env names", () => {
    const example = readFileSync(join(rootDir, ".env.example"), "utf8");
    const publicNames = example
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=")[0]?.trim() ?? "");
    expect(publicNames.length).toBeGreaterThan(0);
    for (const name of publicNames) {
      expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(false);
    }
  });

  it("never references public env vars in source", () => {
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
        } else if (
          (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) &&
          !fullPath.includes("__tests__")
        ) {
          if (/NEXT_PUBLIC_/.test(readFileSync(fullPath, "utf8"))) {
            offenders.push(fullPath);
          }
        }
      }
    };
    visit(join(rootDir, "src"));
    // The gate file itself names the forbidden patterns; exclude it.
    expect(offenders.filter((file) => !file.endsWith("quality-gates.test.ts"))).toEqual([]);
  });
});

describe("test isolation gates", () => {
  function sourceFiles(pattern: RegExp): string[] {
    const found: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
        } else if (pattern.test(fullPath)) {
          found.push(fullPath);
        }
      }
    };
    visit(join(rootDir, "src"));
    return found;
  }

  it("gates every live provider spec on the opt-in flag", () => {
    const liveSpecs = sourceFiles(/\.live\.spec\.ts$/);
    expect(liveSpecs.length).toBeGreaterThan(0);
    for (const file of liveSpecs) {
      const content = readFileSync(file, "utf8");
      expect(content, file).toContain("AURORA_E2E_LIVE_PLAYBACK");
      expect(content, file).toMatch(/skipIf|test\.skip/);
    }
  });

  it("keeps browser storage APIs out of production source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(/\.(ts|tsx)$/)) {
      if (
        file.includes("__tests__") ||
        file.endsWith("quality-gates.test.ts")
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (/localStorage|sessionStorage|indexedDB/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("public asset gates", () => {
  it("serves only reviewed public assets", () => {
    const allowed = new Set([
      "manifest.webmanifest",
      "sw.js",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/icon-maskable-512.png",
      // Next.js scaffold placeholders (unused by the app, kept as shipped).
      "file.svg",
      "globe.svg",
      "next.svg",
      "vercel.svg",
      "window.svg",
    ]);
    const offenders: string[] = [];
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory)) {
        if (entry.startsWith(".")) {
          continue;
        }
        const fullPath = join(directory, entry);
        const relative = prefix.length > 0 ? `${prefix}/${entry}` : entry;
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath, relative);
        } else if (!allowed.has(relative)) {
          offenders.push(relative);
        }
      }
    };
    visit(join(rootDir, "public"), "");
    expect(offenders).toEqual([]);
  });
});
