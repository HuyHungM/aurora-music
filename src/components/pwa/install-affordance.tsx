"use client";

import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/i18n/locale-provider";
import { dismissInstallPromptAction } from "@/app/actions/install";
import { useInstall } from "./install-prompt";

/**
 * Install affordance (Phase 51) — RULE 32/34/64.
 *
 * Subtle, contextual, dismissible, accessible and non-blocking by
 * construction:
 *
 * - It renders `null` unless the install authority says there is something
 *   real to offer. An installed app, an already-declined visitor, and a
 *   browser that has not yet decided all produce no UI at all.
 * - There are two mutually exclusive shapes, chosen by capability, not by
 *   user-agent guesswork: a real Install button when the browser exposes
 *   `beforeinstallprompt`, and Share -> Add to Home Screen instructions when
 *   it does not (iOS). A visitor on the second platform is never shown a
 *   button that would do nothing.
 * - It is a single dismissible card, not a banner across the viewport, and it
 *   never intercepts clicks outside its own bounds.
 * - The decline is persisted through a cookie server action, so a dismissal
 *   survives navigation and reload instead of reappearing on the next route.
 *
 * Two placements share this one component and one install authority: the
 * desktop sidebar footer and, on small viewports where the sidebar does not
 * exist, a card at the top of the scrollable content. Both are in normal flow
 * rather than fixed, so the affordance can never collide with the mini
 * player, the mobile navigation, or any dialog layer (RULE 62).
 */
export function InstallPrompt({ className }: { className?: string }) {
  const { t } = useLocale();
  const { kind, visible, promptInstall, dismiss } = useInstall();
  const [pending, startDismiss] = useTransition();

  if (!visible) {
    return null;
  }

  const onDismiss = () => {
    // Hide immediately; persist in the background. The user must never wait
    // on a network round-trip for an element to disappear.
    dismiss();
    startDismiss(async () => {
      await dismissInstallPromptAction();
    });
  };

  return (
    <section
      aria-label={t("install.title")}
      className={[
        // Edge only: a banner sitting on a surface takes the luminous hairline
        // but not a fill or a second blur, both of which would compete with the
        // chrome behind it.
        "aurora-glass-edge rounded-xl border border-border-subtle bg-surface-1 p-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="text-[13px] font-semibold text-text-primary">
        {kind === "prompt" ? t("install.title") : t("install.manualTitle")}
      </p>
      <p className="mt-1 text-[12px] leading-snug text-text-muted">
        {kind === "prompt" ? t("install.description") : t("install.manualSteps")}
      </p>
      <div className="mt-2.5 flex items-center gap-1.5">
        {kind === "prompt" ? (
          <Button size="sm" onClick={promptInstall}>
            {t("install.action")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={pending}
        >
          {t("install.dismiss")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Screen-reader announcement for the installed state. Announced once, then
 * silent: an `aria-live` region that keeps re-announcing on every render
 * would make the player unusable with a screen reader.
 */
export function InstalledAnnouncement() {
  const { t } = useLocale();
  const { isInstalled } = useInstall();
  if (!isInstalled) {
    return null;
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {t("install.installed")}
    </p>
  );
}
