export interface ProviderTrackDTO {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId?: string | null;
  albumName?: string | null;
  artworkUrl?: string | null;
  streamUrl?: string | null;
  previewUrl?: string | null;
  duration?: number | null;
  genres?: string[] | null;
  releaseDate?: string | null;
  providerUrl?: string | null;
  explicit?: boolean | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderArtistDTO {
  id: string;
  name: string;
  image?: string | null;
  bio?: string | null;
  genres?: string[] | null;
}

export interface ProviderAlbumDTO {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  artwork?: string | null;
  releaseDate?: string | null;
}

export interface ProviderListResponseDTO<T> {
  results?: T;
  total?: number | null;
  offset?: number | null;
  limit?: number | null;
  next?: string | null;
}