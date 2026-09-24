import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The YouTube provider is server-only: the API key must never reach the
 * browser. These tests fail the suite if secret-bearing modules drift
 * toward client surfaces.
 */

const youtubeDir = resolve(process.cwd(), "src", "lib", "providers", "youtube");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      return walk(fullPath);
    }
    return fullPath.endsWith(".ts") && !fullPath.includes("__tests__")
      ? [fullPath]
      : [];
  });
}

describe("YouTube server boundary", () => {
  it("never references public env or client components", () => {
    const offenders: string[] = [];
    // Match real usages (imports/requires/env access), not design comments
    // that merely mention a rejected dependency by name.
    // Contract change (Phase 08): youtubei.js is allowed ONLY inside the
    // playback/ subdirectory, which enforces the single-adapter rule with
    // its own boundary test. ytdl-core stays forbidden everywhere.
    const forbidden = [
      /NEXT_PUBLIC_[A-Z_]+/,
      /"use client"/,
      /from\s+["'][^"']*ytdl-core[^"']*["']/,
      /require\(\s*["'][^"']*ytdl-core[^"']*["']\s*\)/,
    ];
    const youtubeiUsage = [
      /from\s+["']youtubei\.js["']/,
      /require\(\s*["']youtubei\.js["']\s*\)/,
    ];
    for (const file of walk(youtubeDir)) {
      const content = readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(content))) {
        offenders.push(file);
      }
      const inPlaybackBoundary = file.includes("playback");
      if (
        !inPlaybackBoundary &&
        youtubeiUsage.some((pattern) => pattern.test(content))
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never hard-codes credentials", () => {
    const offenders: string[] = [];
    for (const file of walk(youtubeDir)) {
      const content = readFileSync(file, "utf8");
      if (/AIza[0-9A-Za-z_-]{10,}/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not imported by browser components", () => {
    const srcDir = resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!fullPath.endsWith(".tsx")) {
          continue;
        }
        const content = readFileSync(fullPath, "utf8");
        if (content.includes("providers/youtube")) {
          offenders.push(fullPath);
        }
      }
    };
    visit(srcDir);
    expect(offenders).toEqual([]);
  });
});
