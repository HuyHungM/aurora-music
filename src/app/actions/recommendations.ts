"use server";

import type { Track } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { getSessionUserId } from "@/lib/dal/session";
import { getRadioBackend } from "@/lib/radio/backend";
import { RADIO_PLAYED_CAP } from "@/lib/radio/service";
import {
  RECOMMENDATION_SET_SIZE,
  generateRecommendations,
  type RecommendationCategory,
  type RecommendationSignals,
} from "@/lib/recommendations/service";
import {
  collectRecommendationSignals,
  recentHistoryExcludeKeys,
} from "@/lib/recommendations/signals";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";

/**
 * Phase 47 recommendation surface action.
 *
 * Privacy contract (§48, §81): the personalization signals — recently
 * played, liked tracks, followed artists — are read from Aurora's own
 * database here on the server. The client never sends listening history, and
 * nothing is forwarded to an external recommendation service. The only
 * client-supplied inputs are the *shape* of the request (which surface, the
 * current track, and canonical keys to exclude).
 *
 * Provider role contract (§24): Spotify and Deezer contribute metadata and
 * discovery; only YouTube provides playback. Results are returned as plain
 * Aurora `Track`s so no surface renders a provider-branded product.
 *
 * This action is used by the client-side continuation coordinator. The
 * static page sections call `buildRecommendationSection` directly on the
 * server instead, so a page render never round-trips through a server
 * action.
 */

const SAFE_ERROR = "Couldn't find recommendations right now.";

/**
 * Surfaces. Each has a distinct purpose; recommendations are not sprayed
 * across the product (§28).
 */
export type RecommendationSurface = "home" | "track" | "continuation";

export interface RecommendationRequest {
  surface?: unknown;
  /** The track to anchor on: the current track (track/continuation). */
  currentTrack?:
    | { provider?: unknown; providerTrackId?: unknown; artistName?: unknown }
    | null;
  /** Canonical keys to exclude: the queue, already-played, already-suggested. */
  excludeKeys?: unknown;
  limit?: unknown;
}

export type RecommendTracksActionResult =
  | { ok: true; tracks: Track[]; categories: RecommendationCategory[] }
  | ({ ok: false; error: string } & Partial<GuardFailure>);

const SURFACES: readonly RecommendationSurface[] = ["home", "track", "continuation"];

/**
 * Recommendations read listening history and then fan out to providers on every
 * call, so they carry both a budget and a kill switch (RULE 12, RULE 48).
 *
 * The switch matters more here than the budget: this is the feature most
 * dependent on provider health, and "stop asking Spotify" is exactly the
 * action an operator wants during a provider incident.
 */
const RECOMMENDATIONS_OFF_MESSAGE = "Recommendations are unavailable right now.";

function parseSurface(value: unknown): RecommendationSurface {
  return typeof value === "string" && (SURFACES as readonly string[]).includes(value)
    ? (value as RecommendationSurface)
    : "home";
}

/**
 * Canonical keys are `provider:id`. Bounds both the count and each key's
 * length so a client cannot turn one request into an unbounded payload.
 */
function parseExcludeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 320) {
      continue;
    }
    out.push(entry);
    if (out.length >= RADIO_PLAYED_CAP) {
      break;
    }
  }
  return out;
}

function parseCurrentTrack(
  value: unknown,
): RecommendationSignals["currentTrack"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as {
    provider?: unknown;
    providerTrackId?: unknown;
    artistName?: unknown;
  };
  if (
    typeof raw.provider !== "string" ||
    raw.provider.length === 0 ||
    raw.provider.length > 64 ||
    typeof raw.providerTrackId !== "string" ||
    raw.providerTrackId.length === 0 ||
    raw.providerTrackId.length > 256
  ) {
    return null;
  }
  return {
    provider: raw.provider,
    providerTrackId: raw.providerTrackId,
    artistName:
      typeof raw.artistName === "string" ? raw.artistName.slice(0, 256) : undefined,
  };
}

export async function recommendTracksAction(
  request: RecommendationRequest,
): Promise<RecommendTracksActionResult> {
  const denied = await guardServerAction({
    feature: "recommendations",
    featureOffMessage: RECOMMENDATIONS_OFF_MESSAGE,
    bucket: "recommendations",
  });
  if (denied) {
    return denied;
  }
  try {
    if (!request || typeof request !== "object") {
      return { ok: false, error: SAFE_ERROR };
    }
    const surface = parseSurface(request.surface);
    const userId = await getSessionUserId().catch(() => null);
    const signals = await collectRecommendationSignals(userId);
    const limit =
      typeof request.limit === "number" && Number.isFinite(request.limit)
        ? Math.max(1, Math.min(Math.trunc(request.limit), RECOMMENDATION_SET_SIZE))
        : RECOMMENDATION_SET_SIZE;

    // The continuation surface must never personalize the *shared* content
    // of a collection; it only extends what is already playing.
    const full: RecommendationSignals = {
      ...signals,
      currentTrack: surface === "home" ? null : parseCurrentTrack(request.currentTrack),
      excludeKeys: [
        ...parseExcludeKeys(request.excludeKeys),
        ...(await recentHistoryExcludeKeys(userId)),
      ],
    };

    const set = await generateRecommendations(getRadioBackend(), full, limit);
    if (set.items.length === 0) {
      return { ok: true, tracks: [], categories: [] };
    }
    return {
      ok: true,
      tracks: set.items.map((item) => identityToTrack(item.identity)),
      categories: set.categories,
    };
  } catch {
    return { ok: false, error: SAFE_ERROR };
  }
}
