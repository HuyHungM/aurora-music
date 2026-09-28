import { readFileSync } from "node:fs";
import { ConfigError } from "./errors";

/**
 * Name of the optional variable that points at a PEM file holding the
 * PostgreSQL provider's CA certificate(s).
 *
 * The production failure this exists for is
 * `self-signed certificate in certificate chain`: the runtime verifies the
 * server chain against its own system trust store, and a provider that signs
 * with its own private CA is not in that store, so verification fails. The
 * supported fix is to hand the runtime the provider's CA — never to turn
 * verification off. `sslrootcert=` in `DATABASE_URL` also works (pg reads it),
 * but a named path is easier to provision and review, and it keeps a path out
 * of a value that is otherwise all connection parameters.
 *
 * Only the PUBLIC certificate belongs in this file: a CA bundle carries no
 * private key, and the file is never echoed back — the loader reports the
 * variable name, not the path or the contents.
 */
export const DATABASE_CA_CERT_PATH_VAR = "AURORA_DATABASE_CA_CERT_PATH";

/**
 * Name of the optional variable that carries the PEM CA **inline**, as text.
 *
 * The path variable above is a Node-host mechanism: it reads a file from disk.
 * Cloudflare Workers (the OpenNext target) and any other filesystem-less
 * runtime have no disk, so a provider with a private CA (Aiven's per-project
 * CA is the known case) needs the same trust anchor supplied as a value. The
 * CA is a **public** certificate — it carries no private key — so a Worker
 * secret/binding is a safe place for it.
 *
 * This is the Workers-compatible half of the pair, not a replacement: keep the
 * file path on a Node host (it is easier to provision and review) and the
 * inline value where there is no filesystem. Either way, TLS keeps certificate
 * and hostname verification ON — supplying a CA never weakens a connection.
 */
export const DATABASE_CA_CERT_VAR = "AURORA_DATABASE_CA_CERT";

export type DatabaseNodeEnv = "development" | "test" | "production";

/** The subset of `pg.PoolConfig` this module builds. */
export interface PgConnectionConfig {
  connectionString: string;
  ssl?: boolean | { ca?: string; rejectUnauthorized?: boolean };
}

export interface BuildDatabaseConfigInput {
  url: string;
  caCertPath?: string;
  /** Inline PEM certificate(s). Takes precedence over `caCertPath` when set. */
  caCert?: string;
  nodeEnv: DatabaseNodeEnv;
  /** Injected for tests. Defaults to reading the path as UTF-8 text. */
  readFile?: (path: string) => string;
}

/**
 * Resolves the trust anchor from the inline value or the file path.
 *
 * Inline wins when both are present: it is the value the operator placed
 * directly in this environment, and on a filesystem-less runtime the path is
 * meaningless anyway. An inline value that is not a PEM certificate fails
 * closed with the variable's name, so a path pasted into the wrong variable
 * (or a truncated secret) is a named configuration error rather than a
 * connection that silently ignores the CA.
 */
function resolveCaCertificate(input: {
  caCert?: string;
  caCertPath?: string;
  readFile: (path: string) => string;
}): string | undefined {
  const inline = input.caCert?.trim();
  if (inline !== undefined && inline !== "") {
    if (!inline.includes("BEGIN CERTIFICATE")) {
      throw new ConfigError(
        `The value of ${DATABASE_CA_CERT_VAR} is not a PEM certificate`,
        [
          `Expected PEM text containing "BEGIN CERTIFICATE".`,
          `Use ${DATABASE_CA_CERT_PATH_VAR} instead when pointing at a file.`,
        ],
      );
    }
    return inline;
  }

  if (input.caCertPath === undefined || input.caCertPath === "") {
    return undefined;
  }

  let ca: string;
  try {
    ca = input.readFile(input.caCertPath).trim();
  } catch {
    // The path is not a secret, but the failure is reported as a configuration
    // error and never as a raw filesystem error, which could carry more.
    throw new ConfigError(
      `Could not read the CA certificate file named by ${DATABASE_CA_CERT_PATH_VAR}`,
    );
  }
  if (ca === "") {
    throw new ConfigError(
      `The CA certificate file named by ${DATABASE_CA_CERT_PATH_VAR} is empty`,
    );
  }
  return ca;
}

/**
 * Query parameters that make `pg` (via `pg-connection-string`) resolve an SSL
 * configuration of its own. They must be removed from the connection string
 * whenever this module supplies `ssl` explicitly, because
 * `pg`'s `ConnectionParameters` merges the *parsed connection string over* the
 * caller's config object — so `?sslmode=require` would silently overwrite an
 * `ssl: { ca }` and drop the CA again. See `db-tls.test.ts`, which asserts the
 * resolved value rather than trusting this comment.
 */
const SSL_QUERY_PARAMS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslidentity",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
] as const;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Returns the name of an insecure TLS setting, or `null` when the URL does not
 * weaken verification. Only the *names* of the settings are returned; values
 * are not (they are not secrets, but the message stays stable and reviewable).
 */
function insecureTlsSetting(parsed: URL): string | null {
  const param = (key: string): string | undefined =>
    parsed.searchParams.get(key)?.trim().toLowerCase() ?? undefined;

  const sslmode = param("sslmode");
  if (sslmode === "disable") {
    return "sslmode=disable";
  }
  if (sslmode === "no-verify") {
    return "sslmode=no-verify";
  }

  const ssl = param("ssl");
  if (ssl === "false" || ssl === "0") {
    return "ssl disabled";
  }

  // `uselibpqcompat=true` makes `sslmode=require`/`verify-ca` adopt libpq
  // semantics, which do NOT verify the certificate. `verify-full` keeps
  // verification, so only flag the modes that get downgraded.
  const libpqCompat = param("uselibpqcompat");
  if (
    (libpqCompat === "true" || libpqCompat === "1") &&
    (sslmode === "require" || sslmode === "verify-ca")
  ) {
    return "uselibpqcompat=true with a downgraded sslmode";
  }

  return null;
}

function stripSslParams(parsed: URL): string {
  for (const key of SSL_QUERY_PARAMS) {
    parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/**
 * Builds the `pg.PoolConfig` the Prisma driver adapter is constructed from.
 *
 * Provider-agnostic on purpose: it takes the connection string as data and the
 * CA as an explicit path, so it is unit-testable without a database and can be
 * reused by the application and by the verification scripts alike.
 */
export function buildDatabaseAdapterConfig(
  input: BuildDatabaseConfigInput,
): PgConnectionConfig {
  const { url, caCertPath, caCert, nodeEnv } = input;
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    // Only the scheme goes into the message: the whole connection string
    // carries the password. Same rule as `db.ts` and the verification scripts.
    const scheme = url.slice(0, url.indexOf(":") + 1) || "(none)";
    throw new ConfigError(
      `Unsupported DATABASE_URL scheme: ${scheme} ` +
        `Expected "postgresql://" or "postgres://"`,
    );
  }

  const parsed = parseUrl(url);

  if (nodeEnv === "production" && parsed !== null) {
    const insecure = insecureTlsSetting(parsed);
    if (insecure !== null) {
      throw new ConfigError(
        `Refusing an insecure DATABASE_URL TLS configuration in production (${insecure})`,
        [
          "Database TLS must keep certificate and hostname verification enabled.",
          `Supply the provider CA with ${DATABASE_CA_CERT_PATH_VAR} instead of weakening the connection.`,
        ],
      );
    }
  }

  const ca = resolveCaCertificate({ caCert, caCertPath, readFile });
  if (ca === undefined) {
    // No explicit trust anchor: leave the connection string exactly as the
    // operator wrote it, so an existing deployment is unchanged and `pg` keeps
    // its own (system-trust-store) verification.
    return { connectionString: url };
  }

  return {
    connectionString: parsed === null ? url : stripSslParams(parsed),
    ssl: { ca, rejectUnauthorized: true },
  };
}
