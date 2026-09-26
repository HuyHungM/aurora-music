"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { SearchHistory } from "@/lib/domain";
import { ClockIcon, XIcon } from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import { clearSearchHistoryAction } from "@/app/actions/search";

export function SearchHistorySection({
  history,
}: {
  history: SearchHistory[];
}) {
  const router = useRouter();
  const { t } = useLocale();
  const [isPending, startTransition] = useTransition();

  function runSearch(query: string) {
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  function clearHistory() {
    startTransition(async () => {
      await clearSearchHistoryAction();
      router.refresh();
    });
  }

  if (history.length === 0) {
    return null;
  }

  return (
    <section aria-label={t("searchHistory.title")} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-muted">
          <ClockIcon size={14} />
          {t("searchHistory.title")}
        </h2>
        <button
          type="button"
          onClick={clearHistory}
          disabled={isPending}
          aria-label={t("searchHistory.clear")}
          className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-secondary disabled:opacity-50"
        >
          <XIcon size={12} />
          {t("searchHistory.clear")}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {history.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => runSearch(item.query)}
            className="rounded-full border border-border-subtle bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
          >
            {item.query}
          </button>
        ))}
      </div>
    </section>
  );
}
