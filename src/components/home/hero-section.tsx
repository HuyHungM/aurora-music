"use client";

import type { Track } from "@/lib/domain";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { Artwork } from "@/components/ui/artwork";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";
import { formatTrackDuration } from "@/lib/player/format";

export function HeroSection({ track }: { track: Track }) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);

  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;

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
    <section
      aria-label={t("home.spotlightSection")}
      className="aurora-glass-edge relative overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/[0.16] via-transparent to-aurora-cyan/[0.10]"
      />
      <div className="relative grid gap-6 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex min-w-0 flex-col items-start gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-2/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-text-secondary">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-accent/25" />
            {t("home.spotlight")}
          </span>
          <h2 className="t-display break-words">{track.title}</h2>
          <p className="text-sm text-text-secondary">
            {track.artistName}
            {track.albumName ? ` · ${track.albumName}` : ""}
            {formatTrackDuration(track.duration)
              ? ` · ${formatTrackDuration(track.duration)}`
              : ""}
          </p>
          <button
            type="button"
            onClick={handlePlay}
            aria-label={isCurrentPlaying ? t("track.pauseLabel", { title: track.title }) : t("track.playLabel", { title: track.title })}
            className="aurora-press mt-1 inline-flex h-12 items-center gap-2 rounded-full bg-accent px-7 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover hover:shadow-glow active:bg-accent-active"
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
        </div>
        <span className="relative block h-52 w-full overflow-hidden rounded-xl shadow-lg ring-1 ring-white/10 md:h-52 md:w-52">
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
