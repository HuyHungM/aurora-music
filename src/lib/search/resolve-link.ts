import type {
  ProviderListResult,
  ProviderPagination,
} from "@/lib/providers/types";
import type {
  DetectedSource,
  DetectedSourceKind,
} from "@/lib/providers/source-detection";
import type {
  Album,
  SourceType,
  Track,
  TrackIdentity,
  TrackMatcher,
} from "@/lib/domain";
import {
  ExtractorError,
  TrackNotFoundError,
  createTrackMatcher,
  dedupeCanonicalTracks,
  toTrackIdentity,
} from "@/lib/domain";
import { enrichIdentity } from "@/lib/music/unified-search";
import { extractorManager } from "@/lib/providers/extractor-manager";
import { getShellProviders } from "@/lib/providers/server";

/**
 * Turning a pasted provider link into Aurora resources.
 *
 * This is an extension of the existing search architecture, not a second
 * search engine: the pipeline below reuses the canonical detector
 * (`detectSource`), the canonical provider lookup (`ExtractorManager.getTrack`
 * / `MusicProvider.getPlaylist`), the canonical identity (`toTrackIdentity`),
 * the canonical matcher (`TrackMatcher` via `enrichIdentity`) and the
 * canonical duplicate rules (`dedupeCanonicalTracks`). Nothing here ranks,
 * persists, plays or resolves a stream.
 *
 * ```text
 * track link      -> provider.getTrack(id)   -> TrackIdentity (exact, NO search)
 *                    [spotify/deezer only] one YouTube text search
 *                  -> TrackMatcher + enrichIdentity (the same pipeline unified
 *                     search uses) so PlaybackResolver has a resolvable source.
 *                     Metadata only: Aurora never plays Spotify.
 *
 * playlist link   -> provider.getPlaylist(id)          -> tracks
 * album link      -> provider.getAlbum + getAlbumTracks -> tracks
 *                  -> TrackIdentity per track -> cross-source match where
 *                     needed -> canonical dedupe -> order preserved
 * ```
 *
 * QUOTA: a track link is one direct lookup. It never fans out to `search.list`
 * to rediscover the same video (the id is already known, so `getTrack` is a
 * `videos.list`/innertube `getVideos`), and it never text-searches Spotify for
 * the Spotify URL it was given. The single YouTube search on a Spotify/Deezer
 * track exists only to find the equivalent video the cross-source pipeline
 * requires, and it is cached by the provider's search TTL like any other
 * search.
 */

/**
 * Tracks loaded for one pasted collection link.
 *
 * Bounded on purpose (SPEC §8: a pasted link must not add an unlimited number
 * of tracks) and equal to a single provider page, the window the providers
 * already implement. The bound is also the request budget: cross-source
 * matching costs one YouTube search per track, so capping the load caps what
 * one paste can spend.
 */
export const LINK_COLLECTION_LIMIT = 20;

/** Candidates fetched per cross-source match. */
export const LINK_MATCH_CANDIDATES = 10;

/** Cross-source matching runs this many tracks at a time. */
export const LINK_MATCH_CONCURRENCY = 4;

export type SearchLinkErrorCode = "not-found" | "unsupported" | "unavailable";

/**
 * A link that is recognised but cannot be resolved.
 *
 * Only a `code` crosses the server-action boundary; the message is for logs.
 * The page maps the code to localized copy, so a provider's raw error text
 * (which can name an endpoint, a status or a host) never reaches the UI.
 */
export class SearchLinkError extends Error {
  readonly code: SearchLinkErrorCode;

  constructor(code: SearchLinkErrorCode, message: string) {
    super(message);
    this.name = "SearchLinkError";
    this.code = code;
  }
}

export interface SearchLinkTrackResult {
  kind: "track";
  provider: SourceType;
  resourceKind: Extract<DetectedSourceKind, "track">;
  id: string;
  track: TrackIdentity;
  /** True when cross-source matching attached a resolvable YouTube source. */
  matched: boolean;
}

export interface SearchLinkCollectionResult {
  kind: "collection";
  provider: SourceType;
  resourceKind: Extract<DetectedSourceKind, "album" | "playlist">;
  id: string;
  title: string;
  description?: string;
  artworkUrl?: string;
  /** Provider-reported size of the whole resource, when it reports one. */
  total: number;
  tracks: TrackIdentity[];
  /**
   * Loaded tracks that hold a resolvable source. Mirrors
   * `collectionPlayability` so a caller can tell "nothing here can play"
   * from the payload without converting back to `Track` first.
   */
  playable: number;
}

export type SearchLinkResult =
  | SearchLinkTrackResult
  | SearchLinkCollectionResult;

/**
 * `DetectedSource` narrowed to the two kinds a collection lookup accepts.
 *
 * TypeScript does not narrow an object type through one of its own properties
 * unless the object type is a union, so the guard in `resolveSearchLink` has
 * to be restated as a cast here. The cast is safe because the branch it sits
 * in has already returned on `kind === "track"`, and `DetectedSourceKind` is
 * exactly those three members.
 */
export type CollectionSource = DetectedSource & {
  kind: "album" | "playlist";
};

/** The collection shape every provider's extra `getPlaylist` returns. */
export interface ProviderCollection {
  id: string;
  title: string;
  description?: string;
  artworkUrl?: string;
  total?: number;
  tracks: Track[];
}

/**
 * The three provider operations a link needs, as seams so tests never touch
 * the network and so no test has to reproduce provider I/O to check routing.
 */
export interface SearchLinkDeps {
  getTrack(ref: { provider: string; id: string }): Promise<Track | null>;
  getCollection(
    source: DetectedSource,
    limit: number,
  ): Promise<ProviderCollection | null>;
  /** Cross-source candidate search. Production scopes this to YouTube. */
  searchForMatch(query: string, limit: number): Promise<Track[]>;
}

/** The extra playlist method, which sits outside the frozen `MusicProvider`. */
interface PlaylistCapable {
  getPlaylist?(
    id: string,
    pagination?: ProviderPagination,
  ): Promise<ProviderCollection>;
}

function asSearchLinkError(error: unknown): SearchLinkError {
  if (error instanceof SearchLinkError) {
    return error;
  }
  // Providers signal a missing resource by message rather than by a typed
  // not-found, so the message is matched on purpose: the worst case of a
  // miss is that a genuinely missing resource shows "unavailable" instead of
  // "not found", both of which are true and both localized at the boundary.
  if (error instanceof TrackNotFoundError || isMissingMessage(error)) {
    return new SearchLinkError("not-found", "Resource not found");
  }
  if (error instanceof ExtractorError) {
    return new SearchLinkError("unavailable", "Provider lookup failed");
  }
  return new SearchLinkError("unavailable", "Link resolution failed");
}

function isMissingMessage(error: unknown): boolean {
  return (
    error instanceof Error && /\bnot found\b/i.test(error.message)
  );
}

async function defaultGetCollection(
  source: DetectedSource,
  limit: number,
): Promise<ProviderCollection | null> {
  // Resolved through the same registry warm-up the search action uses, so a
  // cold process sees the providers `getShellProviders()` registers.
  const provider = getShellProviders().find(
    (entry) => entry.id === source.provider,
  );
  if (!provider) {
    throw new SearchLinkError("unsupported", "Provider is not registered");
  }

  if (source.kind === "album") {
    if (
      !provider.capabilities.has("albums.get") ||
      !provider.capabilities.has("albums.tracks")
    ) {
      throw new SearchLinkError(
        "unsupported",
        `Album lookup is not supported by provider "${provider.id}"`,
      );
    }
    const [album, page] = await Promise.all([
      provider.getAlbum(source.id),
      provider.getAlbumTracks(source.id, { limit, offset: 0 }),
    ]);
    return albumToCollection(album, page);
  }

  const getPlaylist = (provider as PlaylistCapable).getPlaylist;
  if (typeof getPlaylist !== "function") {
    throw new SearchLinkError(
      "unsupported",
      `Playlist lookup is not supported by provider "${provider.id}"`,
    );
  }
  const collection = await getPlaylist.call(provider, source.id, {
    limit,
    offset: 0,
  });
  return collection ?? null;
}

function albumToCollection(
  album: Album,
  page: ProviderListResult<Track>,
): ProviderCollection {
  return {
    id: album.providerAlbumId ?? album.id,
    title: album.title,
    ...(album.artwork !== undefined ? { artworkUrl: album.artwork } : {}),
    ...(page.total !== undefined ? { total: page.total } : {}),
    tracks: page.items,
  };
}

async function defaultSearchForMatch(
  query: string,
  limit: number,
): Promise<Track[]> {
  const result = await extractorManager.searchAll(query, {
    // YouTube only: the missing source on a Spotify/Deezer identity is the
    // resolvable one, and fanning out to the other catalogues would charge
    // two more providers for candidates that cannot be played.
    providers: ["youtube"],
    limit,
  });
  return result.tracks;
}

export function defaultSearchLinkDeps(): SearchLinkDeps {
  return {
    getTrack: (ref) => extractorManager.getTrack(ref),
    getCollection: defaultGetCollection,
    searchForMatch: defaultSearchForMatch,
  };
}

/** `title artist…` — the query the matcher's own scoring expects. */
function matchQuery(identity: TrackIdentity): string {
  const artists = identity.artists.map((artist) => artist.name).join(" ");
  return `${identity.title} ${artists}`.replace(/\s+/g, " ").trim();
}

/** The only source with a registered resolver (mirrors `PlayerHost`). */
function hasResolvableSource(identity: TrackIdentity): boolean {
  return identity.sources.some((source) => source.source === "youtube");
}

/**
 * Attaches a resolvable YouTube source to a non-YouTube identity, using the
 * exact pipeline unified search uses (`TrackMatcher` -> `enrichIdentity`), so
 * "the same song on two providers" means the same thing everywhere in Aurora.
 *
 * Failure is not an error: a Spotify link whose video cannot be matched still
 * resolves to a correct catalog identity, and the existing capability model
 * (`trackCapabilities` / `collectionPlayability`) already renders that as
 * catalog-only with Play disabled.
 */
async function crossSourceMatch(
  identity: TrackIdentity,
  deps: SearchLinkDeps,
  matcher: TrackMatcher,
): Promise<TrackIdentity> {
  if (hasResolvableSource(identity)) {
    return identity;
  }
  const query = matchQuery(identity);
  if (query.length === 0) {
    return identity;
  }
  let candidates: Track[];
  try {
    candidates = await deps.searchForMatch(query, LINK_MATCH_CANDIDATES);
  } catch {
    return identity;
  }
  const identities: TrackIdentity[] = [];
  for (const candidate of candidates) {
    try {
      identities.push(toTrackIdentity(candidate));
    } catch {
      // One malformed candidate never sinks the resource.
    }
  }
  if (identities.length === 0) {
    return identity;
  }
  return enrichIdentity(identity, identities, matcher);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<TrackIdentity>,
): Promise<TrackIdentity[]> {
  const out: TrackIdentity[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      out[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

function toIdentityOrNull(track: Track): TrackIdentity | null {
  try {
    return toTrackIdentity(track);
  } catch {
    return null;
  }
}

/**
 * Resolves a detected provider link to a canonical Aurora resource.
 *
 * Never touches the queue, the engine, a session or the database: reading a
 * link and mutating playback are separate acts (SPEC §18 — pasting a URL must
 * not change anything until the user picks an action).
 */
export async function resolveSearchLink(
  source: DetectedSource,
  deps: SearchLinkDeps = defaultSearchLinkDeps(),
  matcher: TrackMatcher = createTrackMatcher(),
): Promise<SearchLinkResult> {
  if (source.kind === "track") {
    return resolveTrackLink(source, deps, matcher);
  }
  return resolveCollectionLink(source as CollectionSource, deps, matcher);
}

async function resolveTrackLink(
  source: DetectedSource,
  deps: SearchLinkDeps,
  matcher: TrackMatcher,
): Promise<SearchLinkTrackResult> {
  let track: Track | null;
  try {
    track = await deps.getTrack({ provider: source.provider, id: source.id });
  } catch (error) {
    throw asSearchLinkError(error);
  }
  if (!track) {
    throw new SearchLinkError("not-found", "Track not found");
  }
  let identity: TrackIdentity;
  try {
    identity = toTrackIdentity(track);
  } catch {
    throw new SearchLinkError("unavailable", "Track could not be normalized");
  }

  // A YouTube id is already the resolvable identity: it is never searched for.
  const neededMatch = !hasResolvableSource(identity);
  const resolved = neededMatch
    ? await crossSourceMatch(identity, deps, matcher)
    : identity;
  return {
    kind: "track",
    provider: source.provider,
    resourceKind: "track",
    id: source.id,
    track: resolved,
    matched: neededMatch && hasResolvableSource(resolved),
  };
}

async function resolveCollectionLink(
  source: CollectionSource,
  deps: SearchLinkDeps,
  matcher: TrackMatcher,
): Promise<SearchLinkCollectionResult> {
  let collection: ProviderCollection | null;
  try {
    collection = await deps.getCollection(source, LINK_COLLECTION_LIMIT);
  } catch (error) {
    throw asSearchLinkError(error);
  }
  if (!collection) {
    throw new SearchLinkError("not-found", "Collection not found");
  }

  const identities: TrackIdentity[] = [];
  for (const track of collection.tracks.slice(0, LINK_COLLECTION_LIMIT)) {
    const identity = toIdentityOrNull(track);
    if (identity) {
      identities.push(identity);
    }
  }

  // Native YouTube resources are already resolvable, so they skip matching
  // entirely: pasting a YouTube playlist costs one playlist fetch and no
  // searches at all.
  const needsMatch = source.provider !== "youtube";
  let enriched = identities;
  if (needsMatch && identities.length > 0) {
    enriched = await mapWithConcurrency(
      identities,
      LINK_MATCH_CONCURRENCY,
      (identity) => crossSourceMatch(identity, deps, matcher),
    );
  }

  // Canonical dedupe AFTER matching: two catalogue entries that matched the
  // same video are one logical track, which is exactly the "Spotify Track X
  // plus its YouTube equivalent" case (SPEC §17). First occurrence wins and
  // order is preserved, so the playlist sequence is untouched.
  const deduped = dedupeCanonicalTracks(enriched);

  return {
    kind: "collection",
    provider: source.provider,
    resourceKind: source.kind,
    id: source.id,
    title: collection.title,
    ...(collection.description !== undefined
      ? { description: collection.description }
      : {}),
    ...(collection.artworkUrl !== undefined
      ? { artworkUrl: collection.artworkUrl }
      : {}),
    total: collection.total ?? deduped.kept.length,
    tracks: deduped.kept,
    playable: deduped.kept.filter(hasResolvableSource).length,
  };
}
