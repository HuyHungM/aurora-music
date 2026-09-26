import { z } from "zod";
import { ConfigError } from "@/lib/errors";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL must not be empty"),
  // Trimmed: a secret pasted with a trailing newline (very common from
  // secret managers and shell capture) would otherwise be used verbatim, so
  // the same secret produces different keys in two environments. Trimming
  // also turns a whitespace-only value into "", which the production
  // check below then rejects instead of accepting as a 1-byte HMAC key.
  AUTH_SECRET: z.string().trim().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),
  // Server-only. Enables the YouTube metadata provider (search/lookup).
  // Absent key = YouTube provider stays unregistered; never NEXT_PUBLIC.
  YOUTUBE_API_KEY: z.string().optional(),
  // Server-only Client Credentials for the Spotify catalog provider.
  // Both required to register Spotify; absent = stays unregistered.
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  // Test-only. Registered in the schema so they are classified, documented
  // and enforceable rather than read ad hoc, and so `parseEnv` can fail
  // closed if one is ever set in production - see TEST_ONLY_VARS.
  AURORA_E2E_AUTH: z.string().optional(),
  AURORA_E2E_LIVE_PLAYBACK: z.string().optional(),
  // Explicit acknowledgment, required to run a production-mode server with
  // any TEST_ONLY_VAR set. Deliberately separate from the flags themselves:
  // a stray `AURORA_E2E_AUTH=1` copied into a deploy still fails closed,
  // while the E2E harness - which legitimately runs `next start`, i.e.
  // NODE_ENV=production - states its intent in a variable whose name spells
  // out the hazard. Never set this outside the test harness.
  AURORA_E2E_ALLOW_TEST_FLAGS: z.string().optional(),
  // Phase 52 server-side kill switches, e.g. "radio=0,recommendations=0".
  // Configuration, not a secret. Parsed by @/lib/feature-flags; a malformed
  // entry is a warning, never a boot failure. One variable rather than one per
  // flag, so the whole override set is reviewable on one line.
  AURORA_FEATURE_FLAGS: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export type EnvVarName = keyof EnvConfig;

export const envVarRequirements = {
  NODE_ENV: "optional",
  DATABASE_URL: "required",
  AUTH_SECRET: "production",
  AUTH_GOOGLE_ID: "optional",
  AUTH_GOOGLE_SECRET: "optional",
  AUTH_GITHUB_ID: "optional",
  AUTH_GITHUB_SECRET: "optional",
  YOUTUBE_API_KEY: "optional",
  SPOTIFY_CLIENT_ID: "optional",
  SPOTIFY_CLIENT_SECRET: "optional",
  AURORA_E2E_AUTH: "optional",
  AURORA_E2E_LIVE_PLAYBACK: "optional",
  AURORA_E2E_ALLOW_TEST_FLAGS: "optional",
  AURORA_FEATURE_FLAGS: "optional",
} as const satisfies Record<EnvVarName, "required" | "optional" | "production">;

export type EnvVarRequirement = (typeof envVarRequirements)[EnvVarName];

const REQUIRED_VARS = ["DATABASE_URL"] as const satisfies readonly EnvVarName[];

const PRODUCTION_VARS = ["AUTH_SECRET"] as const satisfies readonly EnvVarName[];

/**
 * Flags that unlock a fixture-only surface and must never reach production.
 *
 * `AURORA_E2E_AUTH` makes `/e2e-library` reachable by anonymous visitors and
 * switches radio to the DB-backed fixture backend; `AURORA_E2E_LIVE_PLAYBACK`
 * enables the live-media probe. They are read with a strict `=== "1"`
 * comparison, so a stray `"true"` is inert - but a stray `"1"` in a
 * production deploy is not. Failing closed here is the same mechanism that
 * already protects `AUTH_SECRET`.
 */
const TEST_ONLY_VARS = [
  "AURORA_E2E_AUTH",
  "AURORA_E2E_LIVE_PLAYBACK",
] as const satisfies readonly EnvVarName[];

export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): EnvConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.path.join("."));
    const missingRequired = REQUIRED_VARS.filter(
      (key) => source[key] === undefined || source[key] === "",
    );
    const details = [
      ...issues,
      ...(missingRequired.length > 0
        ? [`Missing required variables: ${missingRequired.join(", ")}`]
        : []),
    ];
    throw new ConfigError("Invalid environment variables", details);
  }

  const config = result.data;

  if (config.NODE_ENV === "production") {
    // Trim-aware: AUTH_SECRET is trimmed by the schema, so a whitespace-only
    // value arrives here as "" and is treated as missing rather than being
    // accepted as a one-character signing key.
    const missingProduction = PRODUCTION_VARS.filter(
      (key) => (config[key] ?? "").trim() === "",
    );
    if (missingProduction.length > 0) {
      throw new ConfigError(
        `Missing production-only variables: ${missingProduction.join(", ")}`,
      );
    }

    // `NODE_ENV === "production"` is not by itself evidence of a real deploy:
    // the E2E harness serves the production build via `next start` with the
    // fixture flags on, on purpose. So the guard requires an explicit,
    // deliberately-named acknowledgment instead. A stray `AURORA_E2E_AUTH=1`
    // in a deploy - the actual accident worth catching - still fails closed,
    // because nothing sets the acknowledgment for it.
    const leakedTestFlags = TEST_ONLY_VARS.filter(
      (key) => (config[key] ?? "") !== "",
    );
    if (
      leakedTestFlags.length > 0 &&
      (config.AURORA_E2E_ALLOW_TEST_FLAGS ?? "") !== "1"
    ) {
      throw new ConfigError(
        `Test-only variables require AURORA_E2E_ALLOW_TEST_FLAGS=1 and must never be set in a real deployment: ${leakedTestFlags.join(", ")}`,
      );
    }
  }

  return config;
}

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (!cachedEnv) {
    cachedEnv = parseEnv();
  }
  return cachedEnv;
}