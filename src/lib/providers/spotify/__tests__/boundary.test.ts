import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Spotify provider is server-only, metadata-only, and secret-bearing.
 * These tests fail the suite if credentials, tokens, or playback code
 * drift toward client surfaces.
 */

const spotifyDir = resolve(process.cwd(), "src", "lib", "providers", "spotify");

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

function productionFiles(): string[] {
  return walk(spotifyDir);
}

describe("Spotify server boundary", () => {
  it("never references public env, client components, or playback SDKs", () => {
    const offenders: string[] = [];
    // Match real usages (imports, SDK globals, embeds), not design
    // comments that merely reject a dependency by name.
    const forbidden = [
      /NEXT_PUBLIC_SPOTIFY_/,
      /NEXT_PUBLIC_/,
      /"use client"/,
      /from\s+["'][^"']*web-playback-sdk[^"']*["']/,
      /Spotify\.Player/,
      /open\.spotify\.com\/embed/,
    ];
    for (const file of productionFiles()) {
      const content = readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(content))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never implements playback, ripping, or audio extraction", () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      const bad = lines.some(
        (line) =>
          /stream-rip|ripStream|downloadAudio|proxyAudio|\.mp3["']?\s*$/i.test(line) ||
          /getStreamContent|resolveStream|AudioSource\s*=\s*{/i.test(line),
      );
      if (bad) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never hard-codes credentials", () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const content = readFileSync(file, "utf8");
      if (/client[_-]?secret\s*[:=]\s*["'][^"']+["']/i.test(content)) {
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
        if (content.includes("providers/spotify")) {
          offenders.push(fullPath);
        }
      }
    };
    visit(srcDir);
    expect(offenders).toEqual([]);
  });

  it("keeps stream unsupported at the provider boundary", () => {
    const provider = readFileSync(join(spotifyDir, "spotify-provider.ts"), "utf8");
    expect(provider).toContain('"stream"');
    expect(provider).toContain("UnsupportedProviderCapabilityError");
  });
});
