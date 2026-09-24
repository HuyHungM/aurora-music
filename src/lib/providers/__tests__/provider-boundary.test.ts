import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Provider server boundary for Deezer/Spotify (Phase 24). Mirrors the
 * YouTube boundary rule: no `.tsx` file — not even a server component —
 * may reach into provider implementation submodules. Pages and server
 * actions go through `@/lib/providers/server` (which contains no
 * `/youtube/`, `/deezer/`, or `/spotify/` segment) instead.
 */

const srcDir = resolve(process.cwd(), "src");
const IMPLEMENTATION_IMPORT = /providers\/(youtube|deezer|spotify)\//;

function tsxOffenders(): string[] {
  const offenders: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        visit(fullPath);
      } else if (
        fullPath.endsWith(".tsx") &&
        IMPLEMENTATION_IMPORT.test(readFileSync(fullPath, "utf8"))
      ) {
        offenders.push(fullPath);
      }
    }
  };
  visit(srcDir);
  return offenders;
}

describe("provider server boundary", () => {
  it("never imports provider implementations from tsx", () => {
    expect(tsxOffenders()).toEqual([]);
  });
});
