/**
 * SERVER-ONLY. Registers the real YouTube provider when a server-side API
 * key is configured. No key (the default in tests and local dev) means no
 * registration and no behavior change — the suite must never depend on
 * `YOUTUBE_API_KEY` being present.
 *
 * Idempotent: safe to call on every server request path. Re-registers only
 * when the configured key changed since the last call.
 *
 * PHASE 55 — SOURCE WIRING. Registration is unchanged, but what gets
 * registered changed: the provider now receives a *tiered* transport rather
 * than a Data API transport. InnerTube serves discovery (search, video
 * metadata) and the official API remains the fallback plus the only source for
 * channel metadata and playlists. `docs/youtube-request-map.md` records the
 * per-endpoint decision; `tiered-transport.ts` is the code.
 *
 * The registration GATE is deliberately still the API key, even though
 * InnerTube needs no key. Two reasons, both about blast radius rather than
 * principle:
 *
 * 1. Making the YouTube provider keyless would change WHICH providers exist in
 *    every deployment that has no key today — including the entire test suite,
 *    which asserts that "no key" means "no YouTube". That is a different
 *    phase from the one that moves the request path, and bundling them would
 *    make both harder to verify.
 * 2. With no key there is no official fallback at all. A keyless provider whose
 *    InnerTube path degrades has nothing to fall back to, which is a worse
 *    product than no provider. The trade is only worth it once the fallback
 *    story for a keyless deployment is designed.
 *
 * It is recorded in `docs/scope-boundaries.md` as a deliberate deferral with
 * this reasoning, rather than left as an undocumented gap.
 */

import type { EnvConfig } from "@/lib/config/env";
import { getEnv } from "@/lib/config/env";
import { getProvider, registerProvider } from "../registry";
import { createYouTubeApiTransport } from "./client";
import { createInnerTubeTransport } from "./innertube/transport";
import { createTieredTransport } from "./tiered-transport";
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
  const transport = createTieredTransport({
    primary: createInnerTubeTransport(),
    fallback: createYouTubeApiTransport(apiKey),
  });
  const provider = createYouTubeProvider(transport);
  registerProvider(provider);
  registeredKey = apiKey;
  return provider;
}

/** Test hook: forgets the last registered key. Never used in production. */
export function resetYouTubeBootstrap(): void {
  registeredKey = null;
}
