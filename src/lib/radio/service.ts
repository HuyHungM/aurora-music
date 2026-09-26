import type {
  Album,
  Artist,
  MatchClassification,
  Track,
  TrackIdentity,
  TrackMatcher,
} from "@/lib/domain";
import {
  createTrackMatcher,
  identityKeys,
  mergeSourceReference,
  sourceReferenceKey,
  toTrackIdentity,
} from "@/lib/domain";

/**
 * Aurora Radio discovery service (Phase 41, server-side).
 *
 * Seed-based algorithmic radio over the EXISTING provider architecture:
 * no new providers, no ML, no audio handling. The service owns seed
 * interpretation, candidate discovery, normalization, matching, ranking,
 * and bounded batch generation. It owns NO playback, NO audio URLs, NO
 * browser media, and NO queue state — batches hand normalized tracks to
 * QueueManager, which remains the single queue authority.
 *
 * Deterministic and explainable: identical inputs always produce
 * identical batches. Ranking uses only real data (same-artist/album
 * relations, matcher corroboration, title affinity, duration fit).
 */

export const RADIO_INITIAL_TRACKS = 5;
export const RADIO_EXTEND_BATCH = 5;
export const RADIO_MAX_CANDIDATES_PER_AVENUE = 10;
/** Absolute cap on tracks one session may generate (bounded queues). */
export const RADIO_SESSION_TRACK_CAP = 60;
/** Cap on remembered played keys per session (bounded memory). */
export const RADIO_PLAYED_CAP = 300;

export type RadioMode = "track" | "artist" | "discovery";

/**
 * Canonical key set helper: every source of an identity, not just primary.
 * Now defined in the domain layer (Phase 47) and re-exported here, because
 * radio and generic queue continuation must resolve "the same track"
 * identically — two copies of this rule could drift and let a duplicate
 * slip past de-duplication.
 */
export { identityKeys } from "@/lib/domain";

export interface ArtistRef {
  provider: string;
  providerArtistId: string;
  name: string;
}

export interface AlbumRef {
  provider: string;
  providerAlbumId: string;
}

/**
 * Minimal discovery surface. The production implementation fans out to
 * capable providers with per-avenue failure isolation; test doubles and
 * the E2E fixture catalog implement the same contract deterministically.
 */
export interface RadioDiscoveryBackend {
  searchTracks(query: string, limit: number): Promise<Track[]>;
  artistTracks(artist: ArtistRef, limit: number): Promise<Track[]>;
  albumTracks(album: AlbumRef, limit: number): Promise<Track[]>;
  artistAlbums(artist: ArtistRef, limit: number): Promise<Album[]>;
  popularTracks(limit: number): Promise<Track[]>;
  /**
   * Seed resolution through the same catalog the avenues use, so a
   * station never depends on a provider that isn't registered here.
   * Returns null when the seed cannot be resolved.
   */
  getTrack(provider: string, providerTrackId: string): Promise<Track | null>;
  getArtist(provider: string, providerArtistId: string): Promise<Artist | null>;
}

export interface RankedGroup {
  identity: TrackIdentity;
  score: number;
  reasons: string[];
}

const MERGEABLE: readonly MatchClassification[] = ["exact", "strong"];

function foldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function significantTokens(title: string): string[] {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "of",
    "to",
    "in",
    "on",
    "for",
    "with",
    "le",
    "la",
    "les",
    "de",
    "des",
    "el",
    "en",
  ]);
  return foldName(title)
    .split(" ")
    .filter((token) => token.length > 2 && !stop.has(token));
}

/**
 * Groups raw provider tracks into canonical identities using the
 * calibrated matcher (exact|strong merge only — same rule as unified
 * search, so cross-provider duplicates never fragment a batch).
 */
export function groupCandidates(
  tracks: Track[],
  matcher: TrackMatcher = createTrackMatcher(),
): TrackIdentity[] {
  const groups: TrackIdentity[] = [];
  for (const track of tracks) {
    let candidate: TrackIdentity;
    try {
      candidate = toTrackIdentity(track);
    } catch {
      continue;
    }
    const key = sourceReferenceKey(candidate.primarySource);
    const claimed = groups.findIndex((group) =>
      group.sources.some((source) => sourceReferenceKey(source) === key),
    );
    if (claimed !== -1) {
      groups[claimed] = mergeSourceReference(groups[claimed] as TrackIdentity, candidate.primarySource);
      continue;
    }
    const qualifying: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const result = matcher.match(candidate, groups[index] as TrackIdentity);
      if (result.matched && MERGEABLE.includes(result.classification)) {
        qualifying.push(index);
      }
    }
    if (qualifying.length === 1) {
      const target = groups[qualifying[0] as number] as TrackIdentity;
      groups[qualifying[0] as number] = mergeSourceReference(target, candidate.primarySource);
    } else {
      groups.push(candidate);
    }
  }
  return groups;
}

export interface RankContext {
  seedTitle: string;
  seedArtist: string;
  seedAlbum?: string;
  seedDurationMs?: number;
  /** Canonical keys already heard or queued: excluded, never penalized. */
  excludeKeys: Set<string>;
}

/**
 * Deterministic ranking over grouped candidates. Returns at most `limit`
 * groups in score order (stable: discovery order breaks ties).
 */
export function rankGroups(
  groups: TrackIdentity[],
  context: RankContext,
  limit: number,
): RankedGroup[] {
  const seedArtist = foldName(context.seedArtist);
  const seedAlbum = context.seedAlbum ? foldName(context.seedAlbum) : null;
  const seedTokens = new Set(significantTokens(context.seedTitle));
  const ranked: Array<RankedGroup & { order: number }> = [];

  groups.forEach((identity, order) => {
    const keys = identityKeys(identity);
    for (const key of keys) {
      if (context.excludeKeys.has(key)) {
        return;
      }
    }
    let score = 0;
    const reasons: string[] = [];
    const artistName = identity.artists[0]?.name ?? "";
    if (seedArtist.length > 0 && foldName(artistName) === seedArtist) {
      score += 100;
      reasons.push("same-artist");
    }
    if (
      seedAlbum &&
      identity.album &&
      foldName(identity.album.title) === seedAlbum
    ) {
      score += 60;
      reasons.push("same-album");
    }
    if (identity.sources.length > 1) {
      score += 40;
      reasons.push("cross-source");
    }
    let shared = 0;
    for (const token of significantTokens(identity.title)) {
      if (seedTokens.has(token)) {
        shared += 1;
      }
    }
    if (shared > 0) {
      score += Math.min(shared, 3) * 10;
      reasons.push("title-affinity");
    }
    if (
      context.seedDurationMs !== undefined &&
      identity.durationMs !== undefined &&
      Math.abs(identity.durationMs - context.seedDurationMs) <= 30_000
    ) {
      score += 10;
      reasons.push("duration-fit");
    }
    ranked.push({ identity, score, reasons, order });
  });

  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, Math.max(0, limit)).map(({ identity, score, reasons }) => ({
    identity,
    score,
    reasons,
  }));
}

async function safe<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

export interface RadioBatchRequest {
  mode: RadioMode;
  /** Canonical seed (track radio). */
  seed?: TrackIdentity;
  /** Artist seed (artist radio). */
  seedArtist?: ArtistRef;
  /** Free-text discovery signals (liked/recent artists). */
  signals?: string[];
  excludeKeys: Set<string>;
  limit: number;
}

export interface RadioBatch {
  groups: TrackIdentity[];
  /** True when no avenue produced a new candidate. */
  exhausted: boolean;
}

export interface RankedRadioBatch {
  ranked: RankedGroup[];
  exhausted: boolean;
}

/**
 * The ranked form of one bounded batch, kept separate so callers that need
 * the scores and evidence labels (Phase 47 recommendations) can reuse the
 * exact same ranking instead of re-scoring or forking it. Radio itself
 * consumes `generateRadioBatch`, whose contract is unchanged.
 */
export async function generateRankedRadioBatch(
  backend: RadioDiscoveryBackend,
  request: RadioBatchRequest,
  matcher: TrackMatcher = createTrackMatcher(),
): Promise<RankedRadioBatch> {
  const raw: Track[] = [];
  const AVENUE_LIMIT = RADIO_MAX_CANDIDATES_PER_AVENUE;

  if (request.mode === "track" && request.seed) {
    const seed = request.seed;
    const artistName = seed.artists[0]?.name ?? "";
    // Avenue 1: same artist via name search (provider-safe names, not ids).
    if (artistName.length > 0) {
      raw.push(...(await safe(() => backend.searchTracks(artistName, AVENUE_LIMIT), [])));
    }
    // Avenue 2: seed album tracks (provider-scoped ids fail closed).
    if (seed.album) {
      const albumId = seed.album.providerAlbumId ?? seed.album.id;
      raw.push(
        ...(await safe(
          () =>
            backend.albumTracks(
              {
                provider: seed.primarySource.source,
                providerAlbumId: albumId,
              },
              AVENUE_LIMIT,
            ),
          [],
        )),
      );
    }
    // Avenue 3: title-affinity search.
    raw.push(...(await safe(() => backend.searchTracks(seed.title, 5), [])));
  }

  if (request.mode === "artist" && request.seedArtist) {
    const artist = request.seedArtist;
    // Avenue 1: the artist's own tracks.
    raw.push(...(await safe(() => backend.artistTracks(artist, AVENUE_LIMIT), [])));
    // Avenue 2: artist albums → album tracks (bounded fan-out).
    const albums = await safe(() => backend.artistAlbums(artist, 5), []);
    for (const album of albums.slice(0, 3)) {
      raw.push(
        ...(await safe(
          () =>
            backend.albumTracks(
              {
                provider: album.provider,
                providerAlbumId: album.providerAlbumId ?? album.id,
              },
              AVENUE_LIMIT,
            ),
          [],
        )),
      );
    }
    // Avenue 3: artist-name search across providers.
    if (artist.name.length > 0) {
      raw.push(...(await safe(() => backend.searchTracks(artist.name, AVENUE_LIMIT), [])));
    }
  }

  if (request.mode === "discovery") {
    // Avenue 1: popular catalog (whatever provider offers it).
    raw.push(...(await safe(() => backend.popularTracks(AVENUE_LIMIT), [])));
    // Avenue 2: bounded signal searches (liked/recent artists).
    for (const signal of (request.signals ?? []).slice(0, 3)) {
      raw.push(...(await safe(() => backend.searchTracks(signal, 5), [])));
    }
  }

  // Final avenue for seeded modes: popular catalog keeps continuity
  // when related avenues run dry (ranked last by the scorer).
  if (request.mode !== "discovery") {
    raw.push(...(await safe(() => backend.popularTracks(5), [])));
  }

  const groups = groupCandidates(raw, matcher);
  const seedArtist =
    request.mode === "track"
      ? (request.seed?.artists[0]?.name ?? "")
      : (request.seedArtist?.name ?? "");
  const ranked = rankGroups(
    groups,
    {
      seedTitle:
        request.mode === "track" ? (request.seed?.title ?? "") : seedArtist,
      seedArtist,
      seedAlbum: request.seed?.album?.title,
      seedDurationMs: request.seed?.durationMs,
      excludeKeys: request.excludeKeys,
    },
    request.limit,
  );
  return {
    ranked,
    exhausted: ranked.length === 0,
  };
}

/**
 * Generates one bounded batch. Avenues run in a fixed order with
 * per-avenue failure isolation: one provider failing never sinks the
 * batch. Every avenue is bounded; nothing here is unbounded or cached.
 */
export async function generateRadioBatch(
  backend: RadioDiscoveryBackend,
  request: RadioBatchRequest,
  matcher: TrackMatcher = createTrackMatcher(),
): Promise<RadioBatch> {
  const { ranked, exhausted } = await generateRankedRadioBatch(backend, request, matcher);
  return { groups: ranked.map((entry) => entry.identity), exhausted };
}
