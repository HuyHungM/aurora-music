import { Skeleton } from "@/components/ui/skeleton";

export function TrackListSkeleton({ rows = 5, header = false }: { rows?: number; header?: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      {header ? <Skeleton className="h-5 w-32" /> : null}
      <ul className="flex flex-col gap-0.5">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex items-center gap-3 px-2 py-2">
            <Skeleton className="h-11 w-11" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-1/4" />
            </span>
            <Skeleton className="h-3 w-8" />
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
      className="relative overflow-hidden rounded-2xl border border-border-subtle bg-surface-2/60 p-6 sm:p-8"
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Skeleton className="h-40 w-full shrink-0 rounded-xl sm:w-40" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-28 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div aria-busy="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col items-center gap-2 rounded-lg p-3">
          <Skeleton className="h-24 w-24 rounded-lg" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

export function ArtistDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Skeleton className="h-48 w-full shrink-0 rounded-xl sm:h-48 sm:w-48" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-28 rounded-full" />
        </div>
      </div>
      <TrackListSkeleton header rows={5} />
    </div>
  );
}

export function AlbumDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Skeleton className="h-48 w-full shrink-0 rounded-xl sm:h-48 sm:w-48" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-28 rounded-full" />
        </div>
      </div>
      <TrackListSkeleton header rows={5} />
    </div>
  );
}

export function TrackDetailSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <Skeleton className="h-48 w-full shrink-0 rounded-xl sm:h-48 sm:w-48" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <div className="flex gap-2">
            <Skeleton className="h-12 w-28 rounded-full" />
            <Skeleton className="h-12 w-12 rounded-full" />
          </div>
        </div>
      </div>
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
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col items-center gap-2 rounded-lg p-3">
              <Skeleton className="h-24 w-24 rounded-lg" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3 w-14" />
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
    <div className="flex flex-col gap-10" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <TrackListSkeleton rows={5} />
      </div>
    </div>
  );
}
