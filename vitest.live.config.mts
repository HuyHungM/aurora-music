import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Live provider gate (Phase 17). Runs ONLY specs matching *.live.spec.ts,
 * which self-skip unless AURORA_E2E_LIVE_PLAYBACK=1. `bun run test` never
 * includes these files (default config only matches *.test.* under src).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.live.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
    },
  },
});
