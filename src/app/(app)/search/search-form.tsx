import { SearchIcon } from "@/components/ui/icons";

export function SearchForm({ defaultValue }: { defaultValue: string }) {
  return (
    <form action="/search" method="get" role="search" className="w-full">
      <label htmlFor="search-q" className="sr-only">
        Search tracks
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted">
          <SearchIcon size={18} />
        </span>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="Search open music by track, artist, or album"
          autoComplete="off"
          spellCheck={false}
          className="h-12 w-full rounded-full border border-border-strong bg-surface-1 pl-11 pr-4 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
      </div>
    </form>
  );
}