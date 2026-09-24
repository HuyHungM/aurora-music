import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-border-subtle bg-surface-1 px-6 py-12 text-center">
      {icon ? (
        <div className="text-text-muted">{icon}</div>
      ) : null}
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}