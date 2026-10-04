import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading geometry mirrors final content geometry 1:1 (Phase 36):
 * 44px track artwork rows, 192px entity artwork, square card art,
 * no layout shift when content populates.
 */
export function TrackListSkeleton({ rows = 5, header = false }: { rows?: number; header?: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      {header ? <Skeleton className="h-5 w-32" /> : null}
      {/*
        Row box mirrors `TrackRow`'s own row (`flex items-center gap-3
        rounded-xl px-2 py-2`, 44px `h-11 w-11` art) so rows do not shift when
        content lands. The trailing slot mirrors the row's own trailing
        control: `TrackRow` ends in an `h-11 w-11` circular Play button, so the
        skeleton ends in the same circle rather than a bare gap.
      */}
      <ul className="flex flex-col gap-0.5">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex items-center gap-3 rounded-xl px-2 py-2">
            <Skeleton className="h-11 w-11 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-1/4" />
            </span>
            {/*
              Same circle as the row's own trailing Play control
              (`h-11 w-11 … rounded-full`), so the row keeps its width when
              content lands. A bare gap here would let every row grow by 44px
              on populate.
            */}
            <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HeroSkeleton() {
  return (
    <div
      aria-busy="true"
      className="relative overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8"
    >
      <div className="grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-36 rounded-full" />
        </div>
        <Skeleton className="h-52 w-full rounded-xl md:h-52 md:w-52" />
      </div>
    </div>
  );
}

function EntityHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-border-subtle bg-surface-1 p-5 sm:flex-row sm:items-end sm:gap-6 sm:p-7">
      <Skeleton className="h-48 w-48 shrink-0 rounded-xl" />
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-10 w-28 rounded-full" />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div aria-busy="true" className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2.5 rounded-xl p-2">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function ArtistDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <EntityHeaderSkeleton />
      <TrackListSkeleton header rows={5} />
    </div>
  );
}

export function AlbumDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <EntityHeaderSkeleton />
      <TrackListSkeleton header rows={5} />
    </div>
  );
}

export function TrackDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <EntityHeaderSkeleton />
    </div>
  );
}

export function PageSkeleton({ title = true }: { title?: boolean }) {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      {title ? <Skeleton className="h-8 w-48" /> : null}
      <HeroSkeleton />
      <TrackListSkeleton header rows={5} />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <CardGridSkeleton />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <CardGridSkeleton />
      </div>
      <TrackListSkeleton header rows={3} />
    </div>
  );
}

export function LibrarySkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2.5 rounded-xl p-2">
              <Skeleton className="aspect-square w-full rounded-lg" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <TrackListSkeleton rows={3} />
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <TrackListSkeleton rows={3} />
      </div>
    </div>
  );
}

export function RadioSkeleton() {
  return (
    <div className="flex flex-col gap-6 sm:gap-10" aria-busy="true">
      {/*
        Page header mirrors `/radio`'s own header: eyebrow, title with a
        leading 26px icon, tagline capped at `max-w-2xl`, then the discovery
        start control. The title row reserves the icon slot (`h-8 w-8`) so the
        heading text lands where the real `RadioIcon + title` row sits; the
        button block mirrors the primary `h-12` CTA rather than a text line.
      */}
      <div className="flex flex-col items-start gap-3">
        <Skeleton className="h-3 w-20" />
        <span className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <Skeleton className="h-8 w-48" />
        </span>
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-12 w-40 rounded-full" />
      </div>

      {/*
        Library-artist section mirrors its real grid: `grid-cols-1` below
        `sm`, two columns above, `gap-2`, and one row per artist
        (`rounded-xl border bg-surface-1 px-4 py-3` with a trailing action).
        The old skeleton rendered three tall `rounded-2xl p-5` cards that
        matched no section on the page.
      */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </span>
              <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/*
        Recent-stations section mirrors `RecentStations`: a plain paragraph
        when empty, a `flex-col gap-2` list of `rounded-xl` rows when not. The
        skeleton stands in for the list shape (the common case once a station
        exists) with the same row box as the library rows above.
      */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <ul className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, index) => (
            <li
              key={index}
              className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3"
            >
              <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/*
        Explore section mirrors the real container exactly:
        `rounded-2xl border bg-surface-1/60 p-2` with the shared
        `TrackListSkeleton` rows (44px art, `rounded-xl` rows, trailing
        `rounded-full` Play circle) — the same rows the popular-tracks
        `TrackList` renders into the same container.
      */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
          <TrackListSkeleton rows={5} />
        </div>
      </div>
    </div>
  );
}
