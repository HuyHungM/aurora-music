"use client";

import { useCallback, useSyncExternalStore } from "react";
import { setKeepListeningAction } from "@/app/actions/listening";
import {
  getKeepListeningCoordinator,
  subscribeKeepListeningCoordinator,
} from "@/lib/listening/instance";
import type { KeepListeningStatus } from "@/lib/listening/coordinator";

/**
 * The ONE binding between the autoplay runtime state and the autoplay UI.
 *
 * The control is rendered on more than one surface (the player and the queue
 * panel), so the binding cannot live inside the control component: the second
 * surface would be free to disagree, and — as the first cut of this file
 * proved — a per-caller `useState` for the save result means the surface that
 * rendered the error is not the surface that performed the write. Both halves
 * of the binding are therefore module-level singletons, and every caller reads
 * the same objects.
 *
 * The icon is required to show what the coordinator is actually doing, so
 * `status` must be the coordinator's own state and nothing else — no local
 * mirror to fall out of step, and no second source to reconcile.
 */

/** The state an unauthenticated / not-yet-mounted listener resolves to. */
const OFF_STATUS: KeepListeningStatus = {
  enabled: false,
  authenticated: false,
  generating: false,
  exhausted: false,
  error: null,
  generatedTotal: 0,
};

function subscribe(onChange: () => void): () => void {
  return subscribeKeepListeningCoordinator(onChange);
}

/**
 * `useSyncExternalStore` requires a referentially stable snapshot: returning a
 * freshly-built object on every call makes React re-render forever ("the
 * snapshot must be cached"). The coordinator's `getState()` already has exactly
 * that property — `set()` replaces the state object only when something
 * actually changed — so the snapshot is that object, and the no-coordinator
 * case is the constant above.
 *
 * ONE subscription covers both things the UI needs, because
 * `subscribeKeepListeningCoordinator` is woken by a coordinator appearing AND
 * by every state change inside it (see the note in `instance.ts`):
 * coordinator presence is `getState() === OFF_STATUS`, and a coordinator
 * created after mount — PlayerHost's effect runs after the first render —
 * resolves to its own state object, which is never the same reference. So
 * `useSyncExternalStore` reacts in both directions without a second binding.
 */
function readStatus(): KeepListeningStatus {
  return getKeepListeningCoordinator()?.getState() ?? OFF_STATUS;
}

export interface KeepListeningSaveState {
  /** A preference write is in flight. */
  pending: boolean;
  /** Translation key for a user-facing error, if any. */
  error: string | null;
}

let saveState: KeepListeningSaveState = { pending: false, error: null };
const saveListeners = new Set<() => void>();

function setSaveState(patch: Partial<KeepListeningSaveState>): void {
  saveState = { ...saveState, ...patch };
  for (const listener of [...saveListeners]) {
    listener();
  }
}

function subscribeSave(onChange: () => void): () => void {
  saveListeners.add(onChange);
  return () => {
    saveListeners.delete(onChange);
  };
}

function readSave(): KeepListeningSaveState {
  return saveState;
}

/** Test seam: clears the shared save result between cases. */
export function resetKeepListeningSaveState(): void {
  saveState = { pending: false, error: null };
}

export interface KeepListeningBinding {
  /**
   * Whether the control should exist at all: there is a coordinator, and the
   * listener is signed in. An anonymous listener has no account to store the
   * preference on, and offering a control that cannot save would be a lie.
   */
  available: boolean;
  status: KeepListeningStatus;
  save: KeepListeningSaveState;
  toggle: () => Promise<void>;
}

export function useKeepListening(): KeepListeningBinding {
  const status = useSyncExternalStore(subscribe, readStatus, () => OFF_STATUS);
  const save = useSyncExternalStore(subscribeSave, readSave, readSave);
  const available = getKeepListeningCoordinator() !== null && status.authenticated;

  const toggle = useCallback(async () => {
    const coordinator = getKeepListeningCoordinator();
    if (!coordinator || saveState.pending) {
      return;
    }
    const next = !coordinator.getState().enabled;
    // Optimistic, but the optimism lives in the coordinator — the same object
    // the control renders from — so there is nothing to fall out of sync.
    coordinator.setEnabled(next);
    setSaveState({ pending: true, error: null });
    // Phase 49. A server action's body try/catches and resolves `{ok:false}`,
    // but the transport rejects on a network drop. Without this, the
    // rejection skipped BOTH statements below: the control stayed flipped to
    // a value that was never persisted, and `pending` stayed true forever, so
    // `toggle` early-returns on every later click and the setting can never be
    // changed again in that session. try/finally guarantees the rollback and
    // the release happen on both outcomes.
    let persisted = false;
    try {
      const result = await setKeepListeningAction(next);
      if (result.ok) {
        persisted = true;
        setSaveState({ pending: false, error: null });
        return;
      }
      setSaveState({ pending: false, error: "keepListening.saveError" });
    } catch {
      setSaveState({ pending: false, error: "keepListening.saveError" });
    } finally {
      // Rolled back in the coordinator, so the control stops lying about the
      // setting without a second copy of the truth to reconcile. Only undo the
      // optimism when the action did not actually take.
      if (!persisted) {
        coordinator.setEnabled(!next);
      }
    }
  }, []);

  return { available, status, save, toggle };
}
