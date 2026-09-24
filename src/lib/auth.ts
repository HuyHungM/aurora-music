import NextAuth from "next-auth";
import { createAuthOptions } from "@/lib/auth/options";
import { getEnv } from "@/lib/config/env";
import { prisma } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth(
  createAuthOptions({ env: getEnv(), prismaClient: prisma }),
);