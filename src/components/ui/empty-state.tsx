import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  /**
   * Which heading level the title is.
   *
   * Not cosmetic: a heading that skips a level breaks the outline a screen
   * reader navigates by, and the level depends on where the empty state sits.
   * Inside a section that already has a heading - a library's "Liked music",
   * a page's own `h2` - the title describes that section's contents, so `3` is
   * right and is the default. When the empty state IS the section (the home
   * page's "nothing played yet", "sign in to open your library"), the title is
   * that section's own heading and must be `2`, or the page reads `h1` then
   * `h3` with nothing between.
   */
  headingLevel?: 2 | 3;
}

/**
 * Unified empty-state system (Phase 36): every state answers
 * what is empty, why, and what to do next via one clear action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 3,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3";
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-1 px-6 py-12 text-center">
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-1 grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-text-secondary"
        >
          {icon}
        </div>
      ) : null}
      <Heading className="t-card-title">{title}</Heading>
      {description ? (
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
