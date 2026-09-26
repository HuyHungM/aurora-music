"use client";

import { useEffect, useRef } from "react";
import { EQ_COOKIE, EQ_COOKIE_MAX_AGE } from "@/lib/audio/eq-cookie";
import { encodeEQ, type EQConfig } from "@/lib/audio/eq";
import { eqActions, getEqState, subscribeEq } from "@/lib/audio/eq-store";
import { setEQAction } from "@/app/actions/audio-eq";

/**
 * EQ persistence (Phase 53 addendum).
 *
 * WHY A SHELL-LEVEL ROOT AND NOT PART OF THE PANEL. Addendum §42 requires every
 * EQ surface to share one state, and §39 requires that state to be persisted
 * independently of playback. Both fall out of where this component sits: it is
 * mounted in the app shell, one level above both Settings and the player, so
 * mounting, unmounting or never visiting the settings page cannot change whether
 * a preference is saved. A panel that persisted on its own would lose a change
 * made from the player's compact control the moment that control unmounted.
 *
 * IT PERSISTS, IT DOES NOT OWN. The configuration lives in the module-level
 * store (`eq-store.ts`) because §42 wants one authority reachable from
 * non-React code; this component only watches that authority's `revision` and
 * writes the sinks. There is no second copy of the configuration here, which is
 * why a value can never be rendered from one and stored from the other.
 *
 * THE TWO SINKS ARE TREATED DIFFERENTLY, for the same reasons and with the same
 * asymmetry `AppearanceRoot` documents:
 *
 *   - The cookie is a synchronous string assignment and, for a signed-out
 *     listener, the ONLY place the preference lives. It is written immediately,
 *     on every change. Debouncing it would open a window in which somebody
 *     nudges a slider, closes the tab, and loses the change - a data-loss bug
 *     bought by saving nothing.
 *   - The server action is a network round trip that may write a database row,
 *     and that genuinely must not happen once per slider tick. It is debounced.
 *
 * A SIGNED-IN listener's cookie is written by the action instead, so the row and
 * the cookie come out of the same encoder in the same call and cannot disagree.
 */
export function EQPersistenceRoot({
  initial,
  authenticated,
}: {
  initial: EQConfig;
  authenticated: boolean;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<EQConfig | null>(null);
  const authenticatedRef = useRef(authenticated);
  /**
   * The first revision seen is the hydration write, not a change of mind, and
   * persisting it would immediately re-save what the server just handed us -
   * a pointless write on every page load, and on an anonymous load a pointless
   * cookie. Counted rather than boolean so that a change arriving in the same
   * commit as hydration is still persisted.
   */
  const hydratedRef = useRef(false);

  // An effect, not a bare assignment during render: writing a ref while
  // rendering is a documented React hazard, and there is no need for the value
  // to be current before the first commit - a subscriber cannot run before the
  // effect that subscribes it, and that effect is declared after this one.
  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  useEffect(() => {
    // Adopt the server's answer before subscribing, so the first revision this
    // effect sees is the listener's, not ours. A `hydrate` that arrives later -
    // a multi-tab write, say - bumps the revision and persists normally.
    eqActions.hydrate(initial);
    hydratedRef.current = true;
    // The revision that hydration produced. Persistence keys off the revision
    // rather than off every notification, because this very subscriber writes
    // the save status - so keying off "something changed" would persist once per
    // save-status change and re-write the same cookie in a small loop.
    let lastPersisted = getEqState().revision;

    const flush = async (): Promise<void> => {
      const config = pendingRef.current;
      if (!config) {
        return;
      }
      pendingRef.current = null;
      eqActions.setSaveStatus("saving");
      try {
        const result = await setEQAction(encodeEQ(config));
        if (result.ok) {
          eqActions.setSaveStatus("saved");
          return;
        }
        // A write failure, not a rejection: `setEQAction` returns the REQUESTED
        // value here, so the store keeps the listener's curve and says so. See
        // the action for why the two failure shapes are reported differently.
        eqActions.setSaveStatus("failed");
      } catch {
        eqActions.setSaveStatus("failed");
      }
    };

    const unsubscribe = subscribeEq(() => {
      const state = getEqState();
      if (!hydratedRef.current) {
        return;
      }
      // A notification that is not a configuration change - the save status, or
      // the graph reporting that it engaged - has nothing to persist.
      if (state.revision === lastPersisted) {
        return;
      }
      lastPersisted = state.revision;
      const config = state.config;

      if (!authenticatedRef.current) {
        // Nothing is queued, and that is the point: a signed-out listener has no
        // server sink, so there is nothing for a debounce to be waiting on. No
        // timer, no flush, no round trip.
        writeEQCookie(config);
        eqActions.setSaveStatus("saved");
        return;
      }

      pendingRef.current = config;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, PERSIST_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Flush a change still waiting when the shell goes away, so navigating
      // away mid-drag does not discard the last few hundred milliseconds.
      void flush();
    };
  }, [initial]);

  return null;
}

/**
 * 400 ms, matching `AppearanceRoot`.
 *
 * Long enough that a slider drag - which produces a change per pointer move -
 * is one network write, and short enough that releasing a control and looking
 * away has already saved.
 */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * Synchronous cookie write. `encodeEQ` omits every field equal to the default,
 * so a listener who has changed nothing writes `{"v":1}` - eleven bytes on a
 * cookie that travels with every same-origin request.
 */
function writeEQCookie(config: EQConfig): void {
  try {
    const value = encodeURIComponent(JSON.stringify(encodeEQ(config)));
    document.cookie = `${EQ_COOKIE}=${value}; Path=/; Max-Age=${EQ_COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // Best-effort. A browser that refuses the write still plays audio; the
    // server action persists for signed-in listeners.
  }
}
