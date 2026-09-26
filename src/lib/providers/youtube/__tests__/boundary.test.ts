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

/**
 * Removes `//` and block comments so an invariant can be checked by grepping
 * for a *usage* rather than for a mention. Aurora's provider modules explain
 * their contracts in prose that names the exact constructs the contract
 * forbids ("a second `Innertube.create()` would…"), so any check that reads raw
 * source reports the explanation as the violation.
 *
 * Deliberately crude and string-based rather than a real parse: it only has to
 * be right about the difference between prose and code, and a wrong answer here
 * means a false failure that a human reads, not a false pass that ships.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("YouTube server boundary", () => {
  it("never references public env or client components", () => {
    const offenders: string[] = [];
    // Match real usages (imports/requires/env access), not design comments
    // that merely mention a rejected dependency by name.
    //
    // Contract (Phase 08, widened in Phase 55): youtubei.js is allowed ONLY
    // inside `playback/` (stream resolution) and `innertube/` (discovery and
    // the shared session), each of which enforces its own narrower boundary
    // with its own test. ytdl-core stays forbidden everywhere — `@distube/
    // ytdl-core` is archived and the DisTube ecosystem itself has moved to
    // youtubei.js, so re-adding it would be a regression.
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
      const inAllowedBoundary = file.includes("playback") || file.includes("innertube");
      if (
        !inAllowedBoundary &&
        youtubeiUsage.some((pattern) => pattern.test(content))
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Phase 55 added InnerTube discovery, and the obvious way to write it is a
   * second `Innertube.create()`. Two sessions per process means two visitor
   * identities, two sets of player scripts, and no shared in-flight state — the
   * exact duplication the phase exists to remove. So the count is asserted, not
   * merely the location: the allowed directories may contain youtubei.js, but
   * only `innertube/session.ts` may construct a session.
   */
  it("creates exactly one Innertube session for the whole provider", () => {
    // Comments are stripped first. Both the session module's own header and
    // the playback client's header *explain* the rule by naming the forbidden
    // second `Innertube.create()`, so a naive grep matches the explanation of
    // the invariant as a violation of it — the same trap the boundary test
    // above already calls out for rejected dependencies.
    const constructors = walk(youtubeDir).filter((file) =>
      /\bInnertube\s*\.\s*create\b/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(constructors.map((file) => file.split(/[\\/]/).pop())).toEqual([
      "session.ts",
    ]);
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
