/**
 * Subprocess runner for the authenticated E2E harness (Phase 30).
 *
 * Playwright loads test/setup files through a CommonJS transform, so
 * anything needing ESM-only modules (the generated Prisma client with
 * `import.meta`, Auth.js ESM) must run in a `tsx` subprocess instead.
 * This module is intentionally dependency-free (CJS-safe) and is the
 * only bridge Playwright-loaded files use to reach the database.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function runScript(name: string, args: string[] = []): string {
  // Runs the ESM-only harness scripts with the exact node binary that
  // launched Playwright (no PATH/shell lookup, no .cmd shims), via the
  // repository's own tsx installation. stderr is captured so a failing
  // script surfaces its own message instead of a bare exit code.
  const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  try {
    return execFileSync(
      process.execPath,
      [tsxCli, `e2e/auth/${name}.mts`, ...args],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    const stderr =
      error !== null &&
      typeof error === "object" &&
      "stderr" in error &&
      typeof (error as { stderr: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : String(error);
    throw new Error(`e2e/auth/${name}.mts failed: ${stderr}`);
  }
}

function runJson<T>(name: string, args: string[] = []): T {
  const out = runScript(name, args);
  return JSON.parse(out.trim().split("\n").pop() ?? "null") as T;
}

export interface PrepareResult {
  userAId: string;
  userBId: string;
  cookieName: string;
  verified: Record<string, boolean>;
}

export function prepareAuthState(baseURL: string): PrepareResult {
  return runJson<PrepareResult>("prepare", ["--base-url", baseURL]);
}

export interface CleanupCounts {
  users: number;
  playlists: number;
  playlistTracks: number;
  likes: number;
  fixtureTracks: number;
  total: number;
}

export function cleanupAuthState(): CleanupCounts {
  return runJson<CleanupCounts>("clean", []);
}

export function dbPlaylistTrackTitles(playlistId: string): string[] {
  return runJson<string[]>("read", ["titles", playlistId]);
}

export function dbIsTrackLiked(email: string, providerTrackId: string): boolean {
  return runJson<boolean>("read", ["liked", email, providerTrackId]);
}

export function dbPlaylistOwner(
  playlistId: string,
): { userId: string; email: string | null } | null {
  return runJson<{ userId: string; email: string | null } | null>("read", [
    "owner",
    playlistId,
  ]);
}
