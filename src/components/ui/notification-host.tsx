"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import { usePresence } from "@/components/ui/presence";
import {
  AlertCircleIcon,
  CheckIcon,
  InfoIcon,
  XIcon,
} from "@/components/ui/icons";
import {
  notificationAction,
  notificationDurationMs,
  removeNotification,
  useNotifications,
  type NotificationItem,
  type NotificationKind,
} from "@/components/ui/notifications";

/**
 * The one notification host. Mounted once, in the application shell, so any
 * feature can `notifyNotification()` without rendering its own container.
 *
 * POSITION. Top-right, viewport-anchored (`fixed`), clear of the notch and
 * the header: below the shell chrome rather than over it, and inside the
 * left/right safe-area insets. `z-toast` is the top of the semantic layer
 * stack — above dialogs — because a toast reports on something that already
 * happened; it never takes part in the interaction it confirms.
 *
 * MOTION. One vocabulary: fade with a whisper of scale (`presence-pop`),
 * 220ms in / 140ms out, `prefers-reduced-motion` collapsing to ~0 in CSS
 * while the timers still fire. No slide, no spring: a toast that travels
 * reads as navigation, and this one reports that navigation already ended.
 *
 * SEMANTICS — WHY THE LIVE REGIONS ARE NOT THE TOASTS. There are two
 * PERSISTENT regions, mounted empty from first paint, and the toasts are
 * ordinary visible containers. The previous arrangement gave each toast its own
 * `role="status"`/`role="alert"`, but those regions were inserted into the DOM
 * together with their text — and a live region that appears already populated is
 * commonly not announced at all (NVDA and JAWS both behave this way), so most
 * toasts were silent. A region has to exist BEFORE its content changes. This is
 * the same shape `install-affordance.tsx` and `search-field.tsx` already use.
 *
 * The toast also carried `aria-label={item.title}`, which made the title the
 * live region's accessible name and put the `message` line at risk of being
 * skipped. Dropped: the regions announce the joined title and message, and the
 * card's own subtree is left to speak for itself when a screen reader navigates
 * into it.
 *
 * Politeness is unchanged and asymmetric on purpose: one polite region for
 * success/info/warning, one assertive for errors, never assertive for anything
 * else. No focus trap: toasts never take focus, and Tab passes through them to
 * the page.
 */

/** Joins the parts a screen reader should hear, skipping absent ones. */
function announceText(item: NotificationItem | undefined): string {
  if (!item) return "";
  return [item.title, item.message].filter(Boolean).join(". ");
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  if (kind === "success") {
    return <CheckIcon size={18} className="shrink-0 text-success" />;
  }
  if (kind === "error") {
    return <AlertCircleIcon size={18} className="shrink-0 text-danger" />;
  }
  if (kind === "warning") {
    return <AlertCircleIcon size={18} className="shrink-0 text-warning" />;
  }
  return <InfoIcon size={18} className="shrink-0 text-info" />;
}

function NotificationToast({
  item,
  closing,
}: {
  item: Omit<NotificationItem, "action"> & { actionLabel?: string };
  closing: boolean;
}) {
  const { t } = useLocale();
  // `dismissed` is the toast's OWN decision to leave (manual close or its
  // timer firing); `closing` is the store's (eviction, or another caller
  // dismissing the same id). Either one closes the toast. Derived during
  // render rather than synced in an effect — the same "adjust state when
  // props change" pattern `usePresence` documents — so no cascading render.
  const [dismissed, setDismissed] = useState(false);
  // A repost of the same id replaces the entry object (while unrelated posts
  // keep their references), so a new object here means "a new confirmation
  // arrived". Reopen it: without this, a manual dismiss followed by a second
  // copy would inherit `dismissed: true` and vanish on arrival, and its
  // timer would never re-arm. Same render-adjust pattern as above.
  const [prevItem, setPrevItem] = useState(item);
  if (prevItem !== item) {
    setPrevItem(item);
    setDismissed(false);
  }
  const open = !dismissed && !closing;
  const { mounted, presenceProps } = usePresence(open, {
    onExited: () => removeNotification(item.id),
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss, armed once per toast identity. `durationMs: 0` means
  // persistent — the toast stays until manually dismissed. Unmount clears
  // the timer, so a dismissed toast cannot leave a pending callback behind.
  //
  // Dep is the whole `item` object, not `item.id`: the store replaces the
  // entry object on every repost of the same id (while unrelated posts keep
  // existing references), so a repost re-arms the timer and a new post for
  // another id does not. A second copy extends the confirmation; without
  // this the second copy would vanish on the first copy's schedule.
  useEffect(() => {
    const ms = notificationDurationMs(item);
    if (ms <= 0) {
      return;
    }
    timerRef.current = setTimeout(() => {
      setDismissed(true);
    }, ms);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [item]);

  if (!mounted) {
    return null;
  }

  const action = notificationAction(item);

  return (
    <div
      role="group"
      aria-label={item.title}
      data-kind={item.kind}
      data-notification-id={item.id}
      {...presenceProps}
      className="presence-pop aurora-glass-float pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-border-subtle p-3"
    >
      <span aria-hidden="true" className="mt-0.5">
        <KindIcon kind={item.kind} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-text-primary">
          {item.title}
        </span>
        {item.message ? (
          <span className="break-words text-sm leading-relaxed text-text-secondary">
            {item.message}
          </span>
        ) : null}
        {action ? (
          <span className="mt-1">
            <button
              type="button"
              onClick={() => action.onSelect()}
              className="aurora-touch cursor-pointer rounded-full border border-border-strong px-3 py-1 text-xs font-medium text-text-primary select-none transition-colors hover:border-accent/50"
            >
              {action.label}
            </button>
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t("common.close")}
        className="aurora-touch grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted select-none transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

export function NotificationHost() {
  const items = useNotifications((state) => state.items);
  const closing = useNotifications((state) => state.closing);

  // Newest of each politeness, so a burst replaces the pending announcement
  // rather than queueing every one of them.
  const polite = announceText(items.find((item) => item.kind !== "error"));
  const assertive = announceText(items.find((item) => item.kind === "error"));

  return (
    <>
      {/* Mounted from first paint and empty on purpose — see the file header. */}
      <div role="status" aria-live="polite" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" className="sr-only">
        {assertive}
      </div>
      {items.length === 0 ? null : (
    <div className="pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))] z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {items.map((item) => (
        <NotificationToast
          key={item.id}
          item={item}
          closing={closing.includes(item.id)}
        />
      ))}
    </div>
      )}
    </>
  );
}
