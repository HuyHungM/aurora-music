"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Track } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { useMusicEngineState } from "@/lib/music/use-music-engine";
import { HeartIcon, LockIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/i18n/locale-provider";
import { Dialog, DialogActions, DialogTitle } from "@/components/ui/dialog";

/** Canonical client key mirroring the DAL Like identity. */
export function likedTrackKey(
  track: Pick<Track, "provider" | "id"> & { providerTrackId?: string },
): string {
  return `${track.provider}:${track.providerTrackId ?? track.id}`;
}

export const AUTH_REQUIRED_EVENT = "aurora:auth-required";

/** Asks the app to show the sign-in prompt (anonymous mutation attempt). */
export function requestAuthPrompt(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
  }
}

interface LikedTracksValue {
  liked: Set<string>;
  pending: Set<string>;
  toggle: (track: Track) => void;
}

const LikedTracksContext = createContext<LikedTracksValue | null>(null);

/**
 * Single client mirror of the DAL likes table (Phase 38). Seeded
 * server-side per user; every Like affordance (rows, menus, player,
 * track page) reads and mutates through here, so liked state stays
 * synchronized without a second cache. Mutations are optimistic with
 * rollback; anonymous attempts roll back and raise the shared
 * sign-in prompt instead of failing silently.
 */
export function LikedTracksProvider({
  initialLiked,
  isAuthenticated,
  children,
}: {
  initialLiked: string[];
  isAuthenticated: boolean;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [liked, setLiked] = useState<Set<string>>(() => new Set(initialLiked));
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  // Render-mirrors live in an effect (never assigned during render).
  const likedRef = useRef(liked);
  useEffect(() => {
    likedRef.current = liked;
  }, [liked]);
  const inFlightRef = useRef<Set<string>>(new Set());
  const isAuthenticatedRef = useRef(isAuthenticated);
  useEffect(() => {
    isAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  const toggle = useCallback(
    (track: Track) => {
      const key = likedTrackKey(track);
      if (inFlightRef.current.has(key)) {
        return;
      }
      inFlightRef.current.add(key);
      const nextLiked = !likedRef.current.has(key);
      const tNow = tRef.current;
      const authenticatedNow = isAuthenticatedRef.current;
      setPending((prev) => new Set(prev).add(key));
      setLiked((prev) => {
        const next = new Set(prev);
        if (nextLiked) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
      void (async () => {
        // Roll back the optimistic change — never leave the icon visually
        // liked when the mutation did not land.
        const rollback = () => {
          setLiked((prev) => {
            const next = new Set(prev);
            if (nextLiked) {
              next.delete(key);
            } else {
              next.add(key);
            }
            return next;
          });
        };
        try {
          // Imported lazily so merely rendering a Like affordance never
          // pulls the server-action module graph (keeps player and row
          // suites hermetic); the mutation path is unchanged. The
          // notification poster is imported AFTER the action resolves, so a
          // suite that mocks the actions asserts on the mutation and not on
          // which module graph happened to resolve first.
          const { likeTrackAction, unlikeTrackAction } = await import(
            "@/app/actions/track"
          );
          const result = nextLiked
            ? await likeTrackAction(track)
            : await unlikeTrackAction(track);
          const { notifyLikeResult } = await import(
            "@/components/ui/notify-events"
          );
          if (!result.ok) {
            rollback();
            if (!authenticatedNow) {
              requestAuthPrompt();
            } else {
              notifyLikeResult(false, nextLiked, track, tNow);
            }
          } else {
            notifyLikeResult(true, nextLiked, track, tNow);
          }
        } catch {
          // Phase 49. A transport rejection used to skip every statement
          // below, so the optimistic flip was never undone, `inFlightRef`
          // kept the key, and `pending` kept the control disabled — a
          // permanent lockout of Like for that track. No auth prompt here: a
          // dropped request is not an authorization failure, and the control
          // is re-enabled by the finally below so the user can just retry.
          rollback();
        } finally {
          inFlightRef.current.delete(key);
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      })();
    },
    [],
  );

  const value = useMemo(
    () => ({ liked, pending, toggle }),
    [liked, pending, toggle],
  );
  return (
    <LikedTracksContext.Provider value={value}>
      {children}
    </LikedTracksContext.Provider>
  );
}

export function useLikedTracksContext(): LikedTracksValue | null {
  return useContext(LikedTracksContext);
}

/** Liked state for one track: shared context when mounted, else null. */
export function useLikedTrack(track: Track | null): {
  liked: boolean;
  pending: boolean;
  toggle: () => void;
} | null {
  const ctx = useLikedTracksContext();
  const key = track ? likedTrackKey(track) : null;
  return useMemo(() => {
    if (!ctx || !track || key === null) {
      return null;
    }
    return {
      liked: ctx.liked.has(key),
      pending: ctx.pending.has(key),
      toggle: () => ctx.toggle(track),
    };
  }, [ctx, track, key]);
}

/**
 * Compact Like control for the player (bar + full player). Reads the
 * current engine track and the shared liked set — one source of truth
 * with rows, menus, and the track page.
 */
export function PlayerLikeButton({ className }: { className?: string }) {
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const likeTrack = currentTrack ? identityToTrack(currentTrack) : null;
  const shared = useLikedTrack(likeTrack);
  const { t } = useLocale();
  if (!currentTrack || !shared) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={shared.toggle}
      disabled={shared.pending}
      aria-pressed={shared.liked}
      // The shared `track.likeLabel`/`track.unlikeLabel` keys, not a template
      // literal. This was the one accessible name in a production component
      // built in English, so a Vietnamese listener heard "Like <title>" from
      // the player while every sibling like control spoke the active locale.
      aria-label={t(
        shared.liked ? "track.unlikeLabel" : "track.likeLabel",
        { title: currentTrack.title },
      )}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50 ${
        shared.liked
          ? "text-accent hover:bg-surface-hover"
          : "text-text-muted hover:bg-surface-hover hover:text-text-primary"
      } ${className ?? ""}`}
    >
      <HeartIcon size={20} className={shared.liked ? "fill-accent" : ""} />
    </button>
  );
}

/**
 * Shared anonymous-mutation prompt. Listens for auth-required events and
 * shows the existing Auth.js sign-in flow (passed in from the server
 * shell) — no second login modal.
 *
 * Rapid duplicate events (e.g. a double-clicked Like, or Like + Follow in the
 * same tick) cannot stack a second dialog: `setOpen(true)` is idempotent,
 * and `AuthPromptHost` is mounted exactly once in `AppShell`, so there is
 * exactly one instance to open.
 *
 * NO `DialogClose` HERE, and that is the whole design. The shared `Dialog`
 * primitive still owns its X, and every other dialog still renders one; this
 * surface deliberately does not, because its two named actions — Cancel and
 * the sign-in control — are the ways out, and a third identical-looking X in
 * the corner only competed with them. Dismissal is therefore unchanged and
 * complete: Cancel, the backdrop, Escape, and (on touch) the system back
 * gesture all close it, because every one of those is `Dialog`'s own
 * `onClose` path and none of them ever depended on the button.
 *
 * The wrapper also loses the `relative pr-12` pair that existed only to keep
 * the title clear of that button. The panel is already `relative`, so nothing
 * was depending on this element as a containing block.
 */
export function AuthPromptHost({ signIn }: { signIn: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const descriptionId = useId();

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, show);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, show);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <Dialog
      open={open}
      onClose={close}
      label={t("auth.authRequiredTitle")}
      describedBy={descriptionId}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-2 text-text-muted"
        >
          <LockIcon size={20} />
        </span>
        <DialogTitle>{t("auth.authRequiredTitle")}</DialogTitle>
      </div>
      <p
        id={descriptionId}
        className="mt-3 text-sm leading-relaxed text-text-muted"
      >
        {t("auth.authRequiredDescription")}
      </p>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={close}>
          {t("common.cancel")}
        </Button>
        {signIn}
      </DialogActions>
    </Dialog>
  );
}
