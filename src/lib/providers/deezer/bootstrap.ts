/**
 * SERVER-ONLY. Registers the real Deezer provider.
 *
 * The catalog endpoints used here require no credentials, so unlike
 * YouTube this bootstrap is unconditional: no env key gates registration.
 * Idempotent and registry-clear resilient (same pattern as Phase 03).
 */

import { getProvider, registerProvider } from "../registry";
import { createDeezerApiTransport } from "./client";
import { createDeezerProvider } from "./deezer-provider";
import type { DeezerProvider } from "./deezer-provider";

let registered = false;

export function ensureDeezerProvider(): DeezerProvider | null {
  if (registered) {
    try {
      return getProvider("deezer") as DeezerProvider;
    } catch {
      // Registry was cleared (e.g. tests): fall through and re-register.
    }
  }
  const provider = createDeezerProvider(createDeezerApiTransport());
  registerProvider(provider);
  registered = true;
  return provider;
}

/** Test hook: forgets the registration flag. Never used in production. */
export function resetDeezerBootstrap(): void {
  registered = false;
}
