import type { Album, Artist, Track } from "@/lib/domain";
import type { ProviderId } from "@/lib/domain";

export interface ProviderPagination {
  limit?: number;
  offset?: number;
}

export interface ProviderSearchQuery {
  query: string;
  limit?: number;
  offset?: number;
}

export interface ProviderListResult<T> {
  items: T[];
  total?: number;
  nextOffset?: number | null;
}

export type ProviderCapability =
  | "search.tracks"
  | "search.artists"
  | "search.albums"
  | "tracks.get"
  | "tracks.popular"
  | "tracks.featured"
  | "tracks.recommendations"
  | "albums.get"
  | "albums.tracks"
  | "artists.get"
  | "artists.tracks"
  | "stream";

export interface MusicProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly isMock?: boolean;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  searchTracks(query: ProviderSearchQuery): Promise<ProviderListResult<Track>>;
  searchArtists(query: ProviderSearchQuery): Promise<ProviderListResult<Artist>>;
  searchAlbums(query: ProviderSearchQuery): Promise<ProviderListResult<Album>>;
  getTrack(trackId: string): Promise<Track>;
  getArtist(artistId: string): Promise<Artist>;
  getAlbum(albumId: string): Promise<Album>;
  getAlbumTracks(albumId: string, pagination?: ProviderPagination): Promise<ProviderListResult<Track>>;
  getArtistTracks(artistId: string, pagination?: ProviderPagination): Promise<ProviderListResult<Track>>;
  getPopularTracks(pagination?: ProviderPagination): Promise<ProviderListResult<Track>>;
  getFeaturedTracks(pagination?: ProviderPagination): Promise<ProviderListResult<Track>>;
  getRecommendations(trackId?: string, pagination?: ProviderPagination): Promise<ProviderListResult<Track>>;
  getStreamUrl(trackId: string): Promise<string>;
}