import { describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  buildDatabaseAdapterConfig,
  DATABASE_CA_CERT_PATH_VAR,
  type PgConnectionConfig,
} from "./db-tls";
import { ConfigError } from "./errors";

const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";

/**
 * Resolves the SSL configuration exactly the way the Prisma driver adapter
 * does: `@prisma/adapter-pg` hands our object to `new pg.Pool(config)`, which
 * constructs a `Client` and therefore a `ConnectionParameters`. Reading the
 * resolved value (rather than the value we wrote) is what catches the merge
 * trap: `pg` merges the *parsed connection string over* the config object.
 */
function resolvedSsl(config: PgConnectionConfig): unknown {
  const client = new Client(config) as unknown as {
    connectionParameters: { ssl: unknown };
  };
  return client.connectionParameters.ssl;
}

/** A CA file that is present and non-empty. */
const readPem = () => PEM;

describe("buildDatabaseAdapterConfig", () => {
  it("leaves the connection string untouched when no CA is configured", () => {
    const url = "postgresql://u:p@db.internal:5432/aurora?sslmode=verify-full";
    expect(
      buildDatabaseAdapterConfig({ url, nodeEnv: "production" }),
    ).toEqual({ connectionString: url });
  });

  it("attaches the CA and keeps verification enabled", () => {
    const config = buildDatabaseAdapterConfig({
      url: "postgresql://u:p@db.internal:5432/aurora?sslmode=require",
      caCertPath: "/etc/aurora/postgres-ca.pem",
      nodeEnv: "production",
      readFile: readPem,
    });

    expect(config.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it("removes sslmode so the explicit CA cannot be dropped by pg's merge", () => {
    const config = buildDatabaseAdapterConfig({
      url: "postgresql://u:p@db.internal:5432/aurora?sslmode=require&application_name=aurora",
      caCertPath: "/etc/aurora/postgres-ca.pem",
      nodeEnv: "production",
      readFile: readPem,
    });

    // The SSL parameter is gone; unrelated parameters survive.
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).toContain("application_name=aurora");

    // And the resolved value really carries the CA + verification.
    expect(resolvedSsl(config)).toMatchObject({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  it("documents pg's merge trap: sslmode without stripping overrides ssl", () => {
    // Characterization of the dependency, not of our code. If this ever stops
    // being true, `stripSslParams` could be simplified - the test would fail
    // and force that decision rather than letting a silent CA loss ship.
    const resolved = resolvedSsl({
      connectionString: "postgresql://u:p@db.internal:5432/aurora?sslmode=require",
      ssl: { ca: PEM },
    });
    expect(resolved).not.toMatchObject({ ca: PEM });
  });

  it("preserves credentials when it rewrites the URL", () => {
    const config = buildDatabaseAdapterConfig({
      url: "postgresql://user:p%40ss@db.internal:5432/aurora?sslmode=require",
      caCertPath: "/etc/aurora/postgres-ca.pem",
      nodeEnv: "production",
      readFile: readPem,
    });
    const rewritten = new URL(config.connectionString);
    expect(rewritten.username).toBe("user");
    expect(rewritten.password).toBe("p%40ss");
    expect(rewritten.hostname).toBe("db.internal");
  });

  it("rejects the disabled-certificate modes in production", () => {
    for (const url of [
      "postgresql://u:p@db.internal:5432/aurora?sslmode=disable",
      "postgresql://u:p@db.internal:5432/aurora?sslmode=no-verify",
      "postgresql://u:p@db.internal:5432/aurora?ssl=false",
      "postgresql://u:p@db.internal:5432/aurora?uselibpqcompat=true&sslmode=require",
      "postgresql://u:p@db.internal:5432/aurora?uselibpqcompat=1&sslmode=verify-ca",
    ]) {
      expect(() =>
        buildDatabaseAdapterConfig({ url, nodeEnv: "production" }),
      ).toThrow(ConfigError);
    }
  });

  it("never leaks the connection string in the guard's error", () => {
    const url = "postgresql://u:sup3r-secret@db.internal/aurora?sslmode=disable";
    try {
      buildDatabaseAdapterConfig({ url, nodeEnv: "production" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(JSON.stringify((error as ConfigError).details)).not.toContain(
        "sup3r-secret",
      );
    }
  });

  it("allows the strict modes in production", () => {
    for (const url of [
      "postgresql://u:p@db.internal:5432/aurora?sslmode=require",
      "postgresql://u:p@db.internal:5432/aurora?sslmode=verify-full",
      "postgresql://u:p@db.internal:5432/aurora",
    ]) {
      expect(() =>
        buildDatabaseAdapterConfig({ url, nodeEnv: "production" }),
      ).not.toThrow();
    }
  });

  it("does not enforce the production guard outside production", () => {
    expect(() =>
      buildDatabaseAdapterConfig({
        url: "postgresql://u:p@localhost:5432/aurora?sslmode=disable",
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });

  it("fails with a named variable when the CA file is missing", () => {
    try {
      buildDatabaseAdapterConfig({
        url: "postgresql://u:p@db.internal:5432/aurora?sslmode=require",
        caCertPath: "/etc/aurora/missing.pem",
        nodeEnv: "production",
        readFile: () => {
          throw new Error("ENOENT");
        },
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain(DATABASE_CA_CERT_PATH_VAR);
      expect((error as ConfigError).message).not.toContain("/etc/aurora");
    }
  });

  it("rejects an empty CA file", () => {
    expect(() =>
      buildDatabaseAdapterConfig({
        url: "postgresql://u:p@db.internal:5432/aurora?sslmode=require",
        caCertPath: "/etc/aurora/empty.pem",
        nodeEnv: "production",
        readFile: () => "  \n",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-postgres scheme with only the scheme in the message", () => {
    try {
      buildDatabaseAdapterConfig({
        url: "mysql://u:secret@db.internal/aurora",
        nodeEnv: "development",
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("mysql:");
      expect((error as ConfigError).message).not.toContain("secret");
    }
  });
});
