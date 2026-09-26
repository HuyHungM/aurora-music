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
import { LOCALE_COOKIE } from "@/lib/i18n/locale";
import { E2E_LOCALE, SESSION_MAX_AGE_SECONDS } from "./constants";

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

/**
 * A structurally valid but cryptographically broken token.
 *
 * The mutation is applied to the FIRST character of the token's LAST segment,
 * and every part of that choice is load-bearing.
 *
 * next-auth's `encode()` produces a JWE (five dot-separated segments: header,
 * encrypted key, IV, ciphertext, authentication tag), not a bare JWS, so the
 * segment that carries the integrity guarantee is the last one. The function
 * accepts three segments too, so it stays correct if the encoding is ever
 * configured to a signed token.
 *
 * Why not just change the last CHARACTER, which is the obvious one-liner and
 * is what this used to do? Because base64url cannot represent every byte
 * pattern: a 16-byte tag is 22 characters carrying 132 bits, of which the
 * final character's low 2 bits are padding that decode to nothing. Two
 * different final characters can therefore decode to byte-identical tags, and
 * mutating one of them changes the token's TEXT while leaving its bytes -
 * and its validity - untouched.
 *
 * That is not theoretical. Measured over 2000 tokens against the real
 * `decode()` from `@auth/core/jwt`, the previous last-character mutation
 * produced a token the server still ACCEPTED 134 times - 6.7% - every one of
 * them because the original final character was `Y`, which shares its four
 * significant bits with the `a` it was replaced by. The fixture meant to
 * prove a tampered session is rejected was instead a working session roughly
 * one run in fifteen, and the suite failed in `auth-setup` with "Session
 * verification failed for: tampered": the tamper proving acceptance.
 *
 * The first character of a segment is fully significant - it is the top 6 bits
 * of that segment's first byte - so changing it always changes the decoded
 * bytes. Across the same 2000 tokens this version produced 0 accepted.
 *
 * A token that is not a JWS/JWE is refused rather than mangled: inventing a
 * plausible-looking fixture is precisely the failure mode being removed.
 */
export function tamperToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 5) {
    throw new Error(
      `tamperToken: expected a 3-segment JWS or 5-segment JWE, received ${parts.length} segment(s)`,
    );
  }
  const last = parts.length - 1;
  const segment = parts[last];
  if (segment.length < 2) {
    throw new Error(
      `tamperToken: final segment is ${segment.length} character(s); nothing to tamper`,
    );
  }
  // `A` (value 0) unless the segment already starts with `A`, then `B` (1).
  // Both differ from each other in a bit the decoder cannot discard.
  parts[last] = (segment[0] === "A" ? "B" : "A") + segment.slice(1);
  return parts.join(".");
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
 *
 * It also carries the anonymous preference cookie. Locale precedence is
 * account preference → cookie → Vietnamese, so the account preference alone
 * leaves every context whose session is *not* valid rendering Vietnamese:
 * the sign-out journey, and the expired/tampered-session journeys, which
 * assert user-visible English accessible names precisely because they prove
 * the session was rejected. Seeding the cookie makes the rendered language
 * independent of session validity, using the same shipped code path a real
 * visitor uses. It grants nothing: the cookie carries no authority, and
 * `requireUser` still rejects every context whose session does not verify.
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
      {
        name: LOCALE_COOKIE,
        value: E2E_LOCALE,
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
        // Session cookie: follows the browser context, never outlives it.
        expires: -1,
      },
    ],
    origins: [],
  };
}
