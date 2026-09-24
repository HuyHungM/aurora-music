import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Singleton-ownership gates (Phase 24). Exactly one production owner may
 * construct each playback singleton; every other reference must live in
 * `__tests__`. This keeps a second engine/queue/controller/recovery from
 * slipping in behind the existing suites.
 */

const srcDir = resolve(process.cwd(), "src");

function sourceFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        return walk(fullPath);
      }
      return fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")
        ? [fullPath]
        : [];
    });
  return walk(srcDir);
}

function productionOffenders(pattern: RegExp, definingFile?: string): string[] {
  return sourceFiles().filter((file) => {
    if (file.includes("__tests__")) {
      return false;
    }
    // The defining module mentions its own factory; ownership means
    // nobody else *calls* it.
    if (definingFile && file === resolve(srcDir, definingFile)) {
      return false;
    }
    return pattern.test(readFileSync(file, "utf8"));
  });
}

describe("playback singleton ownership", () => {
  it("constructs PlayerEngine only in the engine factory", () => {
    expect(productionOffenders(/new PlayerEngine\(/)).toEqual([
      resolve(srcDir, "lib/player/engine-factory.ts"),
    ]);
  });

  it("creates the MusicEngine facade only in PlayerHost", () => {
    expect(
      productionOffenders(/createMusicEngine\(/, "lib/music/music-engine.ts"),
    ).toEqual([resolve(srcDir, "components/player/player-host.tsx")]);
  });

  it("creates PlaybackControllers only in PlayerHost", () => {
    expect(
      productionOffenders(
        /createPlaybackController\(/,
        "lib/playback/controller.ts",
      ),
    ).toEqual([resolve(srcDir, "components/player/player-host.tsx")]);
  });

  it("creates QueueManagers only in PlayerHost", () => {
    expect(
      productionOffenders(
        /createQueueManager\(/,
        "lib/music/queue-manager.ts",
      ),
    ).toEqual([resolve(srcDir, "components/player/player-host.tsx")]);
  });

  it("keeps resolution generations on the single guard primitive", () => {
    expect(
      productionOffenders(
        /createResolutionGuard\(/,
        "lib/player/playback-source.ts",
      ),
    ).toEqual([resolve(srcDir, "lib/playback/controller.ts")]);
  });

  it("integrates browser Media Session only in the designated adapter", () => {
    expect(productionOffenders(/setActionHandler\(/)).toEqual([
      resolve(srcDir, "lib/player/media-session.ts"),
    ]);
  });

  it("bounds recovery attempts on the single policy constant", () => {
    const offenders = productionOffenders(/MAX_RECOVERY_ATTEMPTS/).filter(
      (file) => !file.endsWith("recovery.ts"),
    );
    expect(offenders).toEqual([
      resolve(srcDir, "lib/playback/controller.ts"),
    ]);
  });
});
