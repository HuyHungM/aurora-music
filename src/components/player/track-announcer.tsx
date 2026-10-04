"use client";

import { useMusicEngineState } from "@/lib/music/use-music-engine";

/**
 * Announces the current track to screen readers — ONCE, from one place.
 *
 * WHY THIS EXISTS. The player is fully operable by keyboard and by assistive
 * technology, but it was completely SILENT: neither the mini player nor the
 * full player had an `aria-live` region on the track title, so a screen-reader
 * user pressing "next track" got no indication that anything happened. For the
 * core loop of a music application — "what is playing right now" — that is the
 * single most consequential accessibility gap in the product.
 *
 * WHY IT IS A SEPARATE COMPONENT RATHER THAN A REGION IN EACH PLAYER SURFACE.
 * Two live regions would mean two announcements for one track change whenever
 * both surfaces are mounted, which they are: the mini player is mounted at
 * every width and the full player is mounted (and merely hidden) whenever a
 * track is loaded. Announcing from the host makes "one transition, one
 * announcement" a structural property rather than something to remember.
 *
 * POLITENESS AND CADENCE. `polite`, because a track change is a status update
 * and must never interrupt whatever the listener is reading. The region is
 * mounted EMPTY from first paint — a live region inserted together with its
 * content is commonly not announced at all, which is the same failure the
 * notification host had (see `notification-host.tsx`) — and its text is the
 * track identity only, so the 1 Hz position tick cannot produce speech. React
 * only announces a changed text node, and the title changes once per track.
 */
export function TrackAnnouncer() {
  const currentTrack = useMusicEngineState((s) => s.currentTrack);
  const title = currentTrack?.title ?? "";
  const artist = currentTrack?.artists?.[0]?.name ?? "";

  const announcement = title && artist ? `${title} — ${artist}` : title;

  return (
    // `aria-live` WITHOUT `role="status"`. The two are equivalent to assistive
    // technology — `role="status"` is itself just an implicit `aria-live="polite"`
    // — but the player bar's error banner already uses `role="status"` for the
    // playback-failure message, and two elements competing for one role in the
    // same surface makes "which region spoke?" ambiguous for tests and for any
    // AT that enumerates regions. The explicit attribute announces identically
    // and leaves the error banner's role unambiguous.
    <div aria-live="polite" aria-atomic="true" data-track-announcer className="sr-only">
      {announcement}
    </div>
  );
}
