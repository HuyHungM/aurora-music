import type { HTMLAttributes } from "react";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-surface-2 ${className ?? ""}`}
      {...props}
    />
  );
}