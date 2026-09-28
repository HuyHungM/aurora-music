"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  backgroundImageValue,
  cssUrlEscape,
  DEFAULT_APPEARANCE,
  encodeAppearance,
  type Appearance,
  type BackgroundSelection,
} from "@/lib/appearance/appearance";
import {
  appearanceStyleRecord,
  backgroundAttributeValue,
  glassAttributeValue,
} from "@/lib/appearance/apply";
import { APPEARANCE_COOKIE } from "@/lib/appearance/cookie";
import {
  setAppearanceAction,
  type AppearanceActionResult,
} from "@/app/actions/appearance";
import { AuroraBackdrop } from "./aurora-backdrop";
import { ArtworkAmbient } from "./artwork-ambient";

/**
 * How long a continuous control settles before it is written anywhere.
 *
 * Long enough that dragging a slider across its whole range produces ONE
 * cookie write and ONE database mutation rather than thirty of each (§59),
 * and short enough that the window in which a change exists only in memory is
 * this small. The cookie write is synchronous and the account write is a
 * server action, so that window is the price of not writing a row per pixel
 * of slider travel - a price worth naming rather than hiding.
 */
const PERSIST_DEBOUNCE_MS = 400;

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * How many queued values one `flush` will write before giving up.
 *
 * A bound rather than an open loop: an unbounded drain would keep posting
 * writes for as long as a slider was being dragged. Nine passes is far past any
 * real gesture, and the debounce already guarantees each queued value is a
 * settled interaction rather than a frame.
 */
const MAX_FLUSH_PASSES = 9;

export type AppearanceStatus = "idle" | "saving" | "saved" | "error";

interface AppearanceContextValue {
  /** The live draft. Drives the render immediately, before any write. */
  appearance: Appearance;
  /** The last value the server confirmed. A rejected write rolls back to it. */
  saved: Appearance;
  status: AppearanceStatus;
  /** A `settings.*` message key describing the last failure, if any. */
  reason: string | undefined;
  /** True when the draft differs from the last confirmed value. */
  dirty: boolean;
  update: (patch: Partial<Appearance>) => void;
  setBackground: (selection: BackgroundSelection) => void;
  reset: () => void;
  /** The resolved `background-image` value, for previews and tests. */
  backgroundImage: string;
  /**
   * A session-only local preview as a `blob:` object URL, or `null`. It is an
   * in-memory override of the persisted background and is never written
   * anywhere; see `setLocalBackground`.
   */
  localBackground: string | null;
  /**
   * Adopt or clear the session-only local preview, revoking whatever object
   * URL is being replaced. The caller passes a URL minted by
   * `validateLocalBackgroundFile`, or `null` to fall back to the persisted
   * background.
   */
  setLocalBackground: (url: string | null) => void;
}

const FALLBACK: AppearanceContextValue = {
  appearance: DEFAULT_APPEARANCE,
  saved: DEFAULT_APPEARANCE,
  status: "idle",
  reason: undefined,
  dirty: false,
  update: () => undefined,
  setBackground: () => undefined,
  reset: () => undefined,
  backgroundImage: "none",
  localBackground: null,
  setLocalBackground: () => undefined,
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/**
 * Never throws. Outside a provider - an isolated unit test, a static
 * prerender edge - the appearance is the shipped default and persistence is
 * simply unavailable, which is the same contract `useLocale` keeps.
 */
export function useAppearance(): AppearanceContextValue {
  return useContext(AppearanceContext) ?? FALLBACK;
}

export interface AppearanceRootProps {
  /** Resolved on the server, so the first paint is already correct. */
  initial: Appearance;
  /** Whether a signed-in user gets an account write as well as a cookie. */
  authenticated: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The application shell root, and the one authority for appearance in the
 * client (§2: no second theme system).
 *
 * WHY THE ROOT AND NOT A PROVIDER ALONE. The eight values have to reach CSS
 * as custom properties on an element that is an ancestor of every surface, and
 * they have to be there in the SERVER-rendered markup - otherwise the first
 * paint is the default theme and the correction arrives a frame later, which
 * is a visible flash on every navigation and on every appearance change. So
 * the shell root itself carries `style` and the four `data-aurora-*`
 * attributes, computed during render from the draft. There is no effect that
 * applies the theme, nothing to run before paint, and nothing that can get out
 * of step with the state.
 *
 * HYDRATION. The first client render uses the same `initial` the server used,
 * so the attribute and style values match the server's markup exactly. The
 * draft initialises to `initial`, not to the default, which is why there is no
 * mismatch to reconcile afterwards.
 *
 * WHAT THIS COMPONENT MUST NEVER DO. It must not touch playback. It does not
 * render, wrap, or provide anything an engine consumes; `ArtworkAmbient` reads
 * engine state through the existing module-level subscription and writes four
 * CSS custom properties, and it is mounted only when the user has opted in.
 * So moving a slider cannot recreate a MusicEngine, a QueueManager, a
 * PlaybackController or a PlayerEngine, and cannot alter the queue, the
 * current track or the position (§52).
 *
 * APPEARANCE IS NOT THE PLAYBACK SESSION. Nothing here reads or writes
 * `PlaybackState`, and `queueSnapshotSchema` has no appearance field (§53).
 */
export function AppearanceRoot({
  initial,
  authenticated,
  className,
  children,
}: AppearanceRootProps) {
  const [appearance, setAppearance] = useState<Appearance>(initial);
  const [saved, setSaved] = useState<Appearance>(initial);
  const [status, setStatus] = useState<AppearanceStatus>("idle");
  const [reason, setReason] = useState<string | undefined>(undefined);
  /**
   * The session-only local preview, or `null`.
   *
   * Deliberately SEPARATE from `appearance`: it is not a preference, it is not
   * encoded, and it is not written to either sink. It starts `null` on both the
   * server and the client, so there is no hydration mismatch, and it is gone
   * the moment the document is reloaded — which is the whole point of the
   * "session only" label the panel shows beside it.
   */
  const [localBackground, setLocalBackgroundState] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The live local preview URL, mirrored out of state.
   *
   * `setLocalBackground` and the unmount cleanup both need the CURRENT URL to
   * revoke, and both run outside render, so a ref is what lets them read it
   * without closing over a stale value.
   */
  const localBackgroundRef = useRef<string | null>(null);
  /** The newest value not yet written. At most one; later changes replace it. */
  const pendingRef = useRef<Appearance | null>(null);
  /**
   * The latest committed draft, mirrored out of state.
   *
   * `commit` reads this instead of closing over `appearance`, which is what
   * lets two commits in the same tick compose instead of the second clobbering
   * the first - and it is written in an event handler, never during render.
   */
  const draftRef = useRef<Appearance>(initial);
  /** Latest `authenticated`, read by the stable `flush` without re-creating it. */
  const authenticatedRef = useRef(authenticated);

  // An effect, not a bare assignment during render: writing a ref while
  // rendering is a documented React hazard, and here there is no need for the
  // value to be current before the first commit, because `flush` can only be
  // reached from a user interaction or from an unmount, both of which happen
  // after every effect has run.
  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  /**
   * Send one value to the account.
   *
   * Never throws: a rejected action is normalised to a failure result so the
   * caller has exactly two cases to handle (refused, or not written) and no
   * third one where an exception escapes into a timer callback.
   */
  const writeToAccount = useCallback(
    async (value: Appearance): Promise<AppearanceActionResult> => {
      try {
        return await setAppearanceAction(encodeAppearance(value));
      } catch {
        return { ok: false, appearance: value, reason: undefined };
      }
    },
    [],
  );

  /**
   * Drain the queue: write everything that is waiting, newest last.
   *
   * A LOOP, NOT A RECURSION, and the distinction is the correctness argument.
   * A change that lands while a write is in flight is re-checked at the top of
   * the next iteration, so the last change of a drag that ended mid-write is
   * written rather than dropped - and because the value is taken OUT of the
   * queue before the `await`, a second concurrent `flush` finds the queue empty
   * and returns. Taking-then-awaiting is the mutual exclusion, which is why
   * there is no separate in-flight flag to get out of step.
   *
   * The loop is bounded by a loop counter rather than by a condition on
   * `pendingRef`, because an unbounded drain would keep posting writes for as
   * long as someone kept dragging. Nine passes is far past any real drag, and
   * the debounce guarantees each pass is a settled gesture rather than a frame.
   */
  const flush = useCallback(async () => {
    for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
      const queued = pendingRef.current;
      if (!queued) {
        return;
      }
      pendingRef.current = null;

      if (!authenticatedRef.current) {
        // Reached only if the session changed between a commit and this flush,
        // which a full page load normally prevents. The cookie is then the only
        // sink, and it is written synchronously - the same approach
        // `LocaleProvider` takes and for the same reason: the interface is
        // already showing the change, and a failed round trip must not be able
        // to lose it.
        writeAppearanceCookie(queued);
        setSaved(queued);
        setStatus("saved");
        continue;
      }

      setStatus("saving");
      const result = await writeToAccount(queued);

      if (pendingRef.current) {
        // A newer change arrived mid-flight. The draft stays as the user left
        // it, and the next pass writes the newer value instead.
        continue;
      }

      if (result.ok) {
        // Adopt the server's answer verbatim, so the interface shows exactly
        // what was stored, including any clamping it applied.
        draftRef.current = result.appearance;
        setAppearance(result.appearance);
        setSaved(result.appearance);
        setReason(undefined);
        setStatus("saved");
        return;
      }
      if (result.reason) {
        // A REJECTION. The value was refused, so the interface must not keep
        // showing it as though it had been applied.
        draftRef.current = result.appearance;
        setAppearance(result.appearance);
        setSaved(result.appearance);
        setReason(result.reason);
        setStatus("error");
        return;
      }
      // A WRITE FAILURE with no rejection. The draft stays: reverting the
      // sliders under someone's finger because a request timed out is worse
      // than showing a preference the server has not confirmed yet, and the
      // cookie written by a previous successful change still holds the intent.
      setStatus("error");
      return;
    }
  }, [writeToAccount]);

  const schedule = useCallback(
    (next: Appearance) => {
      // THE COOKIE IS WRITTEN IMMEDIATELY, and only the server write is
      // debounced. The two sinks have different failure modes and different
      // costs, so treating them alike is wrong in both directions:
      //
      //   - A cookie write is a synchronous string assignment. It costs
      //     nothing, it cannot fail in a way the user would notice, and it is
      //     the ONLY sink for a signed-out visitor. Debouncing it would open a
      //     window in which somebody changes the glass and closes the tab, and
      //     loses the change - a data-loss bug in exchange for saving nothing.
      //   - The server action is a network round trip that may write a
      //     database row, and that genuinely must not happen once per slider
      //     tick.
      //
      // A SIGNED-IN visitor's cookie is written by the action instead, so the
      // value in the account and the value in the cookie are produced by the
      // same encoder in the same call and cannot disagree.
      if (!authenticatedRef.current) {
        writeAppearanceCookie(next);
        setSaved(next);
        setStatus("saved");
        // NOTHING IS QUEUED, and that is the point: there is no server sink
        // for a signed-out visitor, so there is nothing for a debounce to be
        // waiting on. No timer, no flush, no round trip - the whole write is
        // the string assignment above.
        return;
      }

      pendingRef.current = next;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, PERSIST_DEBOUNCE_MS);
    },
    [flush],
  );

  // Flush a change still waiting when the shell goes away, so navigating away
  // mid-drag does not discard the last few hundred milliseconds of intent.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void flush();
    };
  }, [flush]);

  const commit = useCallback(
    (produce: (current: Appearance) => Appearance) => {
      // Computed from the mirrored draft, NOT from a `useState` updater that
      // calls `schedule` inside itself. An updater must be pure: React may run
      // it twice, and scheduling a write is not something that may happen
      // twice. Reading the mirror instead keeps `commit` composable across two
      // calls in one tick AND keeps the side effect where it belongs.
      const next = produce(draftRef.current);
      draftRef.current = next;
      setAppearance(next);
      // "Saving" is announced BEFORE the write is scheduled, and the order is
      // load-bearing. For a signed-out visitor the whole write is one
      // synchronous cookie assignment, so `schedule` resolves the status to
      // "saved" immediately; setting it afterwards would leave the status at
      // "saving" with nothing left in flight to ever change it, which is a
      // spinner that never stops.
      setStatus("saving");
      setReason(undefined);
      schedule(next);
    },
    [schedule],
  );

  const update = useCallback(
    (patch: Partial<Appearance>) => commit((current) => ({ ...current, ...patch })),
    [commit],
  );

  const setBackground = useCallback(
    (selection: BackgroundSelection) =>
      commit((current) => ({ ...current, background: selection })),
    [commit],
  );

  /**
   * Adopt or clear the session-only local preview.
   *
   * THE ONLY PLACE AN OBJECT URL IS REVOKED, on the replace path — the panel
   * mints URLs by validating a file and hands the winning one here, and every
   * URL this function stops pointing at is released immediately rather than
   * being left for the tab to close. The unmount cleanup below is the second
   * release point.
   */
  const setLocalBackground = useCallback((url: string | null) => {
    const previous = localBackgroundRef.current;
    if (previous && previous !== url) {
      try {
        URL.revokeObjectURL(previous);
      } catch {
        // Best effort: the browser reclaims live object URLs on unload.
      }
    }
    localBackgroundRef.current = url;
    setLocalBackgroundState(url);
  }, []);

  // Releasing on unmount matters because the shell can be torn down by a route
  // change while a local preview is showing. Without this the Blob would stay
  // alive for the life of the document.
  useEffect(() => {
    return () => {
      const current = localBackgroundRef.current;
      if (current) {
        try {
          URL.revokeObjectURL(current);
        } catch {
          // Best effort.
        }
      }
    };
  }, []);

  const reset = useCallback(() => {
    // Appearance only. This is a pure value built from a constant; there is no
    // path from here to the queue, the likes, the playlists or the account
    // (§60). The session-only local preview is cleared too, so "Reset" leaves
    // the background at the default rather than at a file that was never a
    // preference.
    setLocalBackground(null);
    commit(() => ({
      ...DEFAULT_APPEARANCE,
      background: { ...DEFAULT_APPEARANCE.background },
    }));
  }, [commit, setLocalBackground]);

  // The effective image: a session-only local preview outranks the persisted
  // selection, and the persisted selection outranks nothing — which is the
  // "session upload → persisted appearance → Aurora Default" fallback chain.
  // Aurora Default is simply `none`.
  const backgroundImage = useMemo(
    () =>
      localBackground
        ? `url("${cssUrlEscape(localBackground)}")`
        : backgroundImageValue(appearance),
    [appearance, localBackground],
  );

  const value = useMemo<AppearanceContextValue>(() => {
    const draft = JSON.stringify(encodeAppearance(appearance));
    const confirmed = JSON.stringify(encodeAppearance(saved));
    return {
      appearance,
      saved,
      status,
      reason,
      dirty: draft !== confirmed,
      update,
      setBackground,
      reset,
      backgroundImage,
      localBackground,
      setLocalBackground,
    };
  }, [
    appearance,
    saved,
    status,
    reason,
    update,
    setBackground,
    reset,
    backgroundImage,
    localBackground,
    setLocalBackground,
  ]);

  const style = useMemo(
    () =>
      ({
        ...appearanceStyleRecord(appearance),
        "--aurora-background-image": cssImageValue(backgroundImage),
      }) as CSSProperties,
    [appearance, backgroundImage],
  );

  return (
    <AppearanceContext.Provider value={value}>
      <div
        data-aurora-glass={glassAttributeValue(appearance)}
        // A session-only local preview reports its own kind so the backdrop
        // paints the image layer and the scrim (anything but "none"), while the
        // persisted selection stays untouched underneath.
        data-aurora-background={
          localBackground ? "local" : backgroundAttributeValue(appearance)
        }
        // Zero blur removes the `backdrop-filter` declarations entirely rather
        // than setting them to `blur(0px)`, which still promotes the element
        // and still costs a backdrop copy on every frame. See the
        // `data-aurora-blur` rules in globals.css.
        data-aurora-blur={appearance.glassBlur === 0 ? "off" : "on"}
        data-aurora-artwork={appearance.artworkAmbient ? "on" : "off"}
        style={style}
        className={className ? `relative isolate flex min-h-dvh ${className}` : "relative isolate flex min-h-dvh"}
      >
        <AuroraBackdrop />
        {appearance.artworkAmbient ? <ArtworkAmbient /> : null}
        {children}
      </div>
    </AppearanceContext.Provider>
  );
}

/** `none` has to be the bare keyword, not `url("none")`. */
function cssImageValue(value: string): string {
  return value === "none" ? "none" : value;
}

/**
 * Synchronous cookie write, mirroring `LocaleProvider`. `encodeAppearance`
 * omits every field equal to the default, so a visitor who has changed
 * nothing writes `{"v":1}` - about twelve bytes on a cookie that travels with
 * every same-origin request.
 */
function writeAppearanceCookie(appearance: Appearance): void {
  try {
    const value = encodeURIComponent(JSON.stringify(encodeAppearance(appearance)));
    document.cookie = `${APPEARANCE_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // Best-effort; the server action persists for signed-in users.
  }
}
