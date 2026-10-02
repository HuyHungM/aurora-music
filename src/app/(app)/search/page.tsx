import type { Metadata } from "next";
import type { Album, Artist, Track, SearchHistory } from "@/lib/domain";
import { searchQuerySchema } from "@/lib/validation/schemas";
import { classifySearchInput } from "@/lib/search/input";
import type {
  ResolveSearchLinkErrorCode,
  ResolveSearchLinkPayload,
} from "@/app/actions/resolve-search-link";
import { resolveSearchLinkAction } from "@/app/actions/resolve-search-link";
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
import { SearchPendingRelease } from "./search-pending-release";
import { LinkSearchResult } from "./link-result";
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

  // Classify BEFORE validation and before any provider call.
  //
  // Two reasons this order matters:
  //   1. `searchQuerySchema` caps the query at 200 characters, which is a
  //      bound for prose. A pasted URL is not prose, and validating it as one
  //      would reject a perfectly good link before it was ever looked at.
  //   2. Detection is free (pure string work), so a link never costs a text
  //      search. Aurora's search is submit-driven — typing issues no requests
  //      at all — so the only request a paste can reach is the one this
  //      classification routes it to.
  const searchInput = classifySearchInput(rawQuery);
  const isLinkInput = searchInput.kind !== "query";
  /** The idle page (history / empty prompt) — never shown for a link. */
  const showIdleState = !isLinkInput;

  const parsed = isLinkInput
    ? null
    : searchQuerySchema.safeParse({ query: rawQuery, limit: 20, offset: 0 });
  const query = parsed?.success ? parsed.data.query : "";
  const isValidQuery = !isLinkInput && parsed?.success === true && query.length > 0;

  let linkResult: ResolveSearchLinkPayload | null = null;
  let linkError: string | null = null;
  let linkUnsupported: "unsupported-host" | "malformed" | null = null;

  if (searchInput.kind === "unsupported-url") {
    linkUnsupported = searchInput.reason;
  } else if (searchInput.kind === "source") {
    // Warm the lazy provider registry before anything reads it; the same
    // cold-process contract as the unified search below.
    getShellProviders();
    const resolved = await resolveSearchLinkAction(rawQuery);
    if (resolved.ok) {
      linkResult = resolved.result;
    } else {
      linkError = linkFailureMessage(resolved, t);
    }
  }

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

    // Tracks (unified multi-provider fan-out), artists and albums are three
    // INDEPENDENT searches. They used to run as two sequential phases - the
    // unified track search first, then artists/albums together - so the page
    // waited for their SUM. Firing all three together makes it wait for the
    // SLOWEST instead. Result semantics are unchanged: each branch below
    // resolves exactly the same value it would have with the old awaits.
    const [unifiedSettled, artistsResult, albumsResult] = await Promise.allSettled([
      searchUnifiedTracksAction(query),
      hasArtistSearch
        ? provider.searchArtists(queryObj)
        : Promise.reject(new Error("unsupported")),
      hasAlbumSearch
        ? provider.searchAlbums(queryObj)
        : Promise.reject(new Error("unsupported")),
    ]);

    if (unifiedSettled.status === "fulfilled") {
      const unifiedResult = unifiedSettled.value;
      if (unifiedResult.ok && unifiedResult.result.succeeded) {
        // One catalog may fail while others succeed: the unified set stays
        // intact and the UI notes results may be incomplete (never raw
        // provider errors).
        tracks = unifiedResult.result.tracks.map(identityToTrack);
        tracksPartial = unifiedResult.result.partial;
      } else {
        tracksError = unifiedResult.ok
          ? t("search.unavailableDescription")
          : unifiedResult.error;
      }
    } else {
      tracksError = t("search.unavailableDescription");
    }

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
  if (showIdleState && !isValidQuery) {
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
          ) : linkResult ? (
            <span className="block break-words">
              {linkResult.resource.kind === "track"
                ? linkResult.resource.track.title
                : linkResult.resource.title}
            </span>
          ) : linkUnsupported ? (
            <>{t("search.linkUnsupportedTitle")}</>
          ) : linkError !== null ? (
            <>{t("search.linkErrorTitle")}</>
          ) : (
            t("search.title")
          )}
        </h1>
        {showIdleState && !isValidQuery ? (
          <p className="text-sm text-text-muted">{t("search.subtitle")}</p>
        ) : null}
      </div>

      <SearchForm
        defaultValue={isValidQuery ? query : isLinkInput ? rawQuery.trim() : ""}
        locale={locale}
      />

      {/* Releases the search lock: this page rendering at all means the request was
          answered. Rendered on EVERY outcome — results, an empty result set, an
          error, a resolved link, and the idle route an empty query submits to —
          because each of those is a settled request. The field that opened the
          lock lives in the layout and cannot observe this page arriving. It
          renders nothing, so the layout the skeleton matches is untouched. */}
      <SearchPendingRelease />

      {isValidQuery ? <RecordSearch query={query} /> : null}
      {!isValidQuery && linkResult ? (
        <RecordSearch query={linkResult.canonicalUrl} />
      ) : null}

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

      {/* A pasted provider link renders its own body and never the text
          search results: the classification above already decided which
          one of the two this request is. */}
      {linkResult ? <LinkSearchResult resource={linkResult.resource} /> : null}

      {linkUnsupported ? (
        <CategoryError
          message={t(
            linkUnsupported === "unsupported-host"
              ? "search.linkUnsupported"
              : "search.linkUnreadable",
          )}
        />
      ) : null}

      {linkError !== null ? <CategoryError message={linkError} /> : null}

      {showIdleState && !isValidQuery && history.length > 0 ? (
        <SearchHistorySection history={history} />
      ) : null}

      {showIdleState && !isValidQuery && history.length === 0 ? (
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

/**
 * A link failure to user-facing copy.
 *
 * Only a code comes back from the action, so this is the single place a
 * provider's raw error text could have leaked — and it does not: every
 * recognized code is localized here, and the fallback is the action's own
 * neutral message (or the rate-limiter's truthful one), never a provider
 * message naming an endpoint, a host or a status.
 */
function linkFailureMessage(
  failure: { error: string; linkError?: ResolveSearchLinkErrorCode },
  t: ReturnType<typeof getT>,
): string {
  switch (failure.linkError) {
    case "not-found":
      return t("search.linkNotFound");
    case "unsupported":
    case "unsupported-input":
      return t("search.linkUnsupported");
    case "unavailable":
      return t("search.linkUnavailable");
    default:
      return failure.error;
  }
}
