import { describe, expect, it } from "vitest";
import { buildProviders, createAuthOptions } from "@/lib/auth/options";
import type { EnvConfig } from "@/lib/config/env";
import type { PrismaClient } from "@/generated/prisma/client";

const noOAuth: EnvConfig = {
  NODE_ENV: "development",
  DATABASE_URL: "file:./dev.db",
  AUTH_GOOGLE_ID: undefined,
  AUTH_GOOGLE_SECRET: undefined,
  AUTH_GITHUB_ID: undefined,
  AUTH_GITHUB_SECRET: undefined,
};

const stubPrisma = {} as unknown as PrismaClient;

type SessionCallback = (params: {
  session: { user?: { id?: string } };
  token: { sub?: string };
}) => { user?: { id?: string } };

function sessionCallback(config: ReturnType<typeof createAuthOptions>): SessionCallback {
  return config.callbacks!.session as unknown as SessionCallback;
}

describe("buildProviders", () => {
  it("returns no providers when no credentials are configured", () => {
    expect(buildProviders(noOAuth)).toHaveLength(0);
  });

  it("adds Google when both Google credentials are present", () => {
    const providers = buildProviders({
      ...noOAuth,
      AUTH_GOOGLE_ID: "id",
      AUTH_GOOGLE_SECRET: "secret",
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].name ?? "").toMatch(/google/i);
  });

  it("adds GitHub when both GitHub credentials are present", () => {
    const providers = buildProviders({
      ...noOAuth,
      AUTH_GITHUB_ID: "id",
      AUTH_GITHUB_SECRET: "secret",
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].name ?? "").toMatch(/github/i);
  });

  it("ignores partially configured providers", () => {
    const providers = buildProviders({
      ...noOAuth,
      AUTH_GOOGLE_ID: "id",
      AUTH_GITHUB_SECRET: "secret",
    });
    expect(providers).toHaveLength(0);
  });

  it("adds both providers when all credentials are present", () => {
    const providers = buildProviders({
      ...noOAuth,
      AUTH_GOOGLE_ID: "g-id",
      AUTH_GOOGLE_SECRET: "g-secret",
      AUTH_GITHUB_ID: "h-id",
      AUTH_GITHUB_SECRET: "h-secret",
    });
    expect(providers).toHaveLength(2);
  });
});

describe("createAuthOptions", () => {
  it("uses JWT sessions", () => {
    const config = createAuthOptions({ env: noOAuth, prismaClient: stubPrisma });
    expect(config.session?.strategy).toBe("jwt");
  });

  it("forwards the secret", () => {
    const env = { ...noOAuth, AUTH_SECRET: "top-secret" };
    const config = createAuthOptions({ env, prismaClient: stubPrisma });
    expect(config.secret).toBe("top-secret");
  });

  it("trusts the host", () => {
    const config = createAuthOptions({ env: noOAuth, prismaClient: stubPrisma });
    expect(config.trustHost).toBe(true);
  });

  it("exposes the configured providers", () => {
    const env = {
      ...noOAuth,
      AUTH_GOOGLE_ID: "g-id",
      AUTH_GOOGLE_SECRET: "g-secret",
    };
    const config = createAuthOptions({ env, prismaClient: stubPrisma });
    expect(config.providers).toHaveLength(1);
  });

  it("maps the token subject into the session user id", () => {
    const config = createAuthOptions({ env: noOAuth, prismaClient: stubPrisma });
    const callback = sessionCallback(config);
    const result = callback({ session: { user: {} }, token: { sub: "user-123" } });
    expect(result.user?.id).toBe("user-123");
  });

  it("leaves the session unchanged when no subject is present", () => {
    const config = createAuthOptions({ env: noOAuth, prismaClient: stubPrisma });
    const callback = sessionCallback(config);
    const result = callback({ session: { user: { id: "kept" } }, token: {} });
    expect(result.user?.id).toBe("kept");
  });
});