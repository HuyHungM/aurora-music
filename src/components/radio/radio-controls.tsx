"use client";

import { useSyncExternalStore } from "react";
import type { Artist, Track } from "@/lib/domain";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { useLocale } from "@/components/i18n/locale-provider";
import { getRadioSession, subscribeRadioSession } from "@/lib/radio/instance";
import type { RadioLabel, RecentStation } from "@/lib/radio/session";
import { Button } from "@/components/ui/button";
import { PlayIcon, RadioIcon } from "@/components/ui/icons";

/** Subscribes to the memory-only radio session (null-safe before mount). */
export function useRadioSession(): {
  active: boolean;
  generating: boolean;
  exhausted: boolean;
  error: string | null;
  recent: RecentStation[];
  label: RadioLabel | null;
} {
  // getSnapshot returns the session's stable state reference (never a
  // fresh object per call); field selection happens during render.
  const state = useSyncExternalStore(
    subscribeRadioSession,
    () => getRadioSession()?.getState() ?? null,
    () => null,
  );
  if (!state) {
    return {
      active: false,
      generating: false,
      exhausted: false,
      error: null,
      recent: [],
      label: null,
    };
  }
  return {
    active: state.active,
    generating: state.generating,
    exhausted: state.exhausted,
    error: state.error,
    recent: state.recent,
    label: state.label,
  };
}

export function StartTrackRadioButton({
  track,
  variant = "secondary",
  size = "sm",
}: {
  track: Track;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const session = useRadioSession();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={session.generating}
      aria-label={t("track.startRadioLabel")}
      onClick={() => {
        if (!engine) {
          return;
        }
        void getRadioSession()?.startTrackRadio(engine, track, {
          key: "radio.labelFromTrack",
          params: { title: track.title },
        });
      }}
      className="aurora-glass-nested aurora-press gap-1.5"
    >
      <RadioIcon size={16} />
      <span>{t("track.startRadio")}</span>
    </Button>
  );
}

export function StartArtistRadioButton({
  artist,
  variant = "secondary",
  size = "sm",
}: {
  artist: Pick<Artist, "provider" | "providerArtistId" | "id" | "name">;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const session = useRadioSession();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={session.generating}
      aria-label={t("artist.startRadioLabel", { name: artist.name })}
      onClick={() => {
        if (!engine) {
          return;
        }
        void getRadioSession()?.startArtistRadio(engine, artist, {
          key: "radio.labelFromArtist",
          params: { name: artist.name },
        });
      }}
      className="aurora-glass-nested aurora-press gap-1.5"
    >
      <RadioIcon size={16} />
      <span>{t("artist.startRadio")}</span>
    </Button>
  );
}

export function StartDiscoveryRadioButton({ autoStart = false }: { autoStart?: boolean }) {
  const engine = useMusicEngine();
  const { t } = useLocale();
  const session = useRadioSession();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="primary"
        size="md"
        disabled={session.generating}
        aria-label={t("radio.startDiscovery")}
        data-auto-start={autoStart ? "true" : undefined}
        onClick={() => {
          if (!engine) {
            return;
          }
          void getRadioSession()?.startDiscoveryRadio(engine, {
            key: "radio.labelDiscovery",
          });
        }}
        className="aurora-glass-nested aurora-press gap-2"
      >
        <PlayIcon size={18} />
        <span>{session.generating ? t("radio.startingRadio") : t("radio.startDiscovery")}</span>
      </Button>
      {session.error ? (
        <p role="alert" className="text-sm text-red-400">
          {t(session.error)}
        </p>
      ) : null}
    </div>
  );
}

/** Active-station card for the /radio page (session memory only). */
export function ActiveStationCard() {
  const { t } = useLocale();
  const session = useRadioSession();
  if (!session.active || !session.label) {
    return null;
  }
  return (
    <div
      role="status"
      className="relative overflow-hidden rounded-2xl border border-accent/30 bg-surface-1 p-5"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/[0.12] via-transparent to-transparent"
      />
      <p className="t-eyebrow relative">{t("radio.nowPlayingAsRadio")}</p>
      <p className="t-section-title relative mt-1 truncate">
        {t(session.label.key, session.label.params)}
      </p>
      <p className="t-metadata relative mt-1">
        {session.generating
          ? t("radio.findingMore")
          : session.exhausted
            ? t("radio.ranOut")
            : t("radio.stationKeepsGoing")}
      </p>
    </div>
  );
}

/** Recently started stations (this session only — lightweight, no database). */
export function RecentStations() {
  const { t } = useLocale();
  const session = useRadioSession();
  if (session.recent.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {t("radio.recentEmpty")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {session.recent.map((entry) => (
        <li
          key={`${entry.mode}:${entry.label.key}:${entry.startedAt}`}
          className="aurora-glass-edge flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3"
        >
          <RadioIcon size={18} className="shrink-0 text-accent" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="t-card-title truncate">{t(entry.label.key, entry.label.params)}</span>
            <span className="t-caption">
              {entry.mode === "track"
                ? t("radio.trackRadio")
                : entry.mode === "artist"
                  ? t("radio.artistRadio")
                  : t("radio.discoveryRadio")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

