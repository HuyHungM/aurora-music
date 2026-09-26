import { describe, expect, it } from "vitest";
import { parseEnv, envVarRequirements } from "./env";
import { ConfigError } from "@/lib/errors";

describe("parseEnv", () => {
  it("parses a valid environment", () => {
    const env = parseEnv({
      DATABASE_URL: "file:./dev.db",
      NODE_ENV: "development",
    });
    expect(env.DATABASE_URL).toBe("file:./dev.db");
    expect(env.NODE_ENV).toBe("development");
  });

  it("defaults NODE_ENV to development", () => {
    const env = parseEnv({ DATABASE_URL: "file:./dev.db" });
    expect(env.NODE_ENV).toBe("development");
  });

  it("throws ConfigError when a required variable is missing", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
  });

  it("throws ConfigError when a required variable is empty", () => {
    expect(() => parseEnv({ DATABASE_URL: "" })).toThrow(ConfigError);
  });

  it("does not throw when optional variables are absent", () => {
    const env = parseEnv({
      DATABASE_URL: "file:./dev.db",
      AUTH_GOOGLE_ID: undefined,
      AUTH_GITHUB_SECRET: undefined,
    });
    expect(env.AUTH_GOOGLE_ID).toBeUndefined();
    expect(env.AUTH_GITHUB_SECRET).toBeUndefined();
  });

  it("lists missing required variables in the error", () => {
    try {
      parseEnv({ NODE_ENV: "test" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.details.join(" ")).toContain("DATABASE_URL");
      }
    }
  });

  it("throws in production when production-only variables are missing", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: "postgres://x", NODE_ENV: "production" }),
    ).toThrow(ConfigError);
  });

  it("accepts production when production-only variables are present", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "production",
      AUTH_SECRET: "super-secret",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.AUTH_SECRET).toBe("super-secret");
  });

  /**
   * Phase 49 security regression. The production check compared the value to
   * `""`, so `AUTH_SECRET=" "` (a stray space or newline from a secret
   * manager or shell capture) passed validation and became a one-character
   * HMAC key for every session JWT. Anyone who can guess it forges an `sub`
   * claim and Auth.js propagates it to `session.user.id`.
   */
  it("rejects a whitespace-only AUTH_SECRET in production", () => {
    for (const blank of [" ", "   ", "\n", "\t", " \n\t "]) {
      expect(() =>
        parseEnv({
          DATABASE_URL: "postgres://x",
          NODE_ENV: "production",
          AUTH_SECRET: blank,
        }),
      ).toThrow(ConfigError);
    }
  });

  it("trims surrounding whitespace from AUTH_SECRET", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "production",
      AUTH_SECRET: "super-secret\n",
    });
    expect(env.AUTH_SECRET).toBe("super-secret");
  });

  /**
   * Phase 49 hardening. Both flags are read with a strict `=== "1"`, so a
   * stray `"true"` is already inert - but a stray `"1"` in a production
   * deploy would make `/e2e-library` readable by anonymous visitors and
   * switch radio to the fixture backend. Fail closed instead.
   */
  it("fails closed when a test-only flag is set in production", () => {
    for (const key of ["AURORA_E2E_AUTH", "AURORA_E2E_LIVE_PLAYBACK"]) {
      expect(() =>
        parseEnv({
          DATABASE_URL: "postgres://x",
          NODE_ENV: "production",
          AUTH_SECRET: "super-secret",
          [key]: "1",
        }),
      ).toThrow(ConfigError);
    }
  });

  /**
   * The E2E harness serves the production build, so `NODE_ENV=production`
   * cannot mean "real deploy" on its own. The acknowledgment is the
   * discriminator, and it must be exactly "1" — anything else, including a
   * stray "true" that the flags themselves would ignore, stays closed.
   */
  it("admits test-only flags in production only with the explicit acknowledgment", () => {
    for (const ack of [undefined, "", "0", "true", "yes"]) {
      expect(() =>
        parseEnv({
          DATABASE_URL: "postgres://x",
          NODE_ENV: "production",
          AUTH_SECRET: "super-secret",
          AURORA_E2E_AUTH: "1",
          AURORA_E2E_ALLOW_TEST_FLAGS: ack,
        }),
      ).toThrow(ConfigError);
    }

    expect(
      parseEnv({
        DATABASE_URL: "postgres://x",
        NODE_ENV: "production",
        AUTH_SECRET: "super-secret",
        AURORA_E2E_AUTH: "1",
        AURORA_E2E_LIVE_PLAYBACK: "1",
        AURORA_E2E_ALLOW_TEST_FLAGS: "1",
      }),
    ).toMatchObject({ NODE_ENV: "production", AURORA_E2E_AUTH: "1" });
  });

  it("does not require the acknowledgment when no test-only flag is set", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://x",
        NODE_ENV: "production",
        AUTH_SECRET: "super-secret",
      }),
    ).not.toThrow();
  });

  it("allows the test-only flags outside production", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://x",
      NODE_ENV: "test",
      AURORA_E2E_AUTH: "1",
      AURORA_E2E_LIVE_PLAYBACK: "1",
    });
    expect(env.AURORA_E2E_AUTH).toBe("1");
    expect(env.AURORA_E2E_LIVE_PLAYBACK).toBe("1");
  });
});

describe("envVarRequirements", () => {
  it("classifies DATABASE_URL as required", () => {
    expect(envVarRequirements.DATABASE_URL).toBe("required");
  });

  it("classifies AUTH_SECRET as production", () => {
    expect(envVarRequirements.AUTH_SECRET).toBe("production");
  });

  it("classifies OAuth credentials as optional", () => {
    expect(envVarRequirements.AUTH_GOOGLE_ID).toBe("optional");
    expect(envVarRequirements.AUTH_GOOGLE_SECRET).toBe("optional");
    expect(envVarRequirements.AUTH_GITHUB_ID).toBe("optional");
    expect(envVarRequirements.AUTH_GITHUB_SECRET).toBe("optional");
  });

  it("classifies YOUTUBE_API_KEY as optional and server-only", () => {
    expect(envVarRequirements.YOUTUBE_API_KEY).toBe("optional");
    const env = parseEnv({ DATABASE_URL: "file:./dev.db" });
    expect(env.YOUTUBE_API_KEY).toBeUndefined();
    const withKey = parseEnv({
      DATABASE_URL: "file:./dev.db",
      YOUTUBE_API_KEY: "test-key",
    });
    expect(withKey.YOUTUBE_API_KEY).toBe("test-key");
  });

  it("classifies Spotify credentials as optional and server-only", () => {
    expect(envVarRequirements.SPOTIFY_CLIENT_ID).toBe("optional");
    expect(envVarRequirements.SPOTIFY_CLIENT_SECRET).toBe("optional");
    const env = parseEnv({ DATABASE_URL: "file:./dev.db" });
    expect(env.SPOTIFY_CLIENT_ID).toBeUndefined();
    expect(env.SPOTIFY_CLIENT_SECRET).toBeUndefined();
    const withCreds = parseEnv({
      DATABASE_URL: "file:./dev.db",
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
    });
    expect(withCreds.SPOTIFY_CLIENT_ID).toBe("id");
    expect(withCreds.SPOTIFY_CLIENT_SECRET).toBe("secret");
  });

});