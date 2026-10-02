export { LOCAL_SOURCE_TYPE } from "./common";
export type { ProviderId, SourceType, TrackRef } from "./common";
export type { Track } from "./track";
export type { Artist } from "./artist";
export type { Album } from "./album";
export type {
  Playlist,
  PlaylistItem,
  PlaylistVisibility,
  SharedPlaylist,
} from "./playlist";
export type { User } from "./user";
export type { Like } from "./like";
export type { Follow } from "./follow";
export type { RecentlyPlayed } from "./recently-played";
export type { SearchHistory } from "./search-history";
export type { Artwork, ArtworkSize } from "./artwork";
export { hasArtwork, resolveArtworkUrl } from "./artwork";
export type { AudioSource, SerializedAudioSource } from "./audio-source";
export {
  isAudioSourceExpired,
  parseAudioSource,
  serializeAudioSource,
} from "./audio-source";
export type { SearchResult } from "./search-result";
export { emptySearchResult } from "./search-result";
export type {
  SourceReference,
  SourceReferenceMetadata,
} from "./source-reference";
export {
  fromTrackRef,
  isProviderSourceType,
  isSourceType,
  sourceReferenceKey,
  toTrackRef,
} from "./source-reference";
export type { TrackIdentity } from "./track-identity";
export { findSourceReference, identityKeys, primaryTrackRef } from "./track-identity";
export type {
  CanonicalSearchInput,
  ToIdentityOptions,
} from "./track-normalizer";
export {
  generateIdentityId,
  isValidTrackIdentity,
  mergeSourceReference,
  toCanonicalSearchResult,
  toTrackIdentity,
  trackToSourceReference,
} from "./track-normalizer";
export type {
  MatchClassification,
  MatchEvidence,
  MatchEvidenceResult,
  MatchRejectionReason,
  MatchSignal,
  RankedCandidate,
  TrackMatchResult,
  TrackMatcher,
} from "./track-matcher";
export {
  AUTO_MERGE_CLASSIFICATIONS,
  DURATION_CLOSE_MS,
  DURATION_CLOSE_REL_CAP_MS,
  DURATION_CLOSE_REL_RATIO,
  DURATION_HARD_REJECT_MS,
  DURATION_LARGE_MS,
  DURATION_STRONG_MS,
  MATCH_THRESHOLD_EXACT,
  MATCH_THRESHOLD_POSSIBLE,
  MATCH_THRESHOLD_STRONG,
  SCORE_SAME_SOURCE,
  WEIGHT_ALBUM_DIFFERENT,
  WEIGHT_ALBUM_SAME,
  WEIGHT_ARTISTS_CONFLICT,
  WEIGHT_ARTISTS_FULL,
  WEIGHT_ARTISTS_PARTIAL,
  WEIGHT_DURATION_CLOSE,
  WEIGHT_DURATION_LARGE,
  WEIGHT_DURATION_MODERATE,
  WEIGHT_DURATION_STRONG,
  WEIGHT_EXPLICIT_MISMATCH,
  WEIGHT_ISRC_CONFLICT,
  WEIGHT_ISRC_EXACT,
  WEIGHT_REMASTER_ASYMMETRY,
  WEIGHT_TITLE_CLOSE,
  WEIGHT_TITLE_EXACT,
  WEIGHT_TITLE_MISMATCH,
  WEIGHT_UNKNOWN_MARKER_ASYMMETRY,
  WEIGHT_VERSION_SAME,
  createTrackMatcher,
  findBestMatch,
  isAutoMergeable,
  rankMatches,
} from "./track-matcher";
export type {
  CanonicalDuplicate,
  CanonicalDuplicateOptions,
  CanonicalTrackLike,
  DuplicateReason,
} from "./track-dedupe";
export {
  CanonicalDuplicateIndex,
  canonicalIdentityOf,
  canonicalTrackKeys,
  dedupeCanonicalTracks,
  findCanonicalDuplicate,
} from "./track-dedupe";
export type { ParsedTitle, VersionComparison, VersionKind } from "./match-text";
export {
  DISTINCT_VERSION_KINDS,
  compareVersions,
  foldAsciiComparison,
  foldDiacritics,
  identityIsrcs,
  normalizeArtistName,
  normalizeBase,
  normalizeIsrc,
  parseTitleVersion,
  tokenOverlap,
  tokenize,
} from "./match-text";
export type {
  EngineErrorCode,
  PlaybackResolutionStage,
  SerializedEngineError,
} from "./errors";
export {
  EngineError,
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  QueueError,
  TrackMatchError,
  TrackNotFoundError,
  isEngineError,
  serializeEngineError,
} from "./errors";