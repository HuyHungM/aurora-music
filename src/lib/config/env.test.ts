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