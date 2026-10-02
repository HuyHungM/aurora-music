"use server";

import type { Track, TrackIdentity } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { getSessionUserId } from "@/lib/dal/session";
import { listRecent } from "@/lib/dal/recently-played";
import { getLibraryArtistNames } from "@/lib/dal/library";
import { listFollowedArtists } from "@/lib/dal/follow";
import { idSchema, providerIdSchema } from "@/lib/validation/schemas";
import {
  RADIO_EXTEND_BATCH,
  RADIO_INITIAL_TRACKS,
  RADIO_PLAYED_CAP,
  generateRadioBatch,
  identityKeys,
  type ArtistRef,
  type RadioMode,
} from "@/lib/radio/service";
import { getRadioBackend } from "@/lib/radio/backend";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";

export interface RadioStartResult {
  tracks: Track[];
}

export type StartRadioActionResult =
  | { ok: true; station: RadioStartResult }
  | ({ ok: false; error: string } & Partial<GuardFailure>);

export interface RadioExtendResult {
  tracks: Track[];
  exhausted: boolean;
}

export type ExtendRadioActionResult =
  | { ok: true; batch: RadioExtendResult }
  | ({ ok: false; error: string } & Partial<GuardFailure>);

const SAFE_START_ERROR = "Couldn't start radio. Try again in a moment.";
const SAFE_EXTEND_ERROR = "Couldn't find more tracks right now.";

/**
 * Radio is the most expensive thing a caller can ask for - every start and
 * every extension is a fresh provider generation - and it is reachable without
 * signing in. So it is both budgeted (RULE 12) and kill-switchable (RULE 48).
 *
 * The switch is checked first and costs nothing, so turning radio off in
 * production also stops it consuming budget it can never spend.
 */
const RADIO_OFF_MESSAGE = "Radio is temporarily unavailable right now.";

async function radioGuard(
  bucket: "radioStart" | "radioExtend",
  message: string,
): Promise<GuardFailure | null> {
  return guardServerAction({
    feature: "radio",
    featureOffMessage: message,
    bucket,
  });
}

function identityToQueueTrack(identity: TrackIdentity): Track {
  return identityToTrack(identity);
}

async function recentKeysFor(userId: string | null): Promise<Set<string>> {
  if (!userId) {
    return new Set();
  }
  try {
    const recent = await listRecent(userId, 20);
    return new Set(
      recent.map((entry) => `${entry.provider}:${entry.trackId}`),
    );
  } catch {
    return new Set();
  }
}

function capKeys(keys: string[]): string[] {
  return keys.slice(-RADIO_PLAYED_CAP);
}

/**
 * Starts track radio: the seed plays first, followed by a bounded
 * discovery batch. Anonymous-friendly; no library access required.
 */
export async function startTrackRadioAction(
  provider: unknown,
  providerTrackId: unknown,
): Promise<StartRadioActionResult> {
  const denied = await radioGuard("radioStart", RADIO_OFF_MESSAGE);
  if (denied) {
    return denied;
  }
  const providerParsed = providerIdSchema.safeParse(provider);
  const trackParsed = idSchema.safeParse(providerTrackId);
  if (!providerParsed.success || !trackParsed.success) {
    return { ok: false, error: SAFE_START_ERROR };
  }
  try {
    // Seed resolution goes through the same backend as discovery, so a
    // station never depends on a provider that isn't registered there.
    const seedTrack = await getRadioBackend().getTrack(
      providerParsed.data,
      trackParsed.data,
    );
    if (!seedTrack) {
      return { ok: false, error: SAFE_START_ERROR };
    }
    let seed: TrackIdentity;
    try {
      seed = toTrackIdentity(seedTrack);
    } catch {
      return { ok: false, error: SAFE_START_ERROR };
    }
    const userId = await getSessionUserId().catch(() => null);
    const exclude = new Set([
      ...identityKeys(seed),
      ...(await recentKeysFor(userId)),
    ]);
    const batch = await generateRadioBatch(getRadioBackend(), {
      mode: "track",
      seed,
      excludeKeys: exclude,
      limit: RADIO_INITIAL_TRACKS,
    });
    return {
      ok: true,
      station: {
        tracks: [identityToQueueTrack(seed), ...batch.groups.map(identityToQueueTrack)],
      },
    };
  } catch {
    return { ok: false, error: SAFE_START_ERROR };
  }
}

/**
 * Starts artist radio: the artist's own tracks first, then discovery.
 */
export async function startArtistRadioAction(
  provider: unknown,
  providerArtistId: unknown,
): Promise<StartRadioActionResult> {
  const denied = await radioGuard("radioStart", RADIO_OFF_MESSAGE);
  if (denied) {
    return denied;
  }
  const providerParsed = providerIdSchema.safeParse(provider);
  const artistParsed = idSchema.safeParse(providerArtistId);
  if (!providerParsed.success || !artistParsed.success) {
    return { ok: false, error: SAFE_START_ERROR };
  }
  try {
    const artist = await getRadioBackend().getArtist(
      providerParsed.data,
      artistParsed.data,
    );
    if (!artist) {
      return { ok: false, error: SAFE_START_ERROR };
    }
    const seedArtist: ArtistRef = {
      provider: artist.provider,
      providerArtistId: artist.providerArtistId ?? artist.id,
      name: artist.name,
    };
    const userId = await getSessionUserId().catch(() => null);
    const batch = await generateRadioBatch(getRadioBackend(), {
      mode: "artist",
      seedArtist,
      excludeKeys: await recentKeysFor(userId),
      limit: RADIO_INITIAL_TRACKS,
    });
    return {
      ok: true,
      station: {
        tracks: batch.groups.map(identityToQueueTrack),
      },
    };
  } catch {
    return { ok: false, error: SAFE_START_ERROR };
  }
}

/**
 * Starts discovery radio: popular catalog blended with the signed-in
 * listener's recent/liked/followed artists. Anonymous listeners get the
 * popular catalog alone — radio is never gated behind auth.
 */
export async function startDiscoveryRadioAction(): Promise<StartRadioActionResult> {
  const denied = await radioGuard("radioStart", RADIO_OFF_MESSAGE);
  if (denied) {
    return denied;
  }
  try {
    const userId = await getSessionUserId().catch(() => null);
    const signals: string[] = [];
    if (userId) {
      try {
        // Artist names only, via the narrow projection: the rendering read
        // also loads every playlist with all of its tracks and albums, none of
        // which a radio seed looks at.
        const [names, follows] = await Promise.all([
          getLibraryArtistNames(userId, { likedLimit: 20, recentLimit: 10 }),
          listFollowedArtists(userId, { limit: 10 }),
        ]);
        signals.push(...names.recentArtists, ...names.likedArtists);
        for (const follow of follows) {
          signals.push(follow.artist.name);
        }
      } catch {
        // Personalization is best-effort; popular catalog still plays.
      }
    }
    const batch = await generateRadioBatch(getRadioBackend(), {
      mode: "discovery",
      signals: [...new Set(signals)].slice(0, 10),
      excludeKeys: await recentKeysFor(userId),
      limit: RADIO_INITIAL_TRACKS,
    });
    return {
      ok: true,
      station: {
        tracks: batch.groups.map(identityToQueueTrack),
      },
    };
  } catch {
    return { ok: false, error: SAFE_START_ERROR };
  }
}

export interface ExtendRadioInput {
  mode: RadioMode;
  seedTrack?: { provider: string; providerTrackId: string };
  seedArtist?: { provider: string; providerArtistId: string; name: string };
  excludeKeys?: string[];
  limit?: number;
}

/**
 * Generates the next bounded batch for an active session. Stateless:
 * the client owns played/queue exclusion; the server merges in recent
 * history for signed-in listeners. Never resolves playback.
 */
export async function extendRadioBatchAction(
  input: ExtendRadioInput,
): Promise<ExtendRadioActionResult> {
  const denied = await radioGuard("radioExtend", RADIO_OFF_MESSAGE);
  if (denied) {
    return denied;
  }
  if (!input || (input.mode !== "track" && input.mode !== "artist" && input.mode !== "discovery")) {
    return { ok: false, error: SAFE_EXTEND_ERROR };
  }
  try {
    const userId = await getSessionUserId().catch(() => null);
    const exclude = new Set([
      ...capKeys(input.excludeKeys ?? []),
      ...(await recentKeysFor(userId)),
    ]);

    if (input.mode === "track") {
      const ref = input.seedTrack;
      if (!ref || typeof ref.providerTrackId !== "string") {
        return { ok: false, error: SAFE_EXTEND_ERROR };
      }
      const seedTrack = await getRadioBackend()
        .getTrack(ref.provider, ref.providerTrackId)
        .catch(() => null);
      if (!seedTrack) {
        return { ok: true, batch: { tracks: [], exhausted: true } };
      }
      let seed: TrackIdentity;
      try {
        seed = toTrackIdentity(seedTrack);
      } catch {
        return { ok: true, batch: { tracks: [], exhausted: true } };
      }
    const batch = await generateRadioBatch(getRadioBackend(), {
      mode: "track",
      seed,
      excludeKeys: exclude,
      limit: Math.min(Math.max(input.limit ?? RADIO_EXTEND_BATCH, 1), RADIO_EXTEND_BATCH),
    });
    return {
      ok: true,
      batch: {
        tracks: batch.groups.map(identityToQueueTrack),
        exhausted: batch.exhausted,
      },
    };
    }

    if (input.mode === "artist") {
      const ref = input.seedArtist;
      if (!ref || typeof ref.providerArtistId !== "string" || typeof ref.name !== "string") {
        return { ok: false, error: SAFE_EXTEND_ERROR };
      }
      const batch = await generateRadioBatch(getRadioBackend(), {
        mode: "artist",
        seedArtist: {
          provider: ref.provider,
          providerArtistId: ref.providerArtistId,
          name: ref.name,
        },
        excludeKeys: exclude,
        limit: Math.min(Math.max(input.limit ?? RADIO_EXTEND_BATCH, 1), RADIO_EXTEND_BATCH),
      });
      return {
        ok: true,
        batch: {
          tracks: batch.groups.map(identityToQueueTrack),
          exhausted: batch.exhausted,
        },
      };
    }

    const batch = await generateRadioBatch(getRadioBackend(), {
      mode: "discovery",
      excludeKeys: exclude,
      limit: Math.min(Math.max(input.limit ?? RADIO_EXTEND_BATCH, 1), RADIO_EXTEND_BATCH),
    });
    return {
      ok: true,
      batch: {
        tracks: batch.groups.map(identityToQueueTrack),
        exhausted: batch.exhausted,
      },
    };
  } catch {
    return { ok: false, error: SAFE_EXTEND_ERROR };
  }
}


