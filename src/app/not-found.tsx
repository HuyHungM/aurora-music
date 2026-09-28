import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found" };

/**
 * Root not-found boundary (Phase 29). Paths that match no route segment
 * never enter the `(app)` group, so the group-level `not-found.tsx`
 * cannot apply; without this file Next.js falls back to its default
 * 404 page with no Aurora navigation. Mirrors the `(app)` boundary
 * exactly — same heading, same copy, same recovery action.
 */
export default function RootNotFound() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <div className="aurora-glass-edge flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border-subtle bg-surface-1/60 px-6 py-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <p className="text-xs uppercase tracking-wide text-text-muted">404</p>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Page not found</h1>
        <p className="max-w-sm text-sm leading-relaxed text-text-muted">
          The page you were looking for doesn&apos;t exist or has moved.
        </p>
        <ButtonLink href="/" variant="secondary">
          Back to home
        </ButtonLink>
      </div>
    </div>
  );
}
