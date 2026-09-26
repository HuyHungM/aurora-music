import type { Metadata } from "next";
import type { Album, Artist, Track, SearchHistory } from "@/lib/domain";
import { searchQuerySchema } from "@/lib/validation/schemas";
import { getPreferredProvider, getShellProviders } from "@/lib/providers/server";
import { searchUnifiedTracksAction } from "@/app/actions/unified-search";
import { getSessionUserId } from "@/lib/dal/session";
import { listSearchHistory } from "@/lib/dal/search-history";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistCard } from "@/components/artist/artist-card";
import { AlbumCard } from "@/components/album/album-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchForm } from "./search-form";
import { SearchDegradationNotice } from "./search-notice";
import { TopResultCard } from "./top-result-card";
import { SearchHistorySection } from "./search-history";
import { RecordSearch } from "./record-search";
import { identityToTrack } from "@/lib/music/identity-track";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getRequestLocale();
  const t = getT(locale);
  const { q } = await searchParams;
  const rawQuery = typeof q === "string" ? q : "";
  const parsed = searchQuerySchema.safeParse({ query: rawQuery, limit: 20, offset: 0 });
  const query = parsed.success ? parsed.data.query : "";
  const isValidQuery = parsed.success && query.length > 0;

  let tracks: Track[] = [];
  let artists: Artist[] = [];
  let albums: Album[] = [];
  let tracksError: string | null = null;
  let tracksPartial = false;
  let artistsError: string | null = null;
  let albumsError: string | null = null;
  let artistsUnsupported = false;
  let albumsUnsupported = false;

  if (isValidQuery) {
    // Warm the lazy provider registry before anything reads it.
    //
    // `searchUnifiedTracksAction` resolves providers through
    // `extractorManager` -> `listProviders()`, which reports only what has
    // been registered, and registration happens in `getShellProviders()`.
    // `getPreferredProvider()` below warms the registry too, but it runs
    // *after* the unified track search, so on a cold process the first search
    // of a server's life saw an empty registry and reported "search
    // unavailable" with a perfectly valid provider key configured. The
    // `ensure*` calls are idempotent, so this is a no-op once warm. Same
    // contract as the playback-state resolver.
    getShellProviders();

    // Tracks come from unified multi-provider search: one row per merged
    // canonical group. Artists/albums keep the existing single-provider
    // path, which UnifiedSearch does not cover.
    const unifiedResult = await searchUnifiedTracksAction(query);
    if (unifiedResult.ok && unifiedResult.result.succeeded) {
      tracks = unifiedResult.result.tracks.map(identityToTrack);
      // One catalog may fail while others succeed: the unified set stays
      // intact and the UI notes results may be incomplete (never raw
      // provider errors).
      tracksPartial = unifiedResult.result.partial;
    } else {
      tracksError = unifiedResult.ok
        ? t("search.unavailableDescription")
        : unifiedResult.error;
    }

    const provider = getPreferredProvider();
    const queryObj = { query, limit: 20, offset: 0 };

    const hasArtistSearch = provider.capabilities.has("search.artists");
    const hasAlbumSearch = provider.capabilities.has("search.albums");

    if (!hasArtistSearch) {
      artistsUnsupported = true;
    }
    if (!hasAlbumSearch) {
      albumsUnsupported = true;
    }

    const artistPromise = hasArtistSearch
      ? provider.searchArtists(queryObj)
      : Promise.reject(new Error("unsupported"));
    const albumPromise = hasAlbumSearch
      ? provider.searchAlbums(queryObj)
      : Promise.reject(new Error("unsupported"));

    const [artistsResult, albumsResult] = await Promise.allSettled([
      artistPromise,
      albumPromise,
    ]);

    if (artistsResult.status === "fulfilled") {
      artists = artistsResult.value.items;
    } else if (!artistsUnsupported) {
      artistsError = t("search.artistsUnavailable");
    }

    if (albumsResult.status === "fulfilled") {
      albums = albumsResult.value.items;
    } else if (!albumsUnsupported) {
      albumsError = t("search.albumsUnavailable");
    }
  }

  let history: SearchHistory[] = [];
  if (!isValidQuery) {
    const userId = await getSessionUserId();
    if (userId) {
      history = await listSearchHistory(userId, 8);
    }
  }

  const totalResults = tracks.length + artists.length + albums.length;
  const allFailed =
    isValidQuery &&
    tracksError !== null &&
    (artistsUnsupported || artistsError !== null) &&
    (albumsUnsupported || albumsError !== null);

  const topTrack = tracks[0] ?? null;
  const restTracks = tracks.slice(1);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <p className="t-eyebrow">{t("search.eyebrow")}</p>
        <h1 className="t-page-title sm:text-3xl">
          {isValidQuery ? (
            <>{t("search.resultsFor", { query })} </>
          ) : (
            t("search.title")
          )}
        </h1>
        {!isValidQuery ? (
          <p className="text-sm text-text-muted">{t("search.subtitle")}</p>
        ) : null}
      </div>

      <SearchForm defaultValue={query} locale={locale} />

      {isValidQuery ? <RecordSearch query={query} /> : null}

      {isValidQuery && !allFailed ? (
        <SearchDegradationNotice partial={tracksPartial} />
      ) : null}

      {allFailed ? (
        <EmptyState
          icon={<AlertCircleIcon size={28} />}
          title={t("search.unavailableTitle")}
          description={t("search.unavailableDescription")}
        />
      ) : null}

      {!isValidQuery && history.length > 0 ? (
        <SearchHistorySection history={history} />
      ) : null}

      {!isValidQuery && history.length === 0 ? (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={t("search.emptyTitle")}
          description={t("search.emptyDescription")}
        />
      ) : null}

      {isValidQuery && !allFailed && totalResults === 0 ? (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={<span className="block break-words">{t("search.noResultsTitle", { query })}</span>}
          description={t("search.noResultsDescription")}
          action={<ButtonLink href="/search" variant="secondary" size="sm">{t("nav.browse")}</ButtonLink>}
        />
      ) : null}

      {!allFailed && totalResults > 0 ? (
        <div className="flex flex-col gap-10">
          {topTrack ? (
            <section aria-label={t("search.topResult")}>
              <h2 className="t-section-title mb-3">{t("search.topResult")}</h2>
              <TopResultCard track={topTrack} />
            </section>
          ) : null}

          {tracksError && tracks.length === 0 ? (
            <CategoryError message={tracksError} />
          ) : null}

          {restTracks.length > 0 ? (
            <section aria-label={t("search.tracksSection")}>
              <h2 className="t-section-title mb-3">{t("search.tracksSection")}</h2>
              <div className="rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
                <TrackList tracks={restTracks} showMenu={true} variant="search" />
              </div>
            </section>
          ) : null}

          {artists.length > 0 ? (
            <section aria-label={t("search.artistsSection")}>
              <h2 className="t-section-title mb-3">{t("search.artistsSection")}</h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {artists.slice(0, 8).map((artist) => (
                  <li
                    key={`${artist.provider}:${artist.providerArtistId ?? artist.id}`}
                    className="min-w-0"
                  >
                    <ArtistCard artist={artist} locale={locale} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {artistsError && artists.length === 0 && !artistsUnsupported ? (
            <CategoryError message={artistsError} />
          ) : null}

          {albums.length > 0 ? (
            <section aria-label={t("search.albumsSection")}>
              <h2 className="t-section-title mb-3">{t("search.albumsSection")}</h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {albums.slice(0, 8).map((album) => (
                  <li
                    key={`${album.provider}:${album.providerAlbumId ?? album.id}`}
                    className="min-w-0"
                  >
                    <AlbumCard album={album} locale={locale} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {albumsError && albums.length === 0 && !albumsUnsupported ? (
            <CategoryError message={albumsError} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/60 px-4 py-3 text-sm text-text-muted">
      <AlertCircleIcon size={16} className="shrink-0" />
      <span>{message}</span>
    </div>
  );
}
