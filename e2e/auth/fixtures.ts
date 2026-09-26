/**
 * Reusable authenticated-browser fixtures (Phase 30). Each fixture
 * opens an isolated browser context from the storage state generated
 * by the auth-setup project — no shared cookies, no localStorage auth,
 * no cross-test leakage. Fixtures are lazy: only requested roles are
 * instantiated. The default `page` fixture (no storage state) remains
 * available for unauthenticated-leakage assertions.
 */
/* eslint-disable react-hooks/rules-of-hooks -- `use` is Playwright's fixture API here, not a React Hook. */
import { test as base, devices, type BrowserContextOptions, type Page } from "@playwright/test";
import { storageStatePath } from "./constants";

export interface AuthFixtures {
  pageA: Page;
  pageB: Page;
  expiredPage: Page;
  tamperedPage: Page;
}

/**
 * Context options applied on top of the stored auth state.
 *
 * Phase 54. `pageForRole` opens its context with `browser.newContext({...})`
 * and nothing else, which means the project's `use` block never reaches these
 * pages - a device descriptor on a project does NOT propagate to a
 * hand-built context. So a project that declares a phone profile would still
 * have produced a desktop pointer here, and the 44px touch floor (gated on
 * `(hover: none) and (pointer: coarse)`) would have been correctly absent
 * from every assertion that was supposed to be testing it.
 *
 * Passing the device explicitly is therefore the only way to test a coarse
 * pointer on an authenticated page.
 */
export type AuthContextOptions = Pick<
  BrowserContextOptions,
  "viewport" | "hasTouch" | "isMobile" | "deviceScaleFactor"
>;

/**
 * A real phone profile, minus the parts a layout test must control.
 *
 * `...devices["Pixel 7"]` also sets a `defaultBrowserType` and a UA string;
 * the UA is dropped because a spoofed mobile UA without mobile emulation
 * makes the app render its desktop layout while claiming to be a phone, which
 * is a strictly worse failure than an honest one.
 */
export const PHONE_EMULATION = {
  viewport: devices["Pixel 7"].viewport,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
} as const satisfies AuthContextOptions;

/**
 * Device profile per project name, for the mobile projects (Phase 54).
 *
 * A project's `use` block does not reach a hand-built context, so the device
 * has to be re-applied here by hand. Keyed on the project name so the
 * project's declared profile is the one that runs, rather than a second,
 * silently different one hardcoded in the fixture — a mismatch there would
 * mean the config says Pixel 7 while the assertions ran on something else,
 * and nothing would report it.
 *
 * Landscape is a rotation, not a small phone: `iPhone 15 Pro Max` is
 * 430x932, so the landscape profile is that same device at 932x430. The
 * layout is identical either way; only the constraint flips from width to
 * height, which is the whole reason the phone suite has a landscape case.
 */
const PROJECT_DEVICES: Record<string, AuthContextOptions> = {
  "mobile-chromium": {
    viewport: devices["Pixel 7"].viewport,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  },
  "mobile-landscape": {
    viewport: { width: 932, height: 430 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  },
};

/** The device a project declares, or the default phone for the desktop project. */
export function deviceForProject(projectName: string): AuthContextOptions {
  return PROJECT_DEVICES[projectName] ?? PHONE_EMULATION;
}

async function pageForRole(
  browser: import("@playwright/test").Browser,
  role: string,
  options: AuthContextOptions = {},
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...options,
    storageState: storageStatePath(role),
  });
  const page = await context.newPage();
  return { context, page };
}

export const authTest = base.extend<AuthFixtures>({
  pageA: async ({ browser }, use) => {
    const { context, page } = await pageForRole(browser, "a");
    await use(page);
    await context.close();
  },
  pageB: async ({ browser }, use) => {
    const { context, page } = await pageForRole(browser, "b");
    await use(page);
    await context.close();
  },
  expiredPage: async ({ browser }, use) => {
    const { context, page } = await pageForRole(browser, "expired");
    await use(page);
    await context.close();
  },
  tamperedPage: async ({ browser }, use) => {
    const { context, page } = await pageForRole(browser, "tampered");
    await use(page);
    await context.close();
  },
});

export interface MobileAuthFixtures {
  /** Account A in an emulated phone context: coarse pointer, no hover. */
  phoneA: Page;
}

/**
 * `authTest` plus a page in the DEVICE the running project declares.
 *
 * Kept as a separate export rather than changing `pageA` for every existing
 * spec: the desktop specs measure dense toolbars and layout bands where a
 * 1280px viewport is the point, and silently re-pointing them at a phone
 * would change what they test without changing what they say they test.
 * Mobile behaviour gets its own fixture, explicitly requested.
 */
export const mobileAuthTest = authTest.extend<MobileAuthFixtures>({
  phoneA: async ({ browser }, use, testInfo) => {
    const { context, page } = await pageForRole(browser, "a", deviceForProject(testInfo.project.name));
    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";
