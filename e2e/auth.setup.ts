/**
 * Authenticated E2E setup project (Phase 30). Runs after the webServer
 * starts and before the chromium project (see `dependencies` in
 * playwright.config.ts). Delegates to e2e/auth/prepare.mts (real ESM
 * under tsx): migrate → seed → encode sessions → write storage states
 * → verify against /api/auth/session. Fails the run when verification
 * fails, so no test ever runs against a broken auth state.
 */
import { test as setup, expect } from "@playwright/test";
import config from "../playwright.config";
import { prepareAuthState } from "./auth/run";

const BASE_URL = config.use?.baseURL ?? "http://127.0.0.1:3100";

setup("prepare authenticated E2E state", () => {
  const result = prepareAuthState(BASE_URL);
  expect(result.userAId).toBeTruthy();
  expect(result.userBId).toBeTruthy();
  expect(result.cookieName).toMatch(/authjs\.session-token$/);
  expect(result.verified).toEqual({
    a: true,
    b: true,
    expired: true,
    tampered: true,
  });
});
