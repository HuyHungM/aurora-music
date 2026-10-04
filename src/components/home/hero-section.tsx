"use client";

import type { Track } from "@/lib/domain";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { Artwork } from "@/components/ui/artwork";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";
import { formatTrackDuration } from "@/lib/player/format";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { useLikedTrack } from "@/components/tracks/liked-tracks";

export function HeroSection({ track }: { track: Track }) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;
  // Same shared like mirror every row/menu reads, so the hero menu's
  // Like row (and its auth prompt when logged out) matches the rest of
  // the product. No per-card state, no second menu.
  const sharedLike = useLikedTrack(track);

  const handlePlay = () => {
    if (!engine) {
      return;
    }
    if (isCurrentPlaying) {
      engine.pause();
    } else {
      void engine.play(track);
    }
  };

  return (
    // No `overflow-hidden` here, for the same reason as `EntityHeader` and
    // `TopResultCard`: the actions row holds a menu trigger, and a menu is
    // deliberately bigger than the row that opened it, so clipping the box
    // would cut the menu (the downward-opening hero menu overflows the
    // section's bottom padding — pinned by `menu-clipping.test.tsx`). The
    // wash and the artwork already round themselves, so the corners survive
    // without it; `rounded-2xl` clips the section's own background/border.
    <section
      aria-label={t("home.spotlightSection")}
      className="relative rounded-2xl border border-border-subtle bg-surface-1"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-accent/[0.16] via-transparent to-aurora-cyan/[0.10]"
      />
      <div className="relative grid gap-6 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex min-w-0 flex-col items-start gap-3">
          <span className="t-eyebrow">{t("home.spotlight")}</span>
          <h2 className="t-display break-words">{track.title}</h2>
          <p className="text-sm text-text-secondary">
            {track.artistName}
            {track.albumName ? ` · ${track.albumName}` : ""}
            {formatTrackDuration(track.duration)
              ? ` · ${formatTrackDuration(track.duration)}`
              : ""}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={handlePlay}
              aria-label={isCurrentPlaying ? t("track.pauseLabel", { title: track.title }) : t("track.playLabel", { title: track.title })}
              className="aurora-press inline-flex h-12 items-center gap-2 rounded-full bg-accent px-7 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              {isCurrentPlaying ? (
                <>
                  <PauseIcon size={18} /> {t("common.pause")}
                </>
              ) : (
                <>
                  <PlayIcon size={18} /> {t("home.playSpotlight")}
                </>
              )}
            </button>
            {/* The one canonical More button. Same `TrackActionMenu` (same
                trigger, same menu, same auth behavior) as every song card —
                placed beside Play so it never covers metadata, in normal
                flow beside it (never an absolute overlay). The section does
                not clip (see above), so the menu is never cut; it measures
                its own flip direction. */}
            <TrackActionMenu
              track={track}
              showLike={true}
              onLikeToggle={sharedLike?.toggle}
              isLiked={sharedLike?.liked ?? false}
              showAddToPlaylist={true}
            />
          </div>
        </div>
        <span className="relative block h-52 w-full overflow-hidden rounded-xl shadow-lg md:h-52 md:w-52">
          <Artwork
            src={track.artworkUrl}
            alt={track.title}
            size="large"
            pixelSize={208}
            rounded="rounded-xl"
            eager
            fill
          />
        </span>
      </div>
    </section>
  );
}
