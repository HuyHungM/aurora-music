import { Skeleton } from "@/components/ui/skeleton";

export default function SearchLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-12 w-full rounded-full" />
      <div className="flex flex-col gap-8 pt-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-16" />
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-11 w-11" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </span>
              <Skeleton className="h-3 w-8" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-16" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex w-36 flex-col items-center gap-2 rounded-lg p-3">
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-14" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-16" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex w-36 flex-col items-center gap-2 rounded-lg p-3">
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-14" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
