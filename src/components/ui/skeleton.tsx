import type { HTMLAttributes } from "react";

/**
 * Glass skeleton block. A translucent surface with a slow sweep in Glass
 * Mode (`glass-skeleton` in `globals.css`), the legacy opaque pulse with
 * Glass Mode off. Geometry comes from the caller; this owns only the
 * shimmer behaviour, so every loading layout keeps its 1:1 shape contract.
 */
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={`glass-skeleton animate-pulse rounded-md motion-reduce:animate-none ${className ?? ""}`}
      {...props}
    />
  );
}