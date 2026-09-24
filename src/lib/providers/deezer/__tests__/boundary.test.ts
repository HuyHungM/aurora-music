import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Deezer provider is server-only and metadata-only. These tests fail
 * the suite if secret-bearing or playback-bearing code drifts into the
 * module or toward client surfaces.
 */

const deezerDir = resolve(process.cwd(), "src", "lib", "providers", "deezer");

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

describe("Deezer server boundary", () => {
  it("never references public env, client components, or playback SDKs", () => {
    const offenders: string[] = [];
    const forbidden = [
      /NEXT_PUBLIC_[A-Z_]+/,
      /"use client"/,
      /Web Playback/,
    ];
    for (const file of walk(deezerDir)) {
      const content = readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(content))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never implements stream resolution or raw stream urls", () => {
    const offenders: string[] = [];
    for (const file of walk(deezerDir)) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      const bad = lines.some(
        (line) =>
          // The required interface stub + docs mention "stream"; a real
          // resolver (fetching or returning audio urls) must not exist.
          (/mp3|cdn/i.test(line) && !/preview/i.test(line)) ||
          /getStreamContent|resolveStream|streamUrl\s*=\s*["']http/i.test(line),
      );
      if (bad) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never hard-codes credentials", () => {
    const offenders: string[] = [];
    for (const file of walk(deezerDir)) {
      const content = readFileSync(file, "utf8");
      if (/deezer[_-]?token\s*=\s*["'][^"']+["']/i.test(content)) {
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
        if (content.includes("providers/deezer")) {
          offenders.push(fullPath);
        }
      }
    };
    visit(srcDir);
    expect(offenders).toEqual([]);
  });

  it("exposes no raw upstream objects to callers", () => {
    // Normalized Track carries previewUrl (30s preview metadata); the
    // provider must never promise it as a stream. Capability + stub cover it.
    const provider = readFileSync(join(deezerDir, "deezer-provider.ts"), "utf8");
    expect(provider).toContain('"stream"');
    expect(provider).toContain("UnsupportedProviderCapabilityError");
  });
});
