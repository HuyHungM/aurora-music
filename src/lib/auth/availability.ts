import type { EnvConfig } from "@/lib/config/env";

export interface AuthAvailability {
  google: boolean;
  github: boolean;
  configured: boolean;
}

type OAuthEnv = Partial<
  Pick<
    EnvConfig,
    "AUTH_GOOGLE_ID" | "AUTH_GOOGLE_SECRET" | "AUTH_GITHUB_ID" | "AUTH_GITHUB_SECRET"
  >
>;

export function getAuthAvailability(env: OAuthEnv): AuthAvailability {
  const google = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const github = Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET);
  return { google, github, configured: google || github };
}