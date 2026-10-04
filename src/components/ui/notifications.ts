"use client";

import { create } from "zustand";

/**
 * The one global notification store (toast system).
 *
 * Every fire-and-forget confirmation in the app posts here, and the single
 * `NotificationHost` in the application shell renders them. A feature never
 * renders its own floating container: it calls `notifyNotification()` (or
 * `useNotification().notify()`) with caller-resolved strings (the SearchForm
 * pattern), so the store stays locale-free.
 *
 * Two floating confirmations for one action is the failure mode. Anything
 * that already reports in a floating/persistent surface must NOT also notify.
 * A control's OWN transient label (the share dialog's "Link copied" button,
 * a toggle flipping) is not a second surface — it is the control reporting
 * its own state at the point of action — and a toast that survives the
 * control (the dialog can close, the label resets in 2.4s) is what carries
 * the confirmation past it.
 *
 * Shape mirrors `@/lib/search/search-pending`: a zustand store with no
 * context, no provider, and no subscription cost for components that never
 * read it. Only `NotificationHost` subscribes; posting via `getState()`
 * rerenders nothing else.
 *
 * Implemented callers (Phase 24): playlist share-link copy
 * (`playlist-share-copied:<playlistId>`). Copy failures stay inline
 * (`copyError`) and never post a success toast.
 */

export type NotificationKind = "success" | "error" | "warning" | "info";

export interface NotificationAction {
  /** Resolved label, e.g. t("playlistShare.copyLink"). */
  label: string;
  /** Runs on activation; dismissal is the host's job, not the action's. */
  onSelect: () => void;
}

export interface NotificationItem {
  /** Stable identity. Repeat posts with the same id replace, never stack. */
  id: string;
  kind: NotificationKind;
  /** Resolved title, e.g. t("playlistShare.linkCopied"). */
  title: string;
  /** Optional resolved detail line. */
  message?: string;
  /** Optional single action (Retry, View, Copy again). */
  action?: NotificationAction;
  /**
   * How long the toast stays before auto-dismiss, in ms.
   * `0` means persistent until manually dismissed. Defaults per kind.
   */
  durationMs?: number;
}

/**
 * What the store actually keeps. `onSelect` cannot live in zustand state:
 * the devtools/state serializer walks stored values, and a function inside
 * `items` would silently vanish (or warn) once anything subscribes to the
 * raw entry. So the store records only the serializable half; the action
 * callback lives in a module-level side table keyed by the same stable id.
 */
interface StoredNotification extends Omit<NotificationItem, "action"> {
  actionLabel?: string;
}

/** Action callbacks, by notification id. Module-level, never in the store. */
const actionHandlers = new Map<string, () => void>();

/** Resolve the live action (if any) for a stored entry. */
export function notificationAction(
  entry: Pick<StoredNotification, "id" | "actionLabel">,
): NotificationAction | undefined {
  if (!entry.actionLabel) {
    return undefined;
  }
  const handler = actionHandlers.get(entry.id);
  if (!handler) {
    return undefined;
  }
  return {
    label: entry.actionLabel,
    onSelect: () => handler(),
  };
}

interface NotificationState {
  /** All toasts, including ones currently exiting. Host renders the union. */
  items: readonly StoredNotification[];
  /**
   * Ids currently exiting. A dismissal, a `clear()`-via-dismiss, or the
   * oldest entry being evicted must all ANIMATE, not vanish: removing the
   * entry immediately would unmount the node on the same render and leave
   * nothing to animate (the exact failure `usePresence` exists for). So
   * `dismiss()` only marks closing; the toast flips its local `open`, exits,
   * and its own `onExited` calls `remove()` after the exit. Idempotent.
   */
  closing: readonly string[];
  notify: (item: NotificationItem) => void;
  /** Graceful: mark closing, animate, then remove via `onExited`. */
  dismiss: (id: string) => void;
  /** Immediate: drop now, skipping the exit. For `onExited` and test reset. */
  remove: (id: string) => void;
  /** Immediate: drop everything. For test reset, not for user dismissal. */
  clear: () => void;
}

/** Open cap. Past it, the oldest open toast starts exiting. */
export const NOTIFICATION_MAX_VISIBLE = 4;

/**
 * Total cap, so a spam loop cannot grow the DOM without bound. Open toasts
 * plus their exiting shadows never exceed this: past it, the oldest shadow
 * is dropped immediately (it is already mostly gone). Exits finish in 140ms,
 * so in practice this only binds during a burst.
 */
export const NOTIFICATION_MAX_TOTAL = NOTIFICATION_MAX_VISIBLE + 2;

const DEFAULT_DURATION_MS: Record<NotificationKind, number> = {
  success: 4_000,
  error: 8_000,
  warning: 6_000,
  info: 5_000,
};

export function notificationDurationMs(
  item: Pick<NotificationItem, "kind" | "durationMs">,
): number {
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs)) {
    return Math.max(0, Math.floor(item.durationMs));
  }
  return DEFAULT_DURATION_MS[item.kind];
}

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  closing: [],
  notify: (item) =>
    set((state) => {
      // Side effects live OUTSIDE `set`: zustand runs this updater twice in
      // dev (StrictMode-style double-invoke to surface impure reducers), so
      // parking the callback here would register it twice and — worse —
      // deleting here would drop a handler the second pass still needs.
      const stored: StoredNotification = {
        id: item.id,
        kind: item.kind,
        title: item.title,
        ...(item.message !== undefined ? { message: item.message } : {}),
        ...(item.action ? { actionLabel: item.action.label } : {}),
        ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      };
      // Same id replaces and reopens: a retry that succeeds must not leave
      // its own exiting shadow behind, and must not stack a duplicate.
      const rest = state.items.filter((entry) => entry.id !== item.id);
      const closing = state.closing.filter((id) => id !== item.id);
      let items: StoredNotification[] = [...rest, stored];
      let nextClosing = closing;

      // Enforce the open cap gracefully: the oldest OPEN toast starts
      // exiting, it is not dropped. Closing shadows don't count toward it.
      const openCount = items.length - nextClosing.length;
      if (openCount > NOTIFICATION_MAX_VISIBLE) {
        const excess = openCount - NOTIFICATION_MAX_VISIBLE;
        const oldestOpen = items
          .filter((entry) => !nextClosing.includes(entry.id))
          .slice(0, excess)
          .map((entry) => entry.id);
        nextClosing = [...nextClosing, ...oldestOpen];
      }

      // Enforce the total cap immediately: drop the oldest shadows first,
      // then — only in a burst with no shadows — the oldest open entry.
      // Dropping a shadow skips the tail of an exit that already started;
      // dropping an open entry skips its exit entirely, which is the price
      // of bounding a spam loop.
      if (items.length > NOTIFICATION_MAX_TOTAL) {
        const drop = items.length - NOTIFICATION_MAX_TOTAL;
        const shadows = items
          .filter((entry) => nextClosing.includes(entry.id))
          .slice(0, drop)
          .map((entry) => entry.id);
        const remaining = drop - shadows.length;
        const forced =
          remaining > 0
            ? items
                .filter(
                  (entry) =>
                    !nextClosing.includes(entry.id) && !shadows.includes(entry.id),
                )
                .slice(0, remaining)
                .map((entry) => entry.id)
            : [];
        const dropped = new Set([...shadows, ...forced]);
        // Owned by the store: cap-dropped entries never reach `remove()`,
        // so their handlers are released here rather than there.
        for (const id of dropped) {
          actionHandlers.delete(id);
        }
        items = items.filter((entry) => !dropped.has(entry.id));
        nextClosing = nextClosing.filter((id) => !dropped.has(id));
      }

      return { items, closing: nextClosing };
    }),
  dismiss: (id) =>
    set((state) => {
      if (!state.items.some((entry) => entry.id === id)) {
        return {};
      }
      if (state.closing.includes(id)) {
        return {};
      }
      return { closing: [...state.closing, id] };
    }),
  remove: (id) =>
    set((state) => {
      if (
        !state.items.some((entry) => entry.id === id) &&
        !state.closing.includes(id)
      ) {
        return {};
      }
      actionHandlers.delete(id);
      return {
        items: state.items.filter((entry) => entry.id !== id),
        closing: state.closing.filter((entry) => entry !== id),
      };
    }),
  clear: () => {
    actionHandlers.clear();
    useNotifications.setState({ items: [], closing: [] });
  },
}));

/** Fire-and-forget post from anywhere, including outside React. */
export function notifyNotification(item: NotificationItem): void {
  // Parked OUTSIDE the store updater (see `notify` above): the updater may
  // run twice in dev, and `set` must stay a pure function of (state, item).
  // Ordering matters — park before `notify` so a same-tick subscriber never
  // observes the entry without its handler. A repost without an action
  // replaces the entry AND drops the stale handler, so "Retry, then success"
  // cannot leave a dead Retry behind.
  if (item.action) {
    actionHandlers.set(item.id, item.action.onSelect);
  } else {
    actionHandlers.delete(item.id);
  }
  useNotifications.getState().notify(item);
}

/**
 * Graceful dismissal: animate out, then remove. Safe to call for an id that
 * already left. Requires the host to complete — the toast's own `onExited`
 * performs the removal — so tests that never mount the host should use
 * `removeNotification`/`clearNotifications` for reset instead.
 */
export function dismissNotification(id: string): void {
  useNotifications.getState().dismiss(id);
}

/** Immediate removal, skipping the exit. For `onExited` and test reset. */
export function removeNotification(id: string): void {
  useNotifications.getState().remove(id);
}

/** Immediate reset of the whole store. For tests, not for user dismissal. */
export function clearNotifications(): void {
  useNotifications.getState().clear();
}

/**
 * React-component API. `const { notify } = useNotification();` then
 * `notify({ kind: "success", id, title })`.
 *
 * The functions are the module-level `notifyNotification` /
 * `dismissNotification` / `clearNotifications` themselves — stable across
 * renders and subscription-free, so reading them never rerenders. (An early
 * draft selected `state.notify` instead, which bypassed the action side
 * table and silently dropped every action callback posted through the hook.)
 */
export function useNotification(): {
  notify: (item: NotificationItem) => void;
  dismiss: (id: string) => void;
  clear: () => void;
} {
  return {
    notify: notifyNotification,
    dismiss: dismissNotification,
    clear: clearNotifications,
  };
}
