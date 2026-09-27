"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { setPlaylistVisibilityAction } from "@/app/actions/playlist";
import { Dialog, DialogTitle, DialogClose, DialogActions } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Artwork } from "@/components/ui/artwork";
import {
  AlertCircleIcon,
  ClipboardCheckIcon,
  CopyIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  ShareIcon,
} from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import { plural } from "@/lib/i18n/translate";
import type { Playlist, PlaylistVisibility } from "@/lib/domain";

/**
 * How long "Copied" stays up before the control returns to "Copy link".
 *
 * Long enough to be read and to notice peripherally, short enough that the
 * button is not lying about its state by the time the user looks back at it.
 * This is a label, not an animation, so it is not gated on reduced motion.
 */
const COPIED_RESET_MS = 2400;

/** No-op subscription: a platform's share support cannot change mid-session. */
function subscribeNever(): () => void {
  return () => undefined;
}

function getNativeShareSupport(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * Copies through `document.execCommand("copy")` for when the async clipboard
 * API is not there to ask.
 *
 * `navigator.clipboard` is a SECURE-CONTEXT-ONLY API: on a plain-HTTP origin -
 * which is exactly how Aurora is opened from another device at
 * `http://<lan-ip>:3000` during development - it is `undefined`. Without this
 * path the product's only share control reports "copy failed" on every attempt
 * while the URL sits right there in the field beside it, so sharing a playlist
 * from a phone on the LAN simply does not work.
 *
 * Returns `false` instead of throwing so the caller always falls through to
 * the honest error message and the read-only URL field stays the documented
 * manual remedy (select it, press Ctrl+C) for a browser that refuses both.
 */
function legacyCopy(text: string): boolean {
  if (
    typeof document === "undefined" ||
    typeof document.execCommand !== "function"
  ) {
    return false;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  // Off-screen rather than `display: none`: a hidden element is not
  // selectable in some browsers, and an unselectable field copies nothing.
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  const selection = document.getSelection();
  const restore =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  field.select();
  field.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  if (restore && selection) {
    // Leave the page's own selection as it was: the caller's dialog is open
    // and something in it may already be selected.
    selection.removeAllRanges();
    selection.addRange(restore);
  }
  return copied;
}

/**
 * Whether the platform has a share sheet, read as an external store.
 *
 * `navigator.share` does not exist on the server, so this cannot simply be
 * evaluated during the first render. The obvious fix - `useState(false)` plus a
 * `useEffect` that probes and sets - is what the React Compiler lint rejects as
 * a cascading render, and it is right to: the dialog would paint once with no
 * share button, then again with one, for a value that was knowable up front.
 *
 * `useSyncExternalStore` is the codebase's established answer to "is this real,
 * and is this the server?" (the PWA install prompt and the MusicEngine bindings
 * use the same primitive for the same reason). React guarantees the *client*
 * getter is not consulted while hydrating, so the first paint always agrees with
 * the server's HTML and there is no mismatch to reconcile.
 *
 * The server snapshot is `false`, the conservative direction: SSR emits no
 * share button, and a platform that cannot open anything is worse off with one
 * than without. A missing button is an absence; a broken one is a promise the
 * OS will not keep.
 */
function useCanNativeShare(): boolean {
  return useSyncExternalStore(subscribeNever, getNativeShareSupport, () => false);
}

/**
 * Owner-only playlist sharing (Phase 47).
 *
 * The button renders for the owner only, but the real authorization is
 * server-side: `setPlaylistVisibilityAction` requires a session and
 * re-checks ownership in the DAL. Hiding the control is presentation, not
 * protection.
 *
 * The share URL carries ONLY the opaque share token. No playlist id, no
 * owner id, no provider id ever appears in it.
 *
 * ## What the dialog is for
 *
 * The question a user opens this to answer is "who can see this playlist, and
 * how do I get the link to them" - and the old layout answered neither in the
 * first second. It never named the playlist, so a user with two playlists
 * could not tell which one they were about to publish; it offered one button
 * whose label flipped between "Share this playlist" and "Stop sharing", so the
 * *current* state had to be inferred from the wording of the *next* action; and
 * it put a full-width bright input above the fold, which made the raw URL the
 * most prominent thing in a dialog whose subject is a playlist.
 *
 * The order below is deliberate and is the whole design: what is being shared,
 * then who can see it, then whether it is on, then the link, then the actions.
 * The URL is last because it is the least informative thing in the dialog - it
 * is identical for every playlist except for a token the reader does not care
 * about.
 *
 * Success feedback is an inline live region rather than a toast: the
 * repository has no toast system, and inventing a dependency for one
 * confirmation would be a larger change than the feature warrants.
 */
export function PlaylistShareControl({
  playlist,
  onVisibilityChanged,
}: {
  playlist: Playlist;
  onVisibilityChanged?: () => void;
}) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  /**
   * Which way the in-flight request is going. The pending label is different
   * for the two directions - minting a token is something the user waits for,
   * withdrawing one is not - and this is also what makes the "busy" state
   * announce itself on the control that is actually busy.
   */
  const [pendingVisibility, setPendingVisibility] = useState<PlaylistVisibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The direction a failed visibility change was going, so the error can offer
   * to retry that exact request. A copy failure has no such direction: its
   * remedy is manual selection, not another attempt, so it gets no retry.
   */
  const [failedVisibility, setFailedVisibility] = useState<PlaylistVisibility | null>(null);
  const [copied, setCopied] = useState(false);
  const canNativeShare = useCanNativeShare();
  const stateId = useId();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server props are the source of truth, but the toggle writes its own
  // state optimistically and a `router.refresh()` may not have landed yet.
  // Both halves are therefore reconciled DURING render (the pattern React
  // documents for "adjust state when a prop changes") rather than in an
  // effect: an effect that calls setState synchronously causes a cascading
  // render, and the effect body would run on every parent render.
  const serverShareToken =
    playlist.visibility === "shared" ? (playlist.shareToken ?? null) : null;
  const serverKey = `${playlist.visibility}:${playlist.shareToken ?? ""}`;
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [visibility, setVisibility] = useState<PlaylistVisibility>(playlist.visibility);
  const [shareToken, setShareToken] = useState<string | null>(serverShareToken);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setVisibility(playlist.visibility);
    setShareToken(serverShareToken);
  }

  /**
   * A playlist can be `shared` before it has a token only transiently, but the
   * distinction matters: the permission and the link are separate facts, and a
   * link that is not there yet cannot be handed to anyone. The badge reports
   * the permission; the link section reports the link.
   */
  const isShared = visibility === "shared";
  const hasLink = shareToken !== null;

  // Resolved against the current origin so the copied link is usable. The
  // route path is fixed and token-only, so nothing internal is exposed.
  const shareUrl =
    hasLink && typeof window !== "undefined"
      ? `${window.location.origin}/playlist/share/${shareToken}`
      : null;

  /**
   * "Copied" is a temporary claim, so it has to expire. Without this the
   * button claimed a copy had happened for as long as the dialog stayed open,
   * including after the user had copied something else entirely.
   *
   * The reset happens in a timer callback, which is an external system
   * reporting back rather than a synchronous setState in the effect body - the
   * distinction the same lint draws for `canNativeShare`, which had to be
   * `useSyncExternalStore` instead.
   */
  useEffect(() => {
    if (!copied) return;
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [copied]);

  const changeVisibility = useCallback(
    async (next: PlaylistVisibility) => {
      // A segmented control reports its state on every activation, including
      // the one that re-selects what is already selected. Without this the
      // control would fire a write - and a "Generating link..." state - every
      // time a user clicked the option they already had.
      if (next === visibility || isSubmitting) {
        return;
      }
      setIsSubmitting(true);
      setPendingVisibility(next);
      setError(null);
      setFailedVisibility(null);
      const result = await setPlaylistVisibilityAction(playlist.id, next);
      setIsSubmitting(false);
      setPendingVisibility(null);
      if (!result.ok) {
        setError(t("playlistShare.shareError"));
        setFailedVisibility(next);
        return;
      }
      setVisibility(result.visibility);
      setShareToken(result.shareToken ?? null);
      setCopied(false);
      onVisibilityChanged?.();
      router.refresh();
    },
    [playlist.id, visibility, isSubmitting, onVisibilityChanged, router, t],
  );

  const handleCopy = useCallback(async () => {
    if (!shareUrl) {
      return;
    }
    // `navigator.clipboard` only exists in a secure context, so on the plain
    // HTTP LAN origin a phone opens during development it is absent rather
    // than merely restricted. Both paths are tried before reporting failure.
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    try {
      if (clipboard?.writeText) {
        await clipboard.writeText(shareUrl);
      } else if (!legacyCopy(shareUrl)) {
        setError(t("playlistShare.copyError"));
        return;
      }
      setError(null);
      setCopied(true);
    } catch {
      // A rejected write is usually a denied permission; the synchronous path
      // does not consult that permission, so it is worth one attempt before
      // telling the person the copy failed.
      if (legacyCopy(shareUrl)) {
        setError(null);
        setCopied(true);
        return;
      }
      setError(t("playlistShare.copyError"));
    }
  }, [shareUrl, t]);

  const handleNativeShare = useCallback(async () => {
    if (!shareUrl) {
      return;
    }
    try {
      await navigator.share({ title: playlist.title, url: shareUrl });
    } catch (cause) {
      // Dismissing the system sheet is a decision, not a failure. Reporting an
      // error for it would teach people that the message is unreliable, which
      // costs the one message that does matter - the one that says the share
      // genuinely failed.
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(t("playlistShare.nativeShareError"));
    }
  }, [playlist.title, shareUrl, t]);

  const close = useCallback(() => {
    setOpen(false);
    // Transient state does not survive a close. The permission does, because it
    // lives on the server and is re-read from props.
    setError(null);
    setFailedVisibility(null);
    setCopied(false);
  }, []);

  const trackCount = playlist.items.length;
  const pendingLabel =
    pendingVisibility === "shared"
      ? t("playlistShare.generatingLink")
      : t("playlistShare.updatingSharing");

  const optionButton = (option: PlaylistVisibility, label: string) => {
    const selected = visibility === option;
    return (
      <Button
        type="button"
        // The selected option is NOT `variant="primary"`. An accent fill is
        // this design system's loudest treatment, and it is spent on exactly
        // one thing per screen: the action you most want taken. Here that is
        // "Copy link". Painting the selected segment in the same fill put two
        // accent buttons in one dialog and left the reader with no answer to
        // "which of these do I press?" - on top of rendering a 14px semibold
        // label at ~4.2:1, which is the accent-foreground token's contrast
        // everywhere in the product and not a property of this control.
        //
        // `secondary` is a raised neutral pill, which on the `bg-surface-2`
        // track reads as selected without competing. Selection is carried by
        // four independent signals, so it survives greyscale: this surface, the
        // `font-semibold`, the globe/lock in the sentence below, and
        // `aria-pressed` for assistive technology.
        variant={selected ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={selected}
        className={selected ? "min-w-0 flex-1 font-semibold" : "min-w-0 flex-1"}
        // Both options are disabled while a request is in flight, not just the
        // one being pressed. There is only one meaningful action available at
        // that moment, and leaving the other enabled would let a second click
        // race the first into a contradictory pair of writes.
        disabled={isSubmitting}
        onClick={() => void changeVisibility(option)}
      >
        {/* The label does NOT swap to the pending message. A segmented control
            whose option text changes mid-press stops telling the user which
            option they pressed, and swapping a two-word label for a twelve-word
            sentence inside a half-width pill reflows the control. The pending
            state lives in the status line below, where it has room. */}
        {label}
      </Button>
    );
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t("playlistShare.share")}
        className="gap-1.5"
      >
        <LinkIcon size={16} />
        <span className="hidden sm:inline">{t("playlistShare.share")}</span>
      </Button>

      <Dialog open={open} onClose={close} label={t("playlistShare.shareTitle")}>
        {/* The title and the close control are direct children of the panel, NOT
            wrapped in a `relative` div. The panel is itself `relative`, and
            `DialogClose` is `absolute right-4 top-4` - so a positioned wrapper
            here would become the containing block instead and drop the ✕ below
            the title, into the identity row, where it reads as part of the
            playlist's own controls. Every sibling playlist dialog places these
            two as direct children for the same reason. */}
        <DialogTitle>{t("playlistShare.shareTitle")}</DialogTitle>
        <DialogClose onClick={close} />

        <div className="mt-4 flex flex-col gap-5">
          {/* WHAT. The dialog never used to say which playlist it was about,
              which made it a form with no subject. */}
          <div className="flex items-center gap-3">
            <Artwork
              src={playlist.artwork}
              alt=""
              size="medium"
              className="shadow-sm"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-base font-semibold text-text-primary">
                {playlist.title}
              </span>
              <span className="text-xs text-text-muted">
                {plural(locale, trackCount, {
                  one: t("playlistDetail.tracksCountOne", { count: trackCount }),
                  other: t("playlistDetail.tracksCount", { count: trackCount }),
                })}
              </span>
            </div>
          </div>

          <div className="border-t border-border-subtle" />

          {/* WHO, and WHETHER. The control states the permission; the sentence
              under it states the consequence, because "Public" on its own does
              not tell anyone what public means here.

              The state is deliberately stated ONCE. An earlier draft put a
              "Private" badge in the preview row above as well, which meant the
              dialog said "Private" twice - once as the selected control and
              once as a readout of that same control. A user scanning for the
              state found two answers to one question, and a screen reader
              announced the same word twice in a row. The control is the state
              display; the sentence is its explanation. */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">
              {t("playlistShare.accessLabel")}
            </span>
            <div
              role="group"
              aria-label={t("playlistShare.accessGroupLabel")}
              aria-busy={isSubmitting || undefined}
              className="flex gap-1 rounded-full border border-border-subtle bg-surface-2 p-1"
            >
              {optionButton("private", t("playlistShare.privateOption"))}
              {optionButton("shared", t("playlistShare.publicOption"))}
            </div>
            {/* The icon is the load-bearing part of the state. `GlobeIcon` and
                `LockIcon` differ in shape, so the state survives being read by
                someone who cannot separate the two colours - and it carries the
                reading even while the sentence is replaced by a pending one. */}
            <p
              id={stateId}
              role="status"
              className="flex items-start gap-1.5 text-xs leading-relaxed text-text-muted"
            >
              {isShared ? (
                <GlobeIcon size={14} className="mt-px shrink-0" />
              ) : (
                <LockIcon size={14} className="mt-px shrink-0" />
              )}
              <span>
                {isSubmitting
                  ? pendingLabel
                  : isShared
                    ? t("playlistShare.publicState")
                    : t("playlistShare.privateState")}
              </span>
            </p>
            {/* Revocation is destructive to something the user may have already
                sent to someone, so the consequence is stated here - on the
                option that causes it, while the user is choosing it - rather
                than after the fact. */}
            {isShared ? (
              <p className="text-xs leading-relaxed text-text-muted">
                {t("playlistShare.revokeWarning")}
              </p>
            ) : null}
          </div>

          {/* HOW. The field is the payload and the manual-copy fallback, so it
              holds the exact URL: truncating it visually is fine, truncating
              its VALUE would hand a broken link to anyone who selects it and
              presses Ctrl+C, which is the documented remedy when the clipboard
              is unavailable. A read-only input scrolls rather than ellipsises,
              which is the honest behaviour for a value that must stay exact,
              and `min-w-0` is what keeps it from widening the dialog. */}
          {hasLink && shareUrl ? (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="playlist-share-link"
                className="text-sm font-medium text-text-primary"
              >
                {t("playlistShare.linkLabel")}
              </label>
              <input
                id="playlist-share-link"
                type="text"
                readOnly
                value={shareUrl}
                aria-describedby={stateId}
                onFocus={(event) => event.currentTarget.select()}
                // The link is the payload of this dialog. It is the single
                // most-selected string in the product - people paste it into
                // messages - so it is explicitly `select-text` and must never
                // inherit `select-none` from the dialog or the button beside
                // it. A read-only field still selects and copies normally.
                className="h-10 w-full min-w-0 cursor-text select-text rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm text-text-secondary focus:border-accent focus:outline-none"
              />
              {/* One primary action, and the two secondary-looking controls out
                  of the field's own row. Three controls beside a 360px-wide
                  input is the layout that breaks first on a phone; stacking
                  them below keeps the field full width and gives each button
                  the full width of the sheet to be aimed at. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                {canNativeShare ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleNativeShare()}
                    className="w-full sm:w-auto"
                  >
                    <ShareIcon size={16} />
                    {t("playlistShare.nativeShare")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="w-full sm:w-auto"
                  // Enabled from the start: this is the one control that hands
                  // the listener the link. It stays enabled after copying,
                  // because copying again is a reasonable thing to want.
                  disabled={isSubmitting}
                >
                  {copied ? (
                    <>
                      <ClipboardCheckIcon size={16} />
                      {t("playlistShare.linkCopied")}
                    </>
                  ) : (
                    <>
                      <CopyIcon size={16} />
                      {t("playlistShare.copyLink")}
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-red-400"
            >
              <AlertCircleIcon size={16} className="shrink-0" />
              <span>{error}</span>
              {failedVisibility ? (
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  onClick={() => void changeVisibility(failedVisibility)}
                >
                  {t("common.retry")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Success announcement for assistive tech, without a toast. */}
          <p aria-live="polite" className="sr-only">
            {copied ? t("playlistShare.copiedAnnouncement") : ""}
          </p>

          <DialogActions>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.close")}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </>
  );
}
