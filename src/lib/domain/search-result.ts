import type { SourceType } from "./common";

/**
 * Unified engine-level search result.
 *
 * Shape mirrors the existing `ProviderListResult` pagination contract
 * (`items` / `total` / `nextOffset`) and adds the engine concerns:
 * the originating query and which production sources contributed.
 * Per-provider fan-out, normalization, and cross-provider deduplication
 * live above individual extractors (ExtractorManager / Phase 06+).
 */
export interface SearchResult<T> {
  items: T[];
  query: string;
  sources: SourceType[];
  total?: number;
  nextOffset?: number | null;
}

/** Creates an empty result that still records the attempted query/sources. */
export function emptySearchResult<T>(
  query: string,
  sources: SourceType[] = [],
): SearchResult<T> {
  return { items: [], query, sources: [...sources] };
}
