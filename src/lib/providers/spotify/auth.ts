/**
 * SERVER-ONLY Spotify Client Credentials token client.
 *
 * App-only catalog access (no user data, no user OAuth). The access token
 * lives in memory for the process lifetime only: never persisted to Prisma,
 * never exposed to the browser, never logged. Secret-safe errors throughout.
 *
 * Lifetime: Spotify issues ~1h tokens; a 60s safety margin is applied so
 * refresh happens before the expiry boundary, not on it.
 */

import { ExtractorError } from "@/lib/domain";
import { InvalidProviderCredentialsError } from "@/lib/errors";

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const REQUEST_TIMEOUT_MS = 10_000;
const PROVIDER_ID = "spotify";
const DEFAULT_EXPIRY_MARGIN_MS = 60_000;

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Narrow fetch dependency for tests. Defaults to the global fetch so
 * production uses no wrapper and tests inject recorded fixtures.
 */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface TokenClientOptions {
  fetchFn?: FetchFn;
  /** Injectable clock (tests). Defaults to Date.now. */
  nowFn?: () => number;
  /** Refresh this far ahead of expiry. Defaults to 60s. */
  expiryMarginMs?: number;
  timeoutMs?: number;
}

export interface SpotifyTokenClient {
  /** Returns a valid bearer token, refreshing only when necessary. */
  getAccessToken(): Promise<string>;
  /** Drops the cached token (used after a 401). */
  invalidate(): void;
  /** Introspection for tests; never exposes the token itself. */
  snapshot(): { hasCached: boolean; expiresAt: number | null };
}

export function createTokenClient(
  credentials: SpotifyCredentials,
  options: TokenClientOptions = {},
): SpotifyTokenClient {
  const fetchFn: FetchFn =
    options.fetchFn ??
    ((input, init) =>
      fetch(input, init) as Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
      }>);
  const nowFn = options.nowFn ?? Date.now;
  const marginMs = options.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  function isFresh(now: number): boolean {
    return cached !== null && now < cached.expiresAt - marginMs;
  }

  async function acquire(): Promise<string> {
    // btoa is universal (Node 16+, browsers, Bun, edge); Buffer covers
    // runtimes without it.
    const basic =
      typeof btoa === "function"
        ? btoa(`${credentials.clientId}:${credentials.clientSecret}`)
        : Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    const body = new URLSearchParams({ grant_type: "client_credentials" });

    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await fetchFn(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ExtractorError(
        PROVIDER_ID,
        "token",
        "Spotify token endpoint unreachable",
        { retryable: true, cause: error },
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ExtractorError(PROVIDER_ID, "token", "Spotify token response unreadable", {
        cause: error,
      });
    }

    if (!response.ok) {
      if (response.status === 400) {
        // invalid_client and friends: the credentials themselves are wrong.
        throw new InvalidProviderCredentialsError(
          PROVIDER_ID,
          "Spotify rejected the client credentials",
        );
      }
      if (response.status >= 500) {
        throw new ExtractorError(PROVIDER_ID, "token", "Spotify token endpoint unavailable", {
          retryable: true,
        });
      }
      throw new ExtractorError(
        PROVIDER_ID,
        "token",
        `Spotify token request failed (${response.status})`,
      );
    }

    if (!payload || typeof payload !== "object") {
      throw new ExtractorError(PROVIDER_ID, "token", "Spotify token response malformed");
    }
    const record = payload as Record<string, unknown>;
    const token = record.access_token;
    const expiresIn = record.expires_in;
    if (typeof token !== "string" || token.length === 0) {
      throw new ExtractorError(PROVIDER_ID, "token", "Spotify token response malformed");
    }
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ExtractorError(PROVIDER_ID, "token", "Spotify token response malformed");
    }

    const now = nowFn();
    cached = { token, expiresAt: now + Math.floor(expiresIn * 1000) };
    return token;
  }

  return {
    async getAccessToken(): Promise<string> {
      const now = nowFn();
      if (isFresh(now)) {
        return (cached as { token: string }).token;
      }
      if (inflight) {
        // Share one acquisition across concurrent callers: no stampede.
        return inflight;
      }
      inflight = acquire();
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },

    invalidate(): void {
      cached = null;
    },

    snapshot(): { hasCached: boolean; expiresAt: number | null } {
      return { hasCached: cached !== null, expiresAt: cached?.expiresAt ?? null };
    },
  };
}
