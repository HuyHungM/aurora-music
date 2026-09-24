import type { ProviderId } from "@/lib/domain";
import { ProviderNotFoundError } from "@/lib/errors";
import type { MusicProvider } from "./types";

const providers = new Map<ProviderId, MusicProvider>();

export function registerProvider(provider: MusicProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(providerId: ProviderId): MusicProvider {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new ProviderNotFoundError(providerId);
  }
  return provider;
}

export function listProviders(): MusicProvider[] {
  return [...providers.values()];
}

export function clearProviders(): void {
  providers.clear();
}