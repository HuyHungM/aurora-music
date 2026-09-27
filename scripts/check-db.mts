/**
 * Read-only database smoke test for the connection AND the Auth.js adapter
 * path. Unlike `db:verify` (which upserts a probe track), this script only
 * reads: `SELECT 1`, then the exact query Auth.js runs in `getUserByAccount`
 * - `prisma.account.findUnique()` on the `(provider, providerAccountId)`
 * compound key - against a sentinel pair that no real account can have, so it
 * returns `null` and writes nothing.
 *
 * That second query is the point. The production failure occurred inside
 * `getUserByAccount()`, not on a bare `SELECT 1`, so a smoke test that stops at
 * `SELECT 1` would not prove the failing path. Running it against the database
 * is safe: the sentinel values are literals in this file and the query is a
 * lookup by a unique key.
 *
 * TLS comes from the same builder the application uses, so a configured
 * provider CA (`AURORA_DATABASE_CA_CERT_PATH`) is honoured here too. Nothing
 * prints the connection string, a credential, or certificate contents.
 */

import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");
const { buildDatabaseAdapterConfig, DATABASE_CA_CERT_PATH_VAR } = await import(
  "../src/lib/db-tls"
);

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to check the database");
}

const nodeEnv = process.env.NODE_ENV;
const db = new PrismaClient({
  adapter: new PrismaPg(
    buildDatabaseAdapterConfig({
      url,
      caCertPath: process.env[DATABASE_CA_CERT_PATH_VAR],
      nodeEnv:
        nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
    }),
  ),
});

try {
  await db.$queryRaw`SELECT 1`;
  console.log("SELECT 1: ok");

  const account = await db.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: "__aurora_smoke__",
        providerAccountId: "__aurora_smoke__",
      },
    },
    select: { id: true },
  });
  console.log(
    `account.findUnique: ok (${account === null ? "no row" : "row present"})`,
  );
} finally {
  await db.$disconnect();
}
