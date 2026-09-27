import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@/lib/config/env";
import { PrismaClient } from "@/generated/prisma/client";

export type { Prisma } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = getEnv().DATABASE_URL;
  let adapter;

  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    adapter = new PrismaPg({ connectionString: url });
  } else {
    // Only the scheme goes into the message. The whole connection string
    // carries the password, and this Error is thrown at boot, where it lands
    // in stderr and in any crash capture — `docs/security.md` forbids logging
    // secret values. The scheme is the part that is actually wrong here.
    const scheme = url.slice(0, url.indexOf(":") + 1) || "(none)";
    throw new Error(
      `Unsupported DATABASE_URL scheme: ${scheme} ` +
        `Expected "postgresql://" or "postgres://"`,
    );
  }

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
