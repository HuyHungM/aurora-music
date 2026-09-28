"use client";

/**
 * What a resolved provider link looks like on the search page.
 *
 * Deliberately assembled from the components the text search already uses —
 * `TopResultCard` for the single-track case, `TrackList` for a collection —
 * because a pasted link is a second *entry point* to the same results, not a
 * second kind of result. Everything that decides whether a row can play, be
 * queued or be liked is still `trackCapabilities` / `collectionPlayability`,
 * and every action still goes through the engine's existing facades, so the
 * link path cannot behave differently from the search path.
 *
 * Nothing here resolves a stream: handing a `Track` to `engine.play()` is the
 * same hand-off `TrackRow` makes, and the controller resolves it at play time
 * through `PlaybackResolver`.
 */
import { useMemo } from "react";
import type { Track } from "@/lib/domain";
import type { SearchLinkResult } from "@/lib/search/resolve-link";
import { identityToTrack } from "@/lib/music/identity-track";
import { useMusicEngine } from "@/lib/music/use-music-engine";
import { collectionPlayability, trackCapabilities } from "@/lib/player/track-capabilities";
import { TrackList } from "@/components/tracks/track-list";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { PlayIcon, QueueIcon } from "@/components/ui/icons";
import { useLocale } from "@/components/i18n/locale-provider";
import { plural } from "@/lib/i18n/translate";
import { providerDisplayName } from "@/lib/search/input";
import { TopResultCard } from "./top-result-card";

export function LinkSearchResult({ resource }: { resource: SearchLinkResult }) {
  const { t } = useLocale();

  if (resource.kind === "track") {
    return (
      <section aria-label={t("search.linkResultSection")}>
        <h2 className="t-section-title mb-3">{t("search.linkResultSection")}</h2>
        <LinkTrackCard resource={resource} />
      </section>
    );
  }
  return <LinkCollectionCard resource={resource} />;
}

function LinkTrackCard({
  resource,
}: {
  resource: Extract<SearchLinkResult, { kind: "track" }>;
}) {
  const { t } = useLocale();
  const track = useMemo(
    () => identityToTrack(resource.track),
    [resource.track],
  );
  return (
    <TopResultCard
      track={track}
      eyebrow={`${providerDisplayName(resource.provider)} · ${t("search.resourceTrack")}`}
      actions={<TrackActionMenu track={track} showAddToPlaylist={true} />}
    />
  );
}

function LinkCollectionCard({
  resource,
}: {
  resource: Extract<SearchLinkResult, { kind: "collection" }>;
}) {
  const engine = useMusicEngine();
  const { locale, t } = useLocale();

  const tracks: Track[] = useMemo(
    () => resource.tracks.map(identityToTrack),
    [resource.tracks],
  );
  const playability = collectionPlayability(tracks);

  const playAll = () => {
    if (!engine || playability !== "playable") return;
    // Start at the first row that can actually play: a collection whose head
    // failed cross-source matching must not begin on a row that reports
    // "unavailable" and stop before a single second of audio.
    const start = tracks.findIndex((track) => trackCapabilities(track).canPlay);
    engine.playCollection(tracks, start < 0 ? 0 : start);
  };

  const queueAll = () => {
    if (!engine) return;
    // One entry per row through the existing add path, which already
    // de-duplicates, so a pasted collection can never inflate the queue with
    // repeated entries (SPEC §17).
    for (const track of tracks) {
      engine.queue.add(track);
    }
  };

  const kindLabel =
    resource.resourceKind === "album"
      ? t("search.resourceAlbum")
      : t("search.resourcePlaylist");

  return (
    <section
      aria-label={`${providerDisplayName(resource.provider)} · ${kindLabel}`}
      className="flex flex-col gap-6"
    >
      <div className="relative flex items-center gap-4 overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 p-4 sm:p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/[0.12] via-transparent to-transparent"
        />
        <Artwork
          src={resource.artworkUrl}
          alt={resource.title}
          size="medium"
          pixelSize={88}
          rounded="rounded-xl"
          eager
        />
        <div className="relative flex min-w-0 flex-1 flex-col gap-1">
          <span className="t-caption font-semibold uppercase tracking-[0.12em] text-accent">
            {`${providerDisplayName(resource.provider)} · ${kindLabel}`}
          </span>
          <h2 className="t-section-title break-words">{resource.title}</h2>
          <span className="t-metadata text-text-muted">
            {plural(locale, tracks.length, {
              one: t("search.collectionCountOne"),
              other: t("search.collectionCount"),
            })}
            {resource.total > tracks.length
              ? ` · ${t("search.collectionTruncated", {
                  shown: tracks.length,
                  total: resource.total,
                })}`
              : ""}
          </span>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={queueAll}
            disabled={tracks.length === 0}
            aria-label={t("search.queueAll")}
            title={t("search.queueAll")}
          >
            <QueueIcon size={18} />
          </Button>
          <Button
            variant="primary"
            size="icon"
            onClick={playAll}
            disabled={playability !== "playable"}
            aria-label={t("search.playAll")}
            title={t("search.playAll")}
          >
            <PlayIcon size={18} />
          </Button>
        </div>
      </div>

      <div className="aurora-glass-edge rounded-2xl border border-border-subtle bg-surface-1/60 p-2">
        <TrackList
          tracks={tracks}
          showMenu={true}
          showAddToPlaylist={true}
          variant="playlist"
          numbered={true}
        />
      </div>
    </section>
  );
}
