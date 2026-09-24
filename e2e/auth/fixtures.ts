/**
 * Reusable authenticated-browser fixtures (Phase 30). Each fixture
 * opens an isolated browser context from the storage state generated
 * by the auth-setup project — no shared cookies, no localStorage auth,
 * no cross-test leakage. Fixtures are lazy: only requested roles are
 * instantiated. The default `page` fixture (no storage state) remains
 * available for unauthenticated-leakage assertions.
 */
/* eslint-disable react-hooks/rules-of-hooks -- `use` is Playwright's fixture API here, not a React Hook. */
import { test as base, type Page } from "@playwright/test";
import { storageStatePath } from "./constants";

export interface AuthFixtures {
  pageA: Page;
  pageB: Page;
  expiredPage: Page;
  tamperedPage: Page;
}

async function pageForRole(
  browser: import("@playwright/test").Browser,
  role: string,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const context = await browser.newContext({
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

export { expect } from "@playwright/test";
