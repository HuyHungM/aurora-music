"use client";

import { useLocale } from "@/components/i18n/locale-provider";
import { Button } from "@/components/ui/button";

/**
 * Shared failure UI for route and root error boundaries (Phase 21).
 * Presentational only: retry invokes the passed reset, which re-renders
 * the failed segment. It never touches MusicEngine, the queue, or any
 * playback state — a UI retry is not a playback reset.
 * Chrome is fully translated (Phase 42); the message/code props arrive
 * already localized from the caller's toUserFacingError(locale) mapping.
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
  const { t } = useLocale();
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-4 px-6 py-24 text-center"
    >
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">
        {t("errors.title")}
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-text-muted">
        {t("errors.description")}
      </p>
      <p aria-live="polite" className="max-w-sm text-sm text-text-secondary">
        {message}
      </p>
      {offline ? (
        <p className="max-w-sm text-sm text-text-secondary">
          {t("errors.offlineHint")}
        </p>
      ) : null}
      {digest ? (
        <p className="text-xs text-text-muted/60">
          {t("errors.reference", { id: digest })}
        </p>
      ) : (
        <p className="text-xs text-text-muted/60">
          {t("errors.errorCode", { code })}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="button" onClick={onRetry}>
          {t("errors.tryAgain")}
        </Button>
        <Button type="button" variant="secondary" onClick={onHome}>
          {t("errors.backHome")}
        </Button>
      </div>
    </div>
  );
}
