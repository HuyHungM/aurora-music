"use server";

import { requireUser } from "@/lib/dal/session";
import {
  clearPlaybackState,
  getPlaybackState,
  savePlaybackState,
} from "@/lib/dal/playback-state";
import { fetchTrackDetail } from "@/lib/providers/server";
import { getProvider } from "@/lib/providers/registry";
import type { Track } from "@/lib/domain";
import {
  idSchema,
  playbackStateSaveSchema,
  providerIdSchema,
} from "@/lib/validation/schemas";

export interface PlaybackStatePayload {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: string;
}

export async function getPlaybackStateAction(): Promise<
  | { ok: true; state: PlaybackStatePayload | null }
  | { ok: false }
> {
  try {
    const user = await requireUser();
    const state = await getPlaybackState(user.id);
    return {
      ok: true,
      state: state
        ? {
            provider: state.provider,
            providerTrackId: state.providerTrackId,
            position: state.position,
            revision: state.revision,
            updatedAt: state.updatedAt.toISOString(),
          }
        : null,
    };
  } catch {
    return { ok: false };
  }
}

export async function savePlaybackStateAction(
  input: unknown,
): Promise<{ ok: boolean; stale?: boolean }> {
  try {
    const parsed = playbackStateSaveSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false };
    }
    const user = await requireUser();
    const saved = await savePlaybackState(user.id, {
      provider: parsed.data.provider,
      providerTrackId: parsed.data.providerTrackId,
      position: parsed.data.position,
      revision: parsed.data.revision,
    });
    if (!saved) {
      return { ok: true, stale: true };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function clearPlaybackStateAction(): Promise<{ ok: boolean }> {
  try {
    const user = await requireUser();
    await clearPlaybackState(user.id);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function getSessionUserIdAction(): Promise<{ ok: boolean; userId: string | null }> {
  try {
    const { getSessionUserId } = await import("@/lib/dal/session");
    const userId = await getSessionUserId();
    return { ok: true, userId };
  } catch {
    return { ok: false, userId: null };
  }
}

/**
 * Resolves a persisted track reference through the provider abstraction.
 * The provider is the source of truth; persisted metadata is never trusted
 * for playable fields. Returns null when the track cannot be resolved.
 */
export async function resolvePlaybackTrackAction(
  providerId: unknown,
  providerTrackId: unknown,
): Promise<{ ok: true; track: Track | null }> {
  const providerParsed = providerIdSchema.safeParse(providerId);
  const trackParsed = idSchema.safeParse(providerTrackId);
  if (!providerParsed.success || !trackParsed.success) {
    return { ok: true, track: null };
  }
  try {
    let provider;
    try {
      provider = getProvider(providerParsed.data);
    } catch {
      // The exact provider is unavailable: track IDs are provider-scoped,
      // so never resolve through a different provider. Treat as unresolvable.
      return { ok: true, track: null };
    }
    const result = await fetchTrackDetail(trackParsed.data, provider);
    if (result.kind !== "success") {
      return { ok: true, track: null };
    }
    // Guard against providers echoing a mismatched identity.
    if (result.data.provider !== providerParsed.data) {
      return { ok: true, track: null };
    }
    return { ok: true, track: result.data };
  } catch {
    return { ok: true, track: null };
  }
}
