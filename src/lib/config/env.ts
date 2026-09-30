import { z } from "zod";
import { ConfigError } from "@/lib/errors";
import { parsePublicOrigin, PUBLIC_ORIGIN_ERROR } from "@/lib/config/public-origin";

/**
 * The deployment's public origin, normalized to a bare `URL#origin` string.
 *
 * Declared rather than derived, because the public origin is a fact about the
 * deployment that the application cannot observe: Next.js builds `request.url`
 * from the port the process was booted with, and every proxy header that could
 * stand in for the public hostname is a header a misconfigured proxy gets
 * wrong. See `public-origin.ts` for the failure this prevents.
 *
 * Validation runs at the domain boundary, so a typo fails the boot with a
 * named rule instead of failing the first sign-in with `redirect_uri_mismatch`.
 * The `.transform` normalizes once, at parse time, which is what lets every
 * consumer treat the value as an origin and lets the consistency check in
 * `parseEnv` compare two spellings of the same origin.
 */
const publicOriginSchema = z
  .string()
  .trim()
  .optional()
  .superRefine((value, ctx) => {
    if (value !== undefined && parsePublicOrigin(value) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PUBLIC_ORIGIN_ERROR });
    }
  })
  .transform((value) =>
    value === undefined ? undefined : (parsePublicOrigin(value) as string),
  )
  // The outer `.optional()` is load-bearing for the inferred type, not for the
  // value: a `ZodEffects` wrapper makes its key REQUIRED in `EnvConfig`, so
  // every `EnvConfig` literal in the tree would have had to spell this field
  // out. Re-wrapping keeps it optional, like every other optional variable,
  // and still short-circuits `undefined` before the transform above runs.
  .optional();

/**
 * Optional forward-proxy URL for the YouTube InnerTube egress. Validated at
 * the domain boundary like `AURORA_PUBLIC_URL`, so a malformed value fails the
 * boot with a named rule instead of surfacing as an opaque tunnel error on the
 * first playback. Only absolute `http(s)` URLs are accepted (credentials
 * `user:password@` allowed); `socks*` is refused here because the tunnel
 * implements HTTP CONNECT only. An empty string means "unset".
 */
export const EGRESS_PROXY_ERROR =
  "AURORA_YOUTUBE_EGRESS_PROXY must be an absolute http(s) proxy URL";
export const EGRESS_PROXY_PRIMARY_ERROR =
  "AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY must be an absolute http(s) proxy URL";
export const EGRESS_PROXY_SECONDARY_ERROR =
  "AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY must be an absolute http(s) proxy URL";

function egressProxySchemaFor(message: string) {
  return z
    .string()
    .trim()
    .optional()
    .superRefine((value, ctx) => {
      if (value !== undefined && value !== "" && parseHttpProxyUrl(value) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    })
    .optional();
}

const egressProxySchema = egressProxySchemaFor(EGRESS_PROXY_ERROR);

function parseHttpProxyUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? value : null;
}

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
  // The public origin Auth.js builds every absolute URL from - the OAuth
  // `redirect_uri` above all. Optional: absent, the auth route keeps deriving
  // the origin from the request headers, which is what LAN and `localhost`
  // development need. Set it in any deployment that has a public hostname.
  AURORA_PUBLIC_URL: publicOriginSchema,
  // Server-only. Absolute path to a PEM file holding the PostgreSQL provider's
  // CA certificate(s), needed when the server chain ends at a private CA the
  // runtime's system trust store does not contain - the production
  // `self-signed certificate in certificate chain` failure. Optional: absent,
  // the connection is left exactly as `DATABASE_URL` wrote it and `pg` verifies
  // against the system trust store. Never carries a private key.
  AURORA_DATABASE_CA_CERT_PATH: z.string().optional(),
  // Server-only, filesystem-less alternative to the path above: the same
  // public CA certificate(s) as inline PEM text, for a serverless runtime with
  // no readable file (Vercel Functions). Set as a hosting-provider environment
  // variable; never carries a private key, and never weakens verification.
  // Takes precedence over the path when both are set.
  AURORA_DATABASE_CA_CERT: z.string().optional(),
  // Server-only. Enables the YouTube metadata provider (search/lookup).
  // Absent key = YouTube provider stays unregistered; never NEXT_PUBLIC.
  YOUTUBE_API_KEY: z.string().optional(),
  // Server-only, optional. Absolute http(s) URL of a forward proxy the shared
  // YouTube InnerTube session sends through, for when this runtime's egress is
  // treated as a datacenter and YouTube answers the player request with
  // `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot") and no streaming
  // data. Covers discovery and playback (one shared session); nothing else is
  // proxied. May carry credentials; never logged, never NEXT_PUBLIC.
  // Unset or empty = direct egress, exactly as before.
  AURORA_YOUTUBE_EGRESS_PROXY: egressProxySchema,
  // Temporary dual-egress failover for playback resolution. The primary is
  // tried first; the secondary is used only when the primary returns a
  // retryable InnerTube failure. Values may carry credentials; never logged,
  // never NEXT_PUBLIC. Unset or empty disables that leg of the failover.
  AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY: egressProxySchemaFor(
    EGRESS_PROXY_PRIMARY_ERROR,
  ),
  AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY: egressProxySchemaFor(
    EGRESS_PROXY_SECONDARY_ERROR,
  ),
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
  AURORA_PUBLIC_URL: "optional",
  AURORA_DATABASE_CA_CERT_PATH: "optional",
  AURORA_DATABASE_CA_CERT: "optional",
  YOUTUBE_API_KEY: "optional",
  SPOTIFY_CLIENT_ID: "optional",
  SPOTIFY_CLIENT_SECRET: "optional",
  AURORA_YOUTUBE_EGRESS_PROXY: "optional",
  AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY: "optional",
  AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY: "optional",
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

  // Auth.js reads `AUTH_URL` (and its v4-compatible `NEXTAUTH_URL`) straight
  // from `process.env`, bypassing this schema, and prefers it over the request
  // headers for every URL it emits. So the two can disagree: an operator who
  // sets `AURORA_PUBLIC_URL` correctly and leaves a stale `AUTH_URL` pointing
  // at the internal origin gets a half-fixed deployment - the OAuth
  // `redirect_uri` correct, the built-in sign-in page still pointing at
  // `http://127.0.0.1:24584` - which is harder to diagnose than either value
  // on its own. Fail at boot, and name both values.
  //
  // Only checked when both are present, and compared after normalization so
  // `https://host` and `https://host/` are recognised as the same declaration
  // rather than as a disagreement.
  const declaredAuthUrl = source.AUTH_URL ?? source.NEXTAUTH_URL;
  if (config.AURORA_PUBLIC_URL && declaredAuthUrl) {
    const normalized = parsePublicOrigin(declaredAuthUrl);
    if (normalized !== config.AURORA_PUBLIC_URL) {
      throw new ConfigError(
        "AURORA_PUBLIC_URL and AUTH_URL disagree; the deployment must declare one public origin",
        [
          `AURORA_PUBLIC_URL: ${config.AURORA_PUBLIC_URL}`,
          `AUTH_URL: ${normalized ?? "not an origin (see AURORA_PUBLIC_URL rules)"}`,
        ],
      );
    }
  }

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