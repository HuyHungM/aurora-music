import { vi } from "vitest";

// Ensure unit tests always have a dummy DATABASE_URL so env validation passes
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://localhost:5432/aurora_test";
}

/**
 * Global unit-test setup (Phase 42). Component suites import UI that
 * transitively reaches server-action modules (`@/app/actions/*` →
 * `@/lib/dal/session` → `@/lib/auth` → next-auth), and vite-node cannot
 * resolve next-auth's extensionless `next/server` subpath. Auth behavior
 * is never under test in these suites (action tests mock
 * `@/lib/dal/session` directly), so a single neutral mock keeps every
 * suite loadable without per-file boilerplate.
 */
vi.mock("@/lib/auth", () => ({
  handlers: { GET: vi.fn(), POST: vi.fn() },
  auth: vi.fn(async () => null),
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}));

/**
 * The locale provider persists via the `setLocaleAction` server action,
 * whose module pulls `next/headers` + the DAL session chain (unresolvable
 * under vite-node, same as next-auth above). Unit suites never exercise
 * real persistence — the DAL contract is covered by DB tests and the real
 * flow by E2E — so the action is stubbed to echo the requested locale.
 */
vi.mock("@/app/actions/locale", () => ({
  setLocaleAction: vi.fn(async (locale: unknown) => ({
    ok: true,
    locale: locale === "en" ? "en" : "vi",
  })),
}));
