"use client";

import { AutoplayButton } from "@/components/player/autoplay-button";
import { useKeepListening } from "@/lib/listening/use-keep-listening";
import { useLocale } from "@/components/i18n/locale-provider";

/**
 * Autoplay, as it appears in the queue panel.
 *
 * The queue panel is the surface that can EXPLAIN the feature — it is where a
 * listener opens the queue, so it is the one place worth spending two lines of
 * text on "this adds music when the list runs low". The control itself is the
 * shared `AutoplayButton`, byte for byte the one in the player, so the queue
 * panel gets the same icon, the same active treatment and the same wording for
 * free rather than by convention.
 *
 * The label here is plain text, not a second control. When the icon was
 * decorative text next to a switch pill, the row had two interactive-looking
 * halves and no way to tell which one you had to press. Now there is exactly
 * one thing in the row you can press, and it is the same thing you press in
 * the player.
 */
export function KeepListeningToggle() {
  const { t } = useLocale();
  const { available, status, save } = useKeepListening();

  if (!available) {
    return null;
  }

  return (
    <div className="border-b border-border-subtle px-4 py-2.5">
      <div className="flex items-center gap-1">
        <AutoplayButton size={20} className="-ml-2.5 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-text-primary">
            {t("keepListening.label")}
          </span>
          <span className="truncate text-[11px] leading-relaxed text-text-muted">
            {status.generating
              ? t("keepListening.generating")
              : status.enabled
                ? t("keepListening.description")
                : t("keepListening.descriptionOff")}
          </span>
        </div>
        {/* The state is spelled out as well as coloured, because the icon's
            active treatment is the only thing a greyscale or high-contrast
            reader would otherwise have to go on. */}
        <span
          className={`ml-auto shrink-0 text-[11px] font-medium ${
            status.enabled ? "text-accent" : "text-text-muted"
          }`}
        >
          {status.enabled ? t("keepListening.on") : t("keepListening.off")}
        </span>
      </div>
      {save.error ? (
        <p role="alert" className="mt-1.5 text-[11px] text-red-400">
          {t(save.error)}
        </p>
      ) : null}
    </div>
  );
}
