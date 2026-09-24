/**
 * Auth.js-compatible test session generation (Phase 30).
 *
 * The harness does NOT add a provider, route, or login form. It encodes
 * a session JWT with Auth.js's own `encode()` from `next-auth/jwt`
 * (same HKDF key derivation from AUTH_SECRET + cookie-name salt that
 * the production `auth()` verification path uses), for a REAL user row
 * in the test database. The browser therefore exercises the genuine
 * session → requireUser → DAL → Prisma path.
 */
import { encode } from "next-auth/jwt";
import { SESSION_MAX_AGE_SECONDS } from "./constants";

export interface SessionTokenInput {
  userId: string;
  email: string;
  name: string;
  secret: string;
  cookieName: string;
  maxAgeSeconds?: number;
}

/**
 * Encodes a session JWT containing exactly what production uses:
 * `sub` (mapped to session.user.id by the session callback) plus the
 * standard profile fields. No extra claims, no weakened validation.
 */
export async function createSessionToken(
  input: SessionTokenInput,
): Promise<string> {
  return encode({
    secret: input.secret,
    salt: input.cookieName,
    maxAge: input.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS,
    token: {
      sub: input.userId,
      email: input.email,
      name: input.name,
    },
  });
}

/** A structurally valid but cryptographically broken token. */
export function tamperToken(token: string): string {
  const last = token[token.length - 1];
  return `${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
}

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  expires: number;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: [];
}

/**
 * Builds a Playwright storage state carrying the session cookie with
 * the same attributes Auth.js sets (httpOnly, Lax, host-only domain).
 * Never localStorage: the real application uses cookies.
 */
export function buildStorageState(
  baseURL: string,
  cookieName: string,
  token: string,
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS,
): StorageState {
  const url = new URL(baseURL);
  return {
    cookies: [
      {
        name: cookieName,
        value: token,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + maxAgeSeconds,
      },
    ],
    origins: [],
  };
}
