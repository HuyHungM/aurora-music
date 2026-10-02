"use client";

import type { Track } from "@/lib/domain";
import Link from "next/link";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { Artwork } from "@/components/ui/artwork";
import { TrackActionMenu } from "./track-action-menu";
import { PauseIcon, PlayIcon } from "@/components/ui/icons";
import { TrashIcon } from "@/components/ui/icons";
import { formatTrackDuration } from "@/lib/player/format";
import { trackCapabilities } from "@/lib/player/track-capabilities";
import { useLikedTrack } from "./liked-tracks";
import { useLocale } from "@/components/i18n/locale-provider";

export { formatTrackDuration };

export type TrackRowVariant =
  | "catalog"
  | "search"
  | "album"
  | "playlist"
  | "library"
  | "queue"
  | "history";

export function TrackRow({
  track,
  collectionTracks,
  collectionIndex,
  showMenu = false,
  showAddToPlaylist = false,
  onLikeToggle,
  isLiked = false,
  onRemoveFromPlaylist,
  variant = "catalog",
  position,
}: {
  track: Track;
  collectionTracks?: Track[];
  collectionIndex?: number;
  showMenu?: boolean;
  showAddToPlaylist?: boolean;
  onLikeToggle?: () => void;
  isLiked?: boolean;
  onRemoveFromPlaylist?: () => void;
  variant?: TrackRowVariant;
  /** 1-based position shown in album/playlist/queue contexts. */
  position?: number;
}) {
  // A duration of 0 or less is never a real track length — it is the model's
  // way of saying "unknown" — so it stays hidden exactly as before. The
  // formatter itself maps 0 to "00:00" (pure-function correctness), but the
  // row must not newly display a label where it previously showed none.
  const duration =
    track.duration !== undefined && track.duration > 0
      ? formatTrackDuration(track.duration)
      : "";
  // Same destination construction as the search top-result card: the track
  // page resolves by provider id, falling back to the domain id.
  const href = `/track/${encodeURIComponent(track.providerTrackId ?? track.id)}`;
  const { t } = useLocale();
  const engine = useMusicEngine();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;
  // Capability-driven Play: the current track always keeps its
  // pause/resume toggle (engine state is the authority there); other rows
  // expose Play only when the carried domain state shows Aurora can
  // attempt playback — never from provider identity alone.
  const canPlay = isCurrent || trackCapabilities(track).canPlay;
  // Shared liked mirror keeps every row/menu in sync with the player,
  // track page, and library. Explicit props (legacy pass-through) win
  // when provided so existing callers keep working.
  const sharedLike = useLikedTrack(track);
  const menuLiked = onLikeToggle ? isLiked : (sharedLike?.liked ?? isLiked);
  const menuLikeToggle = onLikeToggle ?? sharedLike?.toggle;

  const handleClick = () => {
    if (!engine) {
      return;
    }
    if (isCurrentPlaying) {
      engine.pause();
      return;
    }
    if (collectionTracks && collectionIndex !== undefined) {
      engine.playCollection(collectionTracks, collectionIndex);
    } else {
      void engine.play(track);
    }
  };

  /**
   * Hover/focus intent warming. Pointer crossing a row (or keyboard focus
   * landing on it) usually precedes a tap by hundreds of milliseconds — long
   * enough for a resolution round trip to finish before the click. The facade
   * owns admission (provider scope, sweep throttle, re-hover memory), so this
   * stays a single unconditional call: intent in, maybe-warm out.
   */
  const handleIntent = () => {
    if (!engine) {
      return;
    }
    try {
      engine.prefetchTrack(track);
    } catch {
      // Speculation must never break rendering.
    }
  };

  return (
    <div
      data-current={isCurrent ? "true" : undefined}
      onMouseEnter={handleIntent}
      onFocus={handleIntent}
      // A track row is a ROW, not a panel (Phase 53, §33). Transparent at
      // rest, a surface tint on hover, an accent tint when it is the current
      // track - three states, no border, and no `backdrop-filter` at any of
      // them. A dense library is the worst possible place for per-row glass:
      // a hundred blurred elements is a hundred composited layers, and it
      // reads as confetti rather than as a list. `data-current` is also the
      // hook the E2E suite already asserts against, and it is what makes the
      // current row findable without relying on the accent colour alone.
      className={`aurora-press group flex items-center gap-3 rounded-xl px-2 py-2 transition-colors ${
        isCurrent ? "bg-accent-muted/60" : "hover:bg-surface-hover"
      }`}
    >
      {position !== undefined ? (
        <span
          aria-hidden="true"
          className="hidden w-6 shrink-0 text-center text-xs tabular-nums text-text-muted sm:block"
        >
          {position}
        </span>
      ) : null}
      <span className="relative shrink-0">
        <Artwork src={track.artworkUrl} alt="" size="small" pixelSize={44} />
        {isCurrent ? (
          <span
            aria-hidden="true"
            data-slot="playing"
            className="absolute inset-0 grid place-items-center rounded-lg bg-black/45"
          >
            <span className="flex h-4 items-end gap-[3px]">
              <span className="playing-bar w-[3px] rounded-full bg-accent-foreground" />
              <span className="playing-bar playing-bar-2 w-[3px] rounded-full bg-accent-foreground" />
              <span className="playing-bar playing-bar-3 w-[3px] rounded-full bg-accent-foreground" />
            </span>
          </span>
        ) : null}
      </span>
      <Link
        href={href}
        // The row's navigable region: title + artist metadata. The same
        // link-outside-controls shape as the search top-result card — the
        // Play, remove and menu buttons stay siblings, never descendants, so
        // there is no nested-interactive HTML and no click reaches both. The
        // accessible name is the visible "Title Artist · Album" text, and the
        // global `:focus-visible` ring covers keyboard focus.
        className="flex min-w-0 flex-1 flex-col gap-px rounded"
      >
        <span
          className={`t-track-title truncate ${isCurrent ? "text-accent-hover" : "text-text-primary"}`}
        >
          {track.title}
        </span>
        <span className="t-metadata truncate">
          {track.artistName}
          {variant !== "queue" && track.albumName ? ` · ${track.albumName}` : ""}
        </span>
      </Link>
      {duration ? (
        // Selectable in principle, not in practice: a duration is a number, and
        // a pointer drag that crosses a column of them should not paint
        // `4:31 3:58 5:02` into the clipboard-adjacent selection. It is
        // available to keyboard users via the row's own text, and the title and
        // artist beside it - the parts worth copying - are untouched.
        <span className="hidden shrink-0 select-none text-xs tabular-nums text-text-muted sm:block">
          {duration}
        </span>
      ) : null}
      {canPlay ? (
        <button
          type="button"
          aria-label={isCurrentPlaying ? t("track.pauseLabel", { title: track.title }) : t("track.playLabel", { title: track.title })}
          onClick={handleClick}
          className="grid h-11 w-11 shrink-0 select-none place-items-center rounded-full text-text-primary transition-colors hover:bg-surface-active"
        >
          {isCurrentPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
      ) : (
        <button
          type="button"
          disabled
          aria-label={t("track.playbackUnavailableFor", { title: track.title })}
          title={t("track.playbackUnavailable")}
          className="grid h-11 w-11 shrink-0 cursor-not-allowed select-none place-items-center rounded-full text-text-disabled"
        >
          <PlayIcon size={18} />
        </button>
      )}
      {onRemoveFromPlaylist ? (
        <button
          type="button"
          aria-label={t("playlist.removeFromPlaylist", { title: track.title })}
          onClick={onRemoveFromPlaylist}
          className="grid h-11 w-11 shrink-0 select-none place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-active hover:text-danger"
        >
          <TrashIcon size={18} />
        </button>
      ) : null}
      {showMenu ? (
        <TrackActionMenu
          track={track}
          showLike={true}
          onLikeToggle={menuLikeToggle}
          isLiked={menuLiked}
          showAddToPlaylist={showAddToPlaylist}
        />
      ) : null}
    </div>
  );
}
