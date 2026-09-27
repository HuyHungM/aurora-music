import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@/lib/config/env";
import { buildDatabaseAdapterConfig } from "@/lib/db-tls";
import { PrismaClient } from "@/generated/prisma/client";

export type { Prisma } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const env = getEnv();
  // The one place the database connection is assembled. TLS trust (the
  // provider CA) and the production guard against weakened verification live
  // in `buildDatabaseAdapterConfig`, so the application, the verification
  // scripts and the E2E harness all resolve `DATABASE_URL` identically.
  const config = buildDatabaseAdapterConfig({
    url: env.DATABASE_URL,
    caCertPath: env.AURORA_DATABASE_CA_CERT_PATH,
    nodeEnv: env.NODE_ENV,
  });

  return new PrismaClient({ adapter: new PrismaPg(config) });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
