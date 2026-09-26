"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Track } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { useMusicEngineState } from "@/lib/music/use-music-engine";
import { HeartIcon } from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import { Dialog, DialogTitle, DialogClose } from "@/components/ui/dialog";

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
  const [liked, setLiked] = useState<Set<string>>(() => new Set(initialLiked));
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  // Render-mirrors live in an effect (never assigned during render).
  const likedRef = useRef(liked);
  useEffect(() => {
    likedRef.current = liked;
  }, [liked]);
  const inFlightRef = useRef<Set<string>>(new Set());

  const toggle = useCallback(
    (track: Track) => {
      const key = likedTrackKey(track);
      if (inFlightRef.current.has(key)) {
        return;
      }
      inFlightRef.current.add(key);
      const nextLiked = !likedRef.current.has(key);
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
          // suites hermetic); the mutation path is unchanged.
          const { likeTrackAction, unlikeTrackAction } = await import(
            "@/app/actions/track"
          );
          const result = nextLiked
            ? await likeTrackAction(track)
            : await unlikeTrackAction(track);
          if (!result.ok) {
            rollback();
            if (!isAuthenticated) {
              requestAuthPrompt();
            }
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
    [isAuthenticated],
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
  if (!currentTrack || !shared) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={shared.toggle}
      disabled={shared.pending}
      aria-pressed={shared.liked}
      aria-label={shared.liked ? `Unlike ${currentTrack.title}` : `Like ${currentTrack.title}`}
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
 */
export function AuthPromptHost({ signIn }: { signIn: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, show);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, show);
  }, []);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} label={t("auth.authRequiredTitle")}>
      <div className="relative">
        <DialogTitle>{t("auth.authRequiredTitle")}</DialogTitle>
        <DialogClose onClick={() => setOpen(false)} />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">
        {t("auth.authRequiredDescription")}
      </p>
      <div className="mt-5 flex justify-end gap-2">{signIn}</div>
    </Dialog>
  );
}
