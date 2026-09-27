import NextAuth from "next-auth";
import { createAuthOptions } from "@/lib/auth/options";
import { getEnv } from "@/lib/config/env";
import { prisma } from "@/lib/db";

const env = getEnv();

/**
 * Hand Auth.js the declared public origin, through its own configuration
 * channel.
 *
 * `toBrowserOrigin()` in the auth route fixes the OAuth `redirect_uri` by
 * rebuilding the request on the right origin, which is the path a real
 * sign-in takes. But Auth.js has a SECOND, independent source for absolute
 * URLs: `createActionURL()` reads `AUTH_URL` and, absent it, falls back to the
 * same inbound Host header. That fallback is what builds the `action` and
 * `callbackUrl` on Auth.js's built-in `/api/auth/signin` page - a page Aurora
 * does not use, but does serve. Leaving it on the header would mean a
 * half-fixed deployment: the OAuth flow correct, the built-in sign-in page
 * still handing browsers a `127.0.0.1:24584` link.
 *
 * `AUTH_URL` rather than a new Auth.js option, because it is Auth.js's
 * documented variable and it is the one `setEnvDefaults()` honours before
 * `NextAuth()` is called. `parseEnv()` has already proven any operator-
 * supplied `AUTH_URL`/`NEXTAUTH_URL` agrees with `AURORA_PUBLIC_URL`, so
 * overwriting is not a way to hide a disagreement - it is how the one
 * declaration reaches both code paths.
 *
 * Assignment rather than deletion when the deployment declares nothing: an
 * operator running Aurora behind a different proxy may legitimately set
 * `AUTH_URL` themselves, and that is Auth.js's own supported mechanism.
 */
if (env.AURORA_PUBLIC_URL) {
  process.env.AUTH_URL = env.AURORA_PUBLIC_URL;
}

export const { handlers, auth, signIn, signOut } = NextAuth(
  createAuthOptions({ env, prismaClient: prisma }),
);
