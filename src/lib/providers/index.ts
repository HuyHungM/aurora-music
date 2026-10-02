export { registerProvider, getProvider, listProviders, clearProviders } from "./registry";
export { normalizeList, resolveList } from "./normalize";
export { asExtractor, isPlayableExtractor } from "./extractor";
export type { Extractor, PlayableExtractor } from "./extractor";
export {
  detectSource,
  isSupportedInput,
  parseDeezerUrl,
  parseSpotifyUrl,
  parseYouTubeUrl,
} from "./source-detection";
export type { DetectedSource, DetectedSourceKind } from "./source-detection";
export { ExtractorManager, extractorManager } from "./extractor-manager";
export type {
  ExtractorSearchOutcome,
  ExtractorSearchStatus,
  FanoutSearchOptions,
  FanoutSearchResult,
  TrackLookupRef,
} from "./extractor-manager";

export type {
  MusicProvider,
  ProviderPagination,
  ProviderSearchQuery,
  ProviderListResult,
} from "./types";
export type {
  ProviderTrackDTO,
  ProviderArtistDTO,
  ProviderAlbumDTO,
  ProviderListResponseDTO,
} from "./dto";
export type {
  TrackNormalizer,
  ArtistNormalizer,
  AlbumNormalizer,
  ProviderNormalizers,
} from "./normalize";
export { createYouTubeProvider } from "./youtube/youtube-provider";
export type { YouTubeProvider, YouTubeProviderOptions } from "./youtube/youtube-provider";
export { createPlaybackResolver } from "../playback/resolver";
export type {
  PlaybackResolver,
  SourcePlaybackResolver,
} from "../playback/resolver";
export { createYouTubeResolver } from "./youtube/playback/youtube-resolver";
export type { YouTubeResolver } from "./youtube/playback/youtube-resolver";
export type {
  PlaybackFormatCandidate,
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "./youtube/playback/types";
export {
  ensureYouTubeProvider,
  resetYouTubeBootstrap,
} from "./youtube/bootstrap";
export type {
  YouTubeApiTransport,
  YouTubePlaylist,
} from "./youtube/types";
export { createDeezerProvider } from "./deezer/deezer-provider";
export type { DeezerProvider } from "./deezer/deezer-provider";
export {
  ensureDeezerProvider,
  resetDeezerBootstrap,
} from "./deezer/bootstrap";
export type {
  DeezerApiTransport,
  DeezerPlaylist,
} from "./deezer/types";
export { createSpotifyProvider } from "./spotify/spotify-provider";
export type { SpotifyProvider } from "./spotify/spotify-provider";
export {
  ensureSpotifyProvider,
  resetSpotifyBootstrap,
} from "./spotify/bootstrap";
export { createTokenClient } from "./spotify/auth";
export type {
  SpotifyApiTransport,
  SpotifyPlaylist,
  SpotifyTokenSource,
} from "./spotify/types";