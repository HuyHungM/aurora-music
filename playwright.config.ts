import { defineConfig, devices } from "@playwright/test";

/**
 * Live E2E (Phase 17). Browser specs under e2e/ are SELF-SKIPPING unless
 * AURORA_E2E_LIVE_PLAYBACK=1, so plain `bunx playwright test` never touches
 * YouTube and `bun run test` (vitest) never sees these files.
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
    // Deterministic rendered language for every context.
    //
    // Locale precedence is account preference -> cookie -> Vietnamese, and
    // Vietnamese is the shipped default. Anonymous contexts have no
    // `User.locale`, so they always fell through to Vietnamese while these
    // specs assert the real English accessible names they author. Seeding
    // the account preference (e2e/auth/constants.ts E2E_LOCALE) is what
    // keeps the authenticated specs deterministic; this cookie is the
    // anonymous equivalent and travels the same shipped code path
    // (`getRequestLocale` -> resolveLocale). It sets no auth cookie, so
    // "default context stays unauthenticated" assertions are unaffected.
    storageState: {
      cookies: [
        {
          name: "aurora-locale",
          value: "en",
          domain: "127.0.0.1",
          path: "/",
          sameSite: "Lax",
          httpOnly: false,
          secure: false,
          expires: -1,
        },
      ],
      origins: [],
    },
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
      // Phase 54 mobile projects.
      //
      // These exist so a phone is a first-class configuration rather than a
      // viewport someone remembered to resize. Two profiles, because the two
      // constraints are different and one cannot cover both: portrait is a
      // WIDTH constraint (the signed-in header row overflows between 375 and
      // 393), landscape phone is a HEIGHT constraint (the full player's
      // controls fall off a 375px-tall screen).
      //
      // `testMatch` is scoped to the mobile spec ON PURPOSE. A project-level
      // device applies to every spec that runs in it, and most of the
      // existing suite measures desktop layout bands — 360/390/412/
      // 768/820/1024/1280/1440/1920 — where a 412px frame is the opposite of
      // the point. Re-pointing them at a phone would change what they test
      // without changing what they claim to test. So the phone projects run
      // the phone suite, and the desktop suite keeps the desktop.
      //
      // `e2e/mobile-layout.spec.ts` still resizes explicitly inside each
      // test, because these profiles establish the DEVICE (coarse pointer, no
      // hover, real touch) and the explicit widths establish the layout
      // matrix. A resize alone does not make Chromium report
      // `(pointer: coarse)`, which is what the 44px floor is gated on.
      name: "mobile-chromium",
      testMatch: "e2e/mobile-layout.spec.ts",
      dependencies: ["auth-setup"],
      teardown: "auth-cleanup",
      use: {
        ...devices["Pixel 7"],
        launchOptions: { args: ["--mute-audio"] },
      },
    },
    {
      // iPhone 15 Pro Max, rotated. Same reasoning, opposite constraint: at
      // 430x932 the width is generous and 932px of height is not the
      // problem, but rotate to 932x430 and the full player has to become a
      // two-column composition or its controls become unreachable.
      //
      // `defaultBrowserType` is pinned to Chromium because Playwright's iPhone
      // descriptors name WebKit, which is not installed here — and the thing
      // under test is the LAYOUT at a rotated phone size, not WebKit's
      // rendering of it. The device profile (viewport, DPR, touch, mobile
      // emulation) is what this project exists to establish.
      name: "mobile-landscape",
      testMatch: "e2e/mobile-layout.spec.ts",
      dependencies: ["auth-setup"],
      teardown: "auth-cleanup",
      use: {
        ...devices["iPhone 15 Pro Max"],
        defaultBrowserType: "chromium",
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
    // Production build must exist first (`bun run build`); the server runs
    // with the live flag so the gated fixture route is available to specs.
    // AURORA_E2E_AUTH=1 additionally enables the deterministic fixture
    // library (authenticated persistence journeys); without it that route
    // renders not-found, exactly as in production.
    command: "bun run start -- -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      AURORA_E2E_LIVE_PLAYBACK: "1",
      AURORA_E2E_AUTH: "1",
      PORT: "3100",
      // `next start` means NODE_ENV=production, so the test flags above trip
      // the production guard in `parseEnv`. This acknowledgment is what tells
      // it a production-mode server is intentional here. It is set here and
      // nowhere else in the repository; a deploy that sets a test flag
      // without it fails closed at boot.
      AURORA_E2E_ALLOW_TEST_FLAGS: "1",
    },
  },
});
