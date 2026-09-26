import { AlertCircleIcon } from "@/components/ui/icons";
import type { Locale } from "@/lib/i18n/locale";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";

/**
 * Unified-search degradation notice (Phase 37). The unified result set
 * stays intact when one catalog fails; this human-language notice says
 * results may be incomplete — never raw provider errors, statuses, or
 * HTTP details.
 */
export function SearchDegradationNotice({
  partial,
  locale = DEFAULT_LOCALE,
}: {
  partial: boolean;
  locale?: Locale;
}) {
  if (!partial) {
    return null;
  }
  const t = getT(locale);
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-2.5 text-[13px] text-text-secondary"
    >
      <AlertCircleIcon size={16} className="shrink-0 text-text-muted" />
      <span>{t("searchNotice.incomplete")}</span>
    </p>
  );
}
