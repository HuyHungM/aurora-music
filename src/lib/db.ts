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
    throw new Error(
      `Unsupported DATABASE_URL scheme: ${url}. ` +
        `Expected "postgresql://" or "postgres://"`,
    );
  }

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
