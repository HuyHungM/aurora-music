import type { Metadata } from "next";
import type { Album, Artist, Track, SearchHistory } from "@/lib/domain";
import { searchQuerySchema } from "@/lib/validation/schemas";
import { getPreferredProvider } from "@/lib/providers/server";
import { searchUnifiedTracksAction } from "@/app/actions/unified-search";
import { getSessionUserId } from "@/lib/dal/session";
import { listSearchHistory } from "@/lib/dal/search-history";
import { TrackList } from "@/components/tracks/track-list";
import { ArtistCard } from "@/components/artist/artist-card";
import { AlbumCard } from "@/components/album/album-card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchForm } from "./search-form";
import { SearchHistorySection } from "./search-history";
import { RecordSearch } from "./record-search";
import { identityToTrack } from "@/lib/music/identity-track";
import { MusicNoteIcon, AlertCircleIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Search" };

function getErrorMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return "Could not reach the provider.";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  const rawQuery = typeof q === "string" ? q : "";
  const parsed = searchQuerySchema.safeParse({ query: rawQuery, limit: 20, offset: 0 });
  const query = parsed.success ? parsed.data.query : "";
  const isValidQuery = parsed.success && query.length > 0;

  let tracks: Track[] = [];
  let artists: Artist[] = [];
  let albums: Album[] = [];
  let tracksError: string | null = null;
  let artistsError: string | null = null;
  let albumsError: string | null = null;
  let artistsUnsupported = false;
  let albumsUnsupported = false;

  if (isValidQuery) {
    // Tracks come from unified multi-provider search: one row per merged
    // canonical group. Artists/albums keep the existing single-provider
    // path, which UnifiedSearch does not cover.
    const unifiedResult = await searchUnifiedTracksAction(query);
    if (unifiedResult.ok && unifiedResult.result.succeeded) {
      tracks = unifiedResult.result.tracks.map(identityToTrack);
    } else {
      tracksError = unifiedResult.ok
        ? "Could not reach the providers."
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
      artistsError = getErrorMessage(artistsResult.reason);
    }

    if (albumsResult.status === "fulfilled") {
      albums = albumsResult.value.items;
    } else if (!albumsUnsupported) {
      albumsError = getErrorMessage(albumsResult.reason);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          Search
        </h1>
        <p className="text-sm text-text-muted">
          Find tracks, artists, and albums.
        </p>
      </div>

      <SearchForm defaultValue={query} />

      {isValidQuery ? <RecordSearch query={query} /> : null}

      {allFailed ? (
        <EmptyState
          icon={<AlertCircleIcon size={28} />}
          title="Search is unavailable"
          description="The catalog provider could not be reached. Try again in a moment."
        />
      ) : null}

      {!isValidQuery && history.length > 0 ? (
        <SearchHistorySection history={history} />
      ) : null}

      {!isValidQuery && history.length === 0 ? (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title="Search the catalog"
          description="Type a track, artist, or album name above to browse open music."
        />
      ) : null}

      {isValidQuery && !allFailed && totalResults === 0 ? (
        <EmptyState
          icon={<MusicNoteIcon size={28} />}
          title={<span className="block truncate max-w-xs">No results for &ldquo;{query}&rdquo;</span>}
          description="Try a different spelling or a broader term."
        />
      ) : null}

      {!allFailed && totalResults > 0 ? (
        <div className="flex flex-col gap-8">
          {tracks.length > 0 ? (
            <section aria-label="Track results">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
                Tracks
              </h2>
              <TrackList tracks={tracks} showMenu={true} />
            </section>
          ) : null}

          {tracksError && tracks.length === 0 ? (
            <CategoryError label="Tracks" message={tracksError} />
          ) : null}

          {artists.length > 0 ? (
            <section aria-label="Artist results">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
                Artists
              </h2>
              <div className="flex flex-wrap gap-3">
                {artists.map((artist) => (
                  <ArtistCard key={`${artist.provider}:${artist.id}`} artist={artist} />
                ))}
              </div>
            </section>
          ) : null}

          {artistsError && artists.length === 0 && !artistsUnsupported ? (
            <CategoryError label="Artists" message={artistsError} />
          ) : null}

          {albums.length > 0 ? (
            <section aria-label="Album results">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
                Albums
              </h2>
              <div className="flex flex-wrap gap-3">
                {albums.map((album) => (
                  <AlbumCard key={`${album.provider}:${album.id}`} album={album} />
                ))}
              </div>
            </section>
          ) : null}

          {albumsError && albums.length === 0 && !albumsUnsupported ? (
            <CategoryError label="Albums" message={albumsError} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryError({ label, message }: { label: string; message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/60 px-4 py-3 text-sm text-text-muted">
      <AlertCircleIcon size={16} className="shrink-0" />
      <span>
        <span className="font-medium text-text-secondary">{label}</span>{" "}
        unavailable — {message}
      </span>
    </div>
  );
}
