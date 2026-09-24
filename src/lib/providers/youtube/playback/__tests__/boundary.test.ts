import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * youtubei.js lives ONLY inside the playback-resolution boundary
 * (innertube-client.ts). Resolver, format selection, contracts, and every
 * consumer must depend on the narrow `YouTubePlaybackClient` abstraction.
 * The browser receives serialized AudioSources, never library internals.
 */

const playbackDir = resolve(
  process.cwd(),
  "src",
  "lib",
  "providers",
  "youtube",
  "playback",
);

function productionFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        return walk(fullPath);
      }
      return fullPath.endsWith(".ts") && !fullPath.includes("__tests__")
        ? [fullPath]
        : [];
    });
  return walk(playbackDir);
}

describe("playback-resolution boundary", () => {
  it("imports youtubei.js only in the designated adapter", () => {
    const importers = productionFiles()
      .filter((file) => /from\s+["']youtubei\.js["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.split(/[\\/]/).pop());
    expect(importers).toEqual(["innertube-client.ts"]);
  });

  it("never touches cookies, storage, or auth tokens", () => {
    const offenders: string[] = [];
    // Match real usages, not design comments that reject them by name.
    const forbidden = [
      /document\.cookie/,
      /set-cookie/i,
      /localStorage/,
      /sessionStorage/,
      /PO_TOKEN|po_token/,
    ];
    for (const file of productionFiles()) {
      const content = readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(content))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not imported by browser components", () => {
    // Contract change (Phase 10): browser components may import the
    // client-safe orchestration layer (`lib/playback` controller/resolver),
    // which carries no youtubei.js internals, sessions, or secrets. Direct
    // imports of the server-side `youtube/playback` internals stay banned.
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
        if (content.includes("youtube/playback")) {
          offenders.push(fullPath);
        }
      }
    };
    visit(srcDir);
    expect(offenders).toEqual([]);
  });
});
