import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
}

/**
 * Unified empty-state system (Phase 36): every state answers
 * what is empty, why, and what to do next via one clear action.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
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
      <h3 className="t-card-title">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
