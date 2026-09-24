import { defineConfig, devices } from "@playwright/test";

/**
 * Live E2E (Phase 17). Browser specs under e2e/ are SELF-SKIPPING unless
 * AURORA_E2E_LIVE_PLAYBACK=1, so plain `npx playwright test` never touches
 * YouTube and `npm test` (vitest) never sees these files.
 *
 * Bounded network timeouts (documented):
 * - expect(): 15s (retrying assertions)
 * - playback start (resolve + buffer + playing): up to 60s per explicit wait
 * - seek settle: up to 30s
 * - page navigation: 30s
 * No Playwright retries (a retry would hide real playback flakiness).
 * Failure artifacts: screenshots only (no traces — traces can capture
 * network payloads; no video). Console output is redacted by the specs.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // Deterministic auth preparation (Phase 30): seeds synthetic users
      // + fixture catalog, encodes Auth.js-compatible session JWTs, and
      // verifies them against /api/auth/session. No OAuth credentials.
      name: "auth-setup",
      testMatch: "e2e/auth.setup.ts",
    },
    {
      name: "chromium",
      dependencies: ["auth-setup"],
      teardown: "auth-cleanup",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--mute-audio"] },
      },
    },
    {
      // Runs even on failure: deletes synthetic rows, asserts zero
      // leftovers, removes generated browser auth state.
      name: "auth-cleanup",
      testMatch: "e2e/auth.teardown.ts",
    },
  ],
  webServer: {
    // Production build must exist first (`npm run build`); the server runs
    // with the live flag so the gated fixture route is available to specs.
    // AURORA_E2E_AUTH=1 additionally enables the deterministic fixture
    // library (authenticated persistence journeys); without it that route
    // renders not-found, exactly as in production.
    command: "npm run start -- -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      AURORA_E2E_LIVE_PLAYBACK: "1",
      AURORA_E2E_AUTH: "1",
      PORT: "3100",
    },
  },
});
