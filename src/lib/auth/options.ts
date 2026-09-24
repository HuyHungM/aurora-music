import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import type { NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { EnvConfig } from "@/lib/config/env";
import type { PrismaClient } from "@/generated/prisma/client";

type OAuthEnv = Pick<
  EnvConfig,
  "AUTH_GOOGLE_ID" | "AUTH_GOOGLE_SECRET" | "AUTH_GITHUB_ID" | "AUTH_GITHUB_SECRET"
>;

export function buildProviders(env: OAuthEnv): Provider[] {
  const providers: Provider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: env.AUTH_GOOGLE_ID,
        clientSecret: env.AUTH_GOOGLE_SECRET,
      }),
    );
  }
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(
      GitHub({
        clientId: env.AUTH_GITHUB_ID,
        clientSecret: env.AUTH_GITHUB_SECRET,
      }),
    );
  }
  return providers;
}

export interface AuthOptionsInput {
  env: EnvConfig;
  prismaClient: PrismaClient;
}

export function createAuthOptions(input: AuthOptionsInput): NextAuthConfig {
  const { env } = input;
  return {
    adapter: PrismaAdapter(input.prismaClient),
    providers: buildProviders(env),
    session: { strategy: "jwt" },
    trustHost: true,
    secret: env.AUTH_SECRET,
    callbacks: {
      session({ session, token }) {
        if (session.user && token.sub) {
          session.user.id = token.sub;
        }
        return session;
      },
    },
  };
}