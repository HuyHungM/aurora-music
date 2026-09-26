import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * youtubei.js lives ONLY inside two designated boundaries: `playback/` for
 * stream resolution, and `innertube/` for discovery and the shared session
 * (Phase 55 widened this; see `../__tests__/boundary.test.ts`). Resolver,
 * format selection, contracts, and every consumer must depend on the narrow
 * `YouTubePlaybackClient` abstraction. The browser receives serialized
 * AudioSources, never library internals.
 *
 * Playback and discovery share ONE `Innertube` session, not one each. A session
 * carries a visitor identity and the player scripts derived from it; two
 * sessions means two identities and no shared in-flight state, which is the
 * duplication the sharing exists to prevent. The assertion below is that the
 * playback adapter reaches youtubei.js through `innertube/session.ts` for
 * session construction, and never builds its own.
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

/**
 * Removes `//` and block comments so a boundary can be checked by grepping for
 * a *usage* rather than a mention. The adapter's header explains the
 * single-session rule by naming the `Innertube.create()` it must not call, so
 * a raw grep reports the explanation as the violation. Same trap, same fix, as
 * `../__tests__/boundary.test.ts`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("playback-resolution boundary", () => {
  it("imports youtubei.js only in the designated adapter", () => {
    const importers = productionFiles()
      .filter((file) => /from\s+["']youtubei\.js["']/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.split(/[\\/]/).pop());
    expect(importers).toEqual(["innertube-client.ts"]);
  });

  it("borrows the shared session instead of creating one", () => {
    // Phase 55 moved session construction to `innertube/session.ts`. The
    // playback adapter must consume it: a local `Innertube.create()` here
    // would be a second visitor identity in the same process, and it is the
    // exact mistake the one-session boundary test in `../__tests__/` guards.
    const offenders = productionFiles().filter(
      (file) => /\bInnertube\s*\.\s*create\b/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("takes its session from the shared module", () => {
    // The positive half of the same rule: the adapter really does use the
    // shared session, rather than passing the test above by having no session
    // at all.
    const source = readFileSync(join(playbackDir, "innertube-client.ts"), "utf8");
    expect(stripComments(source)).toMatch(/from\s+["'][^"']*innertube\/session["']/);
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
