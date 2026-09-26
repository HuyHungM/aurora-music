"use client";

import Link from "next/link";
import type { Track } from "@/lib/domain";
import { isIdentityOfTrack } from "@/lib/music/identity-track";
import { useMusicEngine, useMusicEngineState } from "@/lib/music/use-music-engine";
import { Artwork } from "@/components/ui/artwork";
import { useLocale } from "@/components/i18n/locale-provider";
import { PlayIcon, PauseIcon } from "@/components/ui/icons";
import { trackCapabilities } from "@/lib/player/track-capabilities";

export function TopResultCard({ track }: { track: Track }) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  const isCurrent = isIdentityOfTrack(currentTrack, track);
  const isCurrentPlaying = isCurrent && isPlaying;
  const canPlay = isCurrent || trackCapabilities(track).canPlay;
  const href = `/track/${encodeURIComponent(track.providerTrackId ?? track.id)}`;

  return (
    <div className="relative flex items-center gap-4 overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 p-4 sm:p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/[0.12] via-transparent to-transparent"
      />
      <Artwork
        src={track.artworkUrl}
        alt={track.title}
        size="medium"
        pixelSize={88}
        rounded="rounded-xl"
        eager
      />
      <div className="relative flex min-w-0 flex-1 flex-col gap-1">
        <span className="t-caption font-semibold uppercase tracking-[0.12em] text-accent">
          {t("topResult.eyebrow")}
        </span>
        <Link href={href} className="t-section-title truncate rounded hover:text-accent-hover">
          {track.title}
        </Link>
        <p className="t-metadata truncate">
          {track.artistName}
          {track.albumName ? ` · ${track.albumName}` : ""}
        </p>
      </div>
      {canPlay ? (
        <button
          type="button"
          onClick={() => {
            if (!engine) return;
            if (isCurrentPlaying) engine.pause();
            else void engine.play(track);
          }}
          aria-label={isCurrentPlaying ? t("track.pauseLabel", { title: track.title }) : t("track.playLabel", { title: track.title })}
          className="aurora-press relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          {isCurrentPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        </button>
      ) : (
        <button
          type="button"
          disabled
          aria-label={t("track.playbackUnavailableFor", { title: track.title })}
          title={t("track.playbackUnavailable")}
          className="relative grid h-12 w-12 shrink-0 cursor-not-allowed place-items-center rounded-full border border-border-subtle text-text-disabled"
        >
          <PlayIcon size={20} />
        </button>
      )}
    </div>
  );
}
