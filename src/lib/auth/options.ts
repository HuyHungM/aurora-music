import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
// `customFetch` is re-exported by `next-auth`, but importing it from `@auth/core`
// directly keeps this module free of `next/server`, which the Node-environment
// unit tests cannot resolve. It is the same symbol `next-auth` re-exports.
import { customFetch } from "@auth/core";
import type { Provider } from "next-auth/providers";
import type { NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { EnvConfig } from "@/lib/config/env";
import type { PrismaClient } from "@/generated/prisma/client";

type OAuthEnv = Pick<
  EnvConfig,
  "AUTH_GOOGLE_ID" | "AUTH_GOOGLE_SECRET" | "AUTH_GITHUB_ID" | "AUTH_GITHUB_SECRET"
>;

/** The one discovery field this wrapper removes, on Google's response only. */
const GOOGLE_ISS_SUPPORT_FLAG = "authorization_response_iss_parameter_supported";

/** The pathname Google serves its OpenID Provider metadata from. */
const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * Stop requiring the RFC 9207 `iss` authorization-response parameter from
 * Google.
 *
 * WHY. Google's discovery document advertises
 * `authorization_response_iss_parameter_supported: true`, but its
 * authorization responses do not reliably include the `iss` query parameter.
 * `oauth4webapi` (>= 3.3.0, as pulled in by `@auth/core`) then rejects an
 * otherwise-valid callback with `CallbackRouteError: response parameter "iss"
 * (issuer) missing`, so sign-in fails intermittently with no code defect on
 * either redirect. The app is not dropping the parameter: the auth route
 * rebuilds the request on the public origin with `new NextRequest(new URL(...),
 * request)`, which preserves the full query string (verified), and a reverse
 * proxy passes query parameters through. The parameter is simply absent on
 * Google's redirect when this fires.
 *
 * WHAT IT DOES. Google's discovery response is intercepted and that single
 * boolean is deleted, so `oauth4webapi` no longer *requires* `iss`. This is a
 * targeted tolerance, not a blanket disable: when Google does send `iss`,
 * oauth4webapi still compares it against the discovered issuer, and the OIDC
 * **id_token** `iss` claim is still validated against that issuer during the
 * code exchange. No other discovery field (jwks_uri, token/userinfo endpoints,
 * signing algorithms, issuer) is touched, and only the Google provider uses
 * this fetch. `state` and PKCE checks are unaffected.
 *
 * Scope: the discovery request is the only outbound call whose URL ends in the
 * OpenID configuration pathname; every other request (token, userinfo) is
 * forwarded untouched.
 */
export const googleDiscoveryFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);

  const url = input instanceof Request ? input.url : String(input);
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return response;
  }
  if (!response.ok || pathname !== OIDC_DISCOVERY_PATH) {
    return response;
  }

  // Clone so a non-JSON body can still be forwarded intact.
  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  if (!(GOOGLE_ISS_SUPPORT_FLAG in metadata)) {
    return response;
  }
  delete metadata[GOOGLE_ISS_SUPPORT_FLAG];

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export function buildProviders(env: OAuthEnv): Provider[] {
  const providers: Provider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: env.AUTH_GOOGLE_ID,
        clientSecret: env.AUTH_GOOGLE_SECRET,
        [customFetch]: googleDiscoveryFetch,
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