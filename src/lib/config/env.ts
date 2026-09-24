import { z } from "zod";
import { ConfigError } from "@/lib/errors";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL must not be empty"),
  AUTH_SECRET: z.string().optional(),
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
} as const satisfies Record<EnvVarName, "required" | "optional" | "production">;

export type EnvVarRequirement = (typeof envVarRequirements)[EnvVarName];

const REQUIRED_VARS = ["DATABASE_URL"] as const satisfies readonly EnvVarName[];

const PRODUCTION_VARS = ["AUTH_SECRET"] as const satisfies readonly EnvVarName[];

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
    const missingProduction = PRODUCTION_VARS.filter(
      (key) => config[key] === undefined || config[key] === "",
    );
    if (missingProduction.length > 0) {
      throw new ConfigError(
        `Missing production-only variables: ${missingProduction.join(", ")}`,
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