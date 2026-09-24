/**
 * SERVER-ONLY. Registers the real YouTube provider when a server-side API
 * key is configured. No key (the default in tests and local dev) means no
 * registration and no behavior change — the suite must never depend on
 * `YOUTUBE_API_KEY` being present.
 *
 * Idempotent: safe to call on every server request path. Re-registers only
 * when the configured key changed since the last call.
 */

import type { EnvConfig } from "@/lib/config/env";
import { getEnv } from "@/lib/config/env";
import { getProvider, registerProvider } from "../registry";
import { createYouTubeApiTransport } from "./client";
import { createYouTubeProvider } from "./youtube-provider";
import type { YouTubeProvider } from "./youtube-provider";

let registeredKey: string | null = null;

export function ensureYouTubeProvider(
  env: EnvConfig = getEnv(),
): YouTubeProvider | null {
  const apiKey = env.YOUTUBE_API_KEY?.trim() || null;
  if (!apiKey) {
    return null;
  }
  if (registeredKey === apiKey) {
    try {
      return getProvider("youtube") as YouTubeProvider;
    } catch {
      // Registry was cleared (e.g. tests): fall through and re-register.
    }
  }
  const provider = createYouTubeProvider(createYouTubeApiTransport(apiKey));
  registerProvider(provider);
  registeredKey = apiKey;
  return provider;
}

/** Test hook: forgets the last registered key. Never used in production. */
export function resetYouTubeBootstrap(): void {
  registeredKey = null;
}
