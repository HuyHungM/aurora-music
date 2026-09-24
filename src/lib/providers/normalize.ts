import type { Album, Artist, Track } from "@/lib/domain";
import type { ProviderListResult } from "./types";
import type {
  ProviderAlbumDTO,
  ProviderArtistDTO,
  ProviderTrackDTO,
} from "./dto";

export type TrackNormalizer = (dto: ProviderTrackDTO) => Track;
export type ArtistNormalizer = (dto: ProviderArtistDTO) => Artist;
export type AlbumNormalizer = (dto: ProviderAlbumDTO) => Album;

export interface ProviderNormalizers {
  track: TrackNormalizer;
  artist: ArtistNormalizer;
  album: AlbumNormalizer;
}

export function normalizeList<TDTO, TDomain>(
  items: TDTO[],
  mapper: (dto: TDTO) => TDomain,
): TDomain[] {
  return items.map(mapper);
}

export function resolveList<TDTO, TDomain>(
  result: ProviderListResult<TDTO>,
  mapper: (dto: TDTO) => TDomain,
): ProviderListResult<TDomain> {
  return {
    items: normalizeList(result.items, mapper),
    total: result.total,
    nextOffset: result.nextOffset,
  };
}