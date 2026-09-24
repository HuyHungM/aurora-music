/**
 * Production-boundary gates for the authenticated E2E harness
 * (Phase 30). The harness must be structurally incapable of leaking
 * into production: no test provider in Auth.js, no auth bypass route,
 * no committed session state, no client-exposed test secrets.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProviders, createAuthOptions } from "@/lib/auth/options";

const ROOT = resolve(__dirname, "../../../../..");
const E2E_AUTH_DIR = resolve(ROOT, "e2e/.auth");

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

describe("authenticated E2E production boundary", () => {
  it("registers only real OAuth providers (no Credentials/test provider)", () => {
    const providers = buildProviders({
      AUTH_GOOGLE_ID: "id",
      AUTH_GOOGLE_SECRET: "secret",
      AUTH_GITHUB_ID: undefined,
      AUTH_GITHUB_SECRET: undefined,
    });
    expect(providers).toHaveLength(1);
    expect((providers[0] as { id?: string }).id).toBe("google");

    expect(
      buildProviders({
        AUTH_GOOGLE_ID: undefined,
        AUTH_GOOGLE_SECRET: undefined,
        AUTH_GITHUB_ID: undefined,
        AUTH_GITHUB_SECRET: undefined,
      }),
    ).toEqual([]);
  });

  it("keeps the JWT session strategy with the session-id callback", () => {
    const config = createAuthOptions({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://localhost:5432/aurora",
      },
      prismaClient: {} as never,
    });
    expect(config.session?.strategy).toBe("jwt");
    const session = config.callbacks?.session?.({
      session: { user: {}, expires: new Date().toISOString() },
      token: { sub: "user-1" },
      trigger: "getSession",
    } as never) as { user: { id?: string } };
    expect(session.user.id).toBe("user-1");
  });

  it("gates the fixture library route behind the test-only flag", () => {
    const source = readSource("src/app/(app)/e2e-library/page.tsx");
    expect(source).toContain('process.env[E2E_AUTH_FLAG] !== "1"');
    expect(source).toContain("notFound()");
    expect(source).not.toMatch(/Credentials\(/);
    expect(source).not.toMatch(/signIn\(/);
    expect(source).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("keeps test-auth constants free of secrets and tokens", () => {
    for (const file of [
      "e2e/auth/constants.ts",
      "e2e/auth/session.ts",
      "e2e/auth/db.ts",
      "e2e/auth/run.ts",
      "e2e/auth/fixtures.ts",
    ]) {
      const source = readSource(file);
      expect(source).not.toMatch(/NEXT_PUBLIC_/);
      expect(source).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
    expect(readSource("e2e/auth/constants.ts")).toContain(
      "e2e-user-a@aurora.test",
    );
  });

  it("ignores generated browser auth state and commits none", () => {
    expect(readSource(".gitignore")).toContain("e2e/.auth/");
    if (existsSync(E2E_AUTH_DIR)) {
      expect(readdirSync(E2E_AUTH_DIR)).toEqual([]);
    }
  });
});
