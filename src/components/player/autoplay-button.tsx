"use client";

import { AutoContinueIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/i18n/locale-provider";
import { useKeepListening } from "@/lib/listening/use-keep-listening";

/**
 * THE autoplay control.
 *
 * One component, rendered on every surface that offers autoplay, so the player
 * and the queue panel cannot end up with two icons, two active colours or two
 * sets of wording for one feature. The alternative — the same button written
 * out per surface — is exactly the failure this file exists to prevent.
 *
 * Semantics: a plain button with `aria-pressed`, deliberately matching the
 * shuffle and repeat buttons it sits beside. A `role="switch"` was arguably the
 * richer choice in the abstract, but autoplay is a member of the transport row,
 * and one row should speak one language — otherwise a listener moving along it
 * meets two different control types for two buttons that do the same kind of
 * thing.
 *
 * The accessible name states the ACTION ("Turn autoplay on"), the tooltip
 * states the STATE ("Autoplay: On"). A single static "Autoplay" label would
 * tell a screen-reader user the control exists and nothing about what it does
 * now. `title` is this project's existing tooltip mechanism (a dozen other
 * surfaces use it) — adding a tooltip library for one icon would be a new
 * dependency for no new information, since `aria-label` already carries the
 * action for assistive tech.
 */
export function AutoplayButton({
  size = 20,
  className,
}: {
  /** Icon px. Defaults to the size the queue and volume buttons use. */
  size?: number;
  className?: string;
}) {
  const { t } = useLocale();
  const { available, status, save, toggle } = useKeepListening();

  // No coordinator yet (PlayerHost's effect has not run), or an anonymous
  // listener. Nothing to render rather than a control that cannot save.
  if (!available) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      // `relative` anchors the generating badge; `shrink-0` guarantees the
      // declared 44px target survives a tight flex row rather than being
      // quietly squeezed below the accessibility floor; `aurora-press` is the
      // project's existing press feedback and is declared only under
      // `prefers-reduced-motion: no-preference`, so it costs a reduced-motion
      // visitor nothing. `transition-[color,box-shadow]` animates the colour
      // and the active ring; the global reduced-motion rule collapses the
      // duration, so the state change is still reported, just instantly.
      className={[
        "relative h-11 w-11 shrink-0 aurora-press transition-[color,box-shadow] disabled:opacity-60",
        // Active state is a SHAPE change (an accent ring) as well as a colour
        // change, so it survives a greyscale render and a future light theme,
        // where an accent tint alone would be close to invisible. No
        // background is set here on purpose: `Button`'s ghost variant owns
        // `hover:bg-surface-2`, and a competing `bg-*` would lose to it
        // unpredictably on hover.
        status.enabled ? "text-accent ring-2 ring-accent/50" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={status.enabled ? t("keepListening.turnOff") : t("keepListening.turnOn")}
      aria-pressed={status.enabled}
      aria-busy={status.generating || undefined}
      title={status.enabled ? t("keepListening.stateOn") : t("keepListening.stateOff")}
      disabled={save.pending}
      onClick={() => void toggle()}
    >
      <AutoContinueIcon size={size} />
      {status.generating ? (
        // A badge in the corner, not a replacement for the icon. The icon must
        // stay on screen so the control does not appear to change identity,
        // and the badge must not read as audio buffering — it means the queue
        // is being topped up, not that a track is loading. It is bounded by
        // the coordinator releasing its generating latch on every path.
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-spin rounded-full border-2 border-text-muted border-t-transparent"
        />
      ) : null}
    </Button>
  );
}
