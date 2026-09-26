/**
 * Feature flags and server-side kill switches (Phase 52, RULE 48).
 *
 * Scope, deliberately small. There is no flag platform here, no per-user
 * targeting, no percentage rollout, no remote config service, and no flag
 * store. Each flag is a compile-time constant with a documented owner, a
 * default, and exactly one override mechanism: a single environment variable.
 *
 * That is enough for the thing that actually matters, which is the ability to
 * turn a high-risk feature off in production without a code change and without
 * a deploy. Every flag below gates a feature that either fans out into paid
 * third-party quota (radio, recommendations) or writes durable user state
 * (playlist sharing, keep-listening), so each is a real thing to want to stop.
 *
 * Override syntax, in one variable:
 *
 *   AURORA_FEATURE_FLAGS="radio=0,recommendations=0"
 *
 * One variable rather than seven, because seven boolean environment variables
 * is a configuration surface nobody can review at a glance. Unknown names and
 * malformed pairs are ignored - a typo degrades to the compiled default rather
 * than throwing at boot, and `parseFeatureFlagOverrides` reports what it did
 * not understand so the mistake is visible in a log instead of silent.
 *
 * `0`, `false`, `off`, `no` and `disabled` turn a flag off; `1`, `true`, `on`,
 * `yes` and `enabled` turn it on. Anything else is ignored.
 *
 * The value is configuration, never a secret: it is not a credential, it is not
 * logged at info level, and only the flag *names* it mentions are ever logged.
 */

/** Every flag Aurora ships, and nothing else. */
export const FEATURE_FLAGS = {
  /**
   * Track/artist/discovery radio and batch extension. Fans out into repeated
   * provider generation, so it is the most expensive feature to leave running
   * against a degraded provider.
   */
  radio: {
    defaultEnabled: true,
    description: "Radio generation: track, artist and discovery stations.",
    owner: "playback",
    risk: "high",
  },
  /**
   * Personalised recommendations on Home, the track page and end-of-queue
   * continuation. Reads listening history and provider metadata on every call.
   */
  recommendations: {
    defaultEnabled: true,
    description: "Personalised recommendation sections and continuation.",
    owner: "library",
    risk: "high",
  },
  /**
   * The "Keep listening" preference: generic end-of-queue continuation when no
   * radio station is active. Writes a durable per-user setting.
   */
  infiniteListening: {
    defaultEnabled: true,
    description: "Keep-listening continuation at the end of the queue.",
    owner: "playback",
    risk: "medium",
  },
  /**
   * Public playlist share links. Creates durable, publicly reachable state
   * reachable by anyone holding the token, so it is the flag most worth being
   * able to stop without a deploy.
   */
  playlistSharing: {
    defaultEnabled: true,
    description: "Public playlist share links and the public share route.",
    owner: "library",
    risk: "high",
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

export type FeatureFlagRisk = "low" | "medium" | "high";

export interface FeatureFlagDefinition {
  /** Compiled default. The shipped behaviour. */
  readonly defaultEnabled: boolean;
  /** What turning this off actually stops. */
  readonly description: string;
  /** Team or surface accountable for the flag. */
  readonly owner: string;
  /** How much damage an unintended state causes. */
  readonly risk: FeatureFlagRisk;
}

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as FeatureFlagName[];

export function isFeatureFlagName(value: unknown): value is FeatureFlagName {
  return (
    typeof value === "string" &&
    (FEATURE_FLAG_NAMES as string[]).includes(value)
  );
}

const FALSEY = new Set(["0", "false", "off", "no", "disabled"]);
const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);

export type FeatureFlagOverrides = Partial<Record<FeatureFlagName, boolean>>;

export interface ParsedOverrides {
  readonly overrides: FeatureFlagOverrides;
  /** Entries that named no known flag. Logged so a typo is not silent. */
  readonly unknownNames: string[];
  /** Entries whose value was neither truthy nor falsey. */
  readonly malformed: string[];
}

/** Parse the `AURORA_FEATURE_FLAGS` value. Total: never throws. */
export function parseFeatureFlagOverrides(
  raw: string | null | undefined,
): ParsedOverrides {
  const overrides: FeatureFlagOverrides = {};
  const unknownNames: string[] = [];
  const malformed: string[] = [];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { overrides, unknownNames, malformed };
  }
  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (entry.length === 0) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      malformed.push(entry);
      continue;
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim().toLowerCase();
    if (!isFeatureFlagName(name)) {
      unknownNames.push(name);
      continue;
    }
    if (FALSEY.has(value)) {
      overrides[name] = false;
    } else if (TRUTHY.has(value)) {
      overrides[name] = true;
    } else {
      // The whole entry, not just the name: `radio=maybe` and `radio` are
      // different mistakes, and the offending value is the useful half of the
      // diagnostic. Consistent with the not-a-pair branch above.
      malformed.push(entry);
    }
  }
  return { overrides, unknownNames, malformed };
}

export type FeatureFlagSource = string | null | undefined;

/**
 * The effective value of a flag.
 *
 * Precedence: explicit argument, then `AURORA_FEATURE_FLAGS`, then the compiled
 * default. The argument exists so a test - or a future request-scoped decision -
 * can evaluate a flag without mutating `process.env`.
 */
export function isFeatureEnabled(
  name: FeatureFlagName,
  source: FeatureFlagSource = undefined,
): boolean {
  const raw = source !== undefined ? source : readEnvValue();
  const { overrides } = parseFeatureFlagOverrides(raw);
  const override = overrides[name];
  if (typeof override === "boolean") {
    return override;
  }
  return FEATURE_FLAGS[name].defaultEnabled;
}

/** Every flag's effective value, for diagnostics and the health surface. */
export function featureFlagSnapshot(
  source: FeatureFlagSource = undefined,
): Record<FeatureFlagName, boolean> {
  const entries = FEATURE_FLAG_NAMES.map(
    (name) => [name, isFeatureEnabled(name, source)] as const,
  );
  return Object.fromEntries(entries) as Record<FeatureFlagName, boolean>;
}

function readEnvValue(): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env?.AURORA_FEATURE_FLAGS;
}

/**
 * Called once at boot by the configuration layer. A malformed value is a
 * warning, never a fatal error: a typo in a kill switch must not stop the
 * process from serving traffic.
 */
export function reportFeatureFlagProblems(): void {
  const { unknownNames, malformed } = parseFeatureFlagOverrides(readEnvValue());
  if (unknownNames.length === 0 && malformed.length === 0) {
    return;
  }
  // Imported lazily and structurally so this module stays usable from a plain
  // unit test with no logger installed.
  void import("@/lib/diagnostics/logger")
    .then(({ logger }) => {
      logger.warn("Feature flag configuration was not understood", {
        event: "feature_flag_config_invalid",
        unknownNames: unknownNames.join(","),
        malformed: malformed.join(","),
      });
    })
    .catch(() => {
      // Diagnostics must never break the application.
    });
}
