"use client";

import { Button } from "@/components/ui/button";

/**
 * Shared failure UI for route and root error boundaries (Phase 21).
 * Presentational only: retry invokes the passed reset, which re-renders
 * the failed segment. It never touches MusicEngine, the queue, or any
 * playback state — a UI retry is not a playback reset.
 */
export function ErrorFallback({
  message,
  code,
  digest,
  offline,
  onRetry,
  onHome,
}: {
  /** Curated safe message (never raw error text). */
  message: string;
  /** Stable log-safe code. */
  code: string;
  /** Next.js digest when provided. */
  digest?: string;
  /** When true, show the offline hint instead of generic guidance. */
  offline?: boolean;
  onRetry: () => void;
  onHome: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-4 px-6 py-24 text-center"
    >
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">
        Something went wrong
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-text-muted">
        An unexpected error occurred while loading this page. You can try
        again, or head back to the home page.
      </p>
      <p aria-live="polite" className="max-w-sm text-sm text-text-secondary">
        {message}
      </p>
      {offline ? (
        <p className="max-w-sm text-sm text-text-secondary">
          You&apos;re offline. Check your connection — music needs internet.
        </p>
      ) : null}
      {digest ? (
        <p className="text-xs text-text-muted/60">Reference: {digest}</p>
      ) : (
        <p className="text-xs text-text-muted/60">Error code: {code}</p>
      )}
      <div className="flex gap-3">
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
        <Button type="button" variant="secondary" onClick={onHome}>
          Back to home
        </Button>
      </div>
    </div>
  );
}
