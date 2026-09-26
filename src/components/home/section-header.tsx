import type { ReactNode } from "react";

export function SectionHeader({
  title,
  aside,
  action,
}: {
  title: string;
  aside?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="t-section-title truncate">{title}</h2>
        {aside ? <p className="t-caption truncate">{aside}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
