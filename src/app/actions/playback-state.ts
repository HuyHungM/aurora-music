"use server";

import { requireUser } from "@/lib/dal/session";
import {
  clearPlaybackState,
  getPlaybackState,
  savePlaybackState,
} from "@/lib/dal/playback-state";
import { fetchTrackDetail, getShellProviders } from "@/lib/providers/server";
import { getProvider } from "@/lib/providers/registry";
import type { Track } from "@/lib/domain";
import {
  idSchema,
  playbackStateSaveSchema,
  providerIdSchema,
} from "@/lib/validation/schemas";
import { validateQueueSnapshot } from "@/lib/player/queue-snapshot";
import { guardServerAction } from "@/lib/api/action-guard";

/** Same wording as the resolver's own kill switch: one player-wide condition. */
const RESOLVE_OFF_MESSAGE = "Playback is temporarily unavailable right now.";

export interface PlaybackStatePayload {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: string;
  /**
   * Validated versioned queue snapshot when the row carries one.
   * Serialized JSON only — never playback URLs (rejected at the
   * validation schema, at DAL write, and again at DAL read).
   */
  queueSnapshot?: unknown;
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
            ...(state.queueSnapshot ? { queueSnapshot: state.queueSnapshot } : {}),
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
    // The wire schema is structural only. Semantic validation and the
    // v1 → v2 upgrade happen here, so an old tab's snapshot is migrated
    // (never rejected, never half-restored) and a malformed one is
    // dropped instead of being written.
    //
    // `undefined` must stay `undefined`: the DAL reads it as "leave the
    // column untouched" while `null` is an explicit instruction to write
    // SQL NULL. Coercing an absent field to null let any caller that
    // omitted it — an older deployed tab mid-rollout, or a crafted
    // request — erase a full persisted queue on a routine checkpoint.
    const queueSnapshot =
      parsed.data.queueSnapshot === undefined
        ? undefined
        : validateQueueSnapshot(parsed.data.queueSnapshot);
    const user = await requireUser();
    const saved = await savePlaybackState(user.id, {
      provider: parsed.data.provider,
      providerTrackId: parsed.data.providerTrackId,
      position: parsed.data.position,
      revision: parsed.data.revision,
      queueSnapshot,
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
  // The ONLY provider-calling action with no rate bucket and no kill switch,
  // and it is anonymously reachable. `fetchTrackDetail` reaches the wire
  // (`provider.getTrack`), so an unbounded client can spend provider quota
  // from an unauthenticated context.
  //
  // The bucket is the generous `playbackResolve` one (120/min) rather than
  // `search` (30/min) on purpose: one client restore invokes this once PER
  // QUEUE ENTRY, and the queue persists up to 200 entries, so a legitimate
  // cold start would otherwise spend the whole search budget before the user
  // had done anything. The abuse this bounds is a scripted loop, not a page
  // load.
  const denied = await guardServerAction({
    featureOffMessage: RESOLVE_OFF_MESSAGE,
    bucket: "playbackResolve",
  });
  if (denied) {
    return { ok: true, track: null };
  }
  const providerParsed = providerIdSchema.safeParse(providerId);
  const trackParsed = idSchema.safeParse(providerTrackId);
  if (!providerParsed.success || !trackParsed.success) {
    return { ok: true, track: null };
  }
  try {
    // The provider registry is populated lazily by getShellProviders(), so a
    // cold process that has not yet rendered a provider-backed page has an
    // empty registry. Warming it here makes resolution independent of which
    // page happened to be the process's first request: without this, a cold
    // `/library` visit reported the track as unresolvable, and the
    // persistence layer treats an unresolvable persisted track as
    // permission to delete the user's saved session and queue — silently,
    // with no error surfaced anywhere. The ensure* calls are idempotent.
    getShellProviders();
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
