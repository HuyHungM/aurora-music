import type { ReactNode } from "react";

export function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold tracking-tight text-text-primary">{title}</h2>
      {aside ? <span className="text-xs text-text-muted">{aside}</span> : null}
    </div>
  );
}