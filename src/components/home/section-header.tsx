import type { ReactNode } from "react";

export function SectionHeader({
  title,
  aside,
  action,
  icon,
}: {
  title: string;
  aside?: ReactNode;
  action?: ReactNode;
  /**
   * Optional leading glyph. Stitch gives every content section a small
   * icon set in a tinted disc, which is what makes a long home page
   * scannable; the disc is decorative and `aria-hidden` here because the
   * title already names the section.
   */
  icon?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span
            aria-hidden="true"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="t-section-title truncate">{title}</h2>
          {aside ? <p className="t-caption truncate">{aside}</p> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
