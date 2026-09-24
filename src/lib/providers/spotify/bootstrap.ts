/**
 * SERVER-ONLY. Registers the real Spotify provider when Client Credentials
 * are configured. Unlike keyless Deezer, Spotify's Web API always requires
 * authorization: without both `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`
 * this is a no-op returning null (same gating pattern as YouTube).
 * Idempotent, credential-rotation aware, and registry-clear resilient.
 */

import type { EnvConfig } from "@/lib/config/env";
import { getEnv } from "@/lib/config/env";
import { getProvider, registerProvider } from "../registry";
import { createTokenClient } from "./auth";
import { createSpotifyApiTransport } from "./client";
import { createSpotifyProvider } from "./spotify-provider";
import type { SpotifyProvider } from "./spotify-provider";

let registeredFingerprint: string | null = null;

export function ensureSpotifyProvider(
  env: EnvConfig = getEnv(),
): SpotifyProvider | null {
  const clientId = env.SPOTIFY_CLIENT_ID?.trim() || null;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim() || null;
  if (!clientId || !clientSecret) {
    return null;
  }
  // Full pair, mirroring the YouTube bootstrap: rotation must be detected
  // even when secrets share a length. Credentials already live in env.
  const fingerprint = `${clientId}:${clientSecret}`;
  if (registeredFingerprint === fingerprint) {
    try {
      return getProvider("spotify") as SpotifyProvider;
    } catch {
      // Registry was cleared (e.g. tests): fall through and re-register.
    }
  }
  const tokenClient = createTokenClient({ clientId, clientSecret });
  const provider = createSpotifyProvider(createSpotifyApiTransport(tokenClient));
  registerProvider(provider);
  registeredFingerprint = fingerprint;
  return provider;
}

/** Test hook: forgets the registration fingerprint. Never used in production. */
export function resetSpotifyBootstrap(): void {
  registeredFingerprint = null;
}
