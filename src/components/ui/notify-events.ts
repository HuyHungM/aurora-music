import { notifyNotification } from "@/components/ui/notifications";
import type { Track } from "@/lib/domain";

/** Resolved-string translator (the `t()` shape, without the hook). */
export type ResolveStrings = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * One place for the "what just happened?" toasts.
 *
 * Feature code owns WHEN an action succeeded or failed; this module owns the
 * vocabulary. Every poster takes a resolved `t` — the store stays
 * locale-free, and no poster may call `useLocale()` itself. That keeps this
 * module a React-free poster file: importing it never pulls the locale
 * provider graph, so lazily importing it inside a mutation path cannot
 * disturb action mocks or hermetic suites.
 *
 * Grouping rule: steady hands, not per-row echoes. Repeat posts with the
 * same id replace, never stack, so rapid Like/Unlike flips collapse into
 * the latest truth instead of a chattering history.
 */

function queueIdFor(track: Pick<Track, "provider"> & { providerTrackId?: string; id: string }): string {
  return `queue:${track.provider}:${track.providerTrackId ?? track.id}`;
}

export interface QueueNotifications {
  added: (track: Track) => void;
  playNext: (track: Track) => void;
  addedMany: (count: number) => void;
  removed: (track: Track) => void;
}

/** Caller passes its own `t()`; nothing here reads locale. */
export function queueNotifications(t: ResolveStrings): QueueNotifications {
  return {
    added: (track) =>
      notifyNotification({
        id: queueIdFor(track),
        kind: "success",
        title: t("queue.addedTitle"),
        message: t("queue.addedMessage", { title: track.title }),
      }),
    playNext: (track) =>
      notifyNotification({
        id: queueIdFor(track),
        kind: "success",
        title: t("queue.playNextTitle"),
        message: t("queue.playNextMessage", { title: track.title }),
      }),
    // Grouped: one toast for a batch, never one per row.
    addedMany: (count) =>
      notifyNotification({
        id: "queue:added-many",
        kind: "success",
        title: t("queue.addedManyTitle"),
        message: t("queue.addedManyMessage", { count }),
      }),
    removed: (track) =>
      notifyNotification({
        id: queueIdFor(track),
        kind: "info",
        title: t("queue.removedTitle"),
        message: t("queue.removedMessage", { title: track.title }),
      }),
  };
}

/** Queue-natural-end: emitted once per `queueEnd`, never for an empty start. */
export function notifyQueueFinished(resolve: ResolveStrings): void {
  notifyNotification({
    id: "queue:finished",
    kind: "info",
    title: resolve("queue.finishedTitle"),
    message: resolve("queue.finishedMessage"),
  });
}

export interface RadioNotifications {
  startedTrack: (track: Track) => void;
  startedArtist: (name: string) => void;
  startedDiscovery: () => void;
  failed: () => void;
}

/** Caller passes its own `t()`; nothing here reads locale. */
export function radioNotifications(t: ResolveStrings): RadioNotifications {
  return {
    startedTrack: (track) =>
      notifyNotification({
        id: `radio:started:track:${track.provider}:${track.providerTrackId ?? track.id}`,
        kind: "success",
        title: t("radio.startedTitle"),
        message: t("radio.startedTrackMessage", { title: track.title }),
      }),
    startedArtist: (name) =>
      notifyNotification({
        id: `radio:started:artist:${name}`,
        kind: "success",
        title: t("radio.startedTitle"),
        message: t("radio.startedArtistMessage", { name }),
      }),
    startedDiscovery: () =>
      notifyNotification({
        id: "radio:started:discovery",
        kind: "success",
        title: t("radio.startedTitle"),
        message: t("radio.startedDiscoveryMessage"),
      }),
    failed: () =>
      notifyNotification({
        id: "radio:start-failed",
        kind: "error",
        title: t("radio.startFailedTitle"),
        message: t("radio.startFailedMessage"),
      }),
  };
}

export interface PlaylistNotifications {
  created: (title: string) => void;
  createFailed: () => void;
  removed: (trackTitle: string, playlistTitle: string) => void;
  /**
   * A removal that did not land. Exists because the detail page's removal had
   * `if (result.ok)` with no `else`: a rate limit, an authorization failure or a
   * transport drop left the row exactly where it was, with no toast, no inline
   * error and no re-render — the user clicked the bin and nothing at all
   * happened. Every sibling mutation on that page reports its failures.
   */
  removeFailed: (trackTitle: string) => void;
}

/** Caller passes its own `t()`; nothing here reads locale. */
export function playlistNotifications(t: ResolveStrings): PlaylistNotifications {
  return {
    created: (title) =>
      notifyNotification({
        id: `playlist:created:${title}`,
        kind: "success",
        title: t("playlist.createdTitle"),
        message: t("playlist.createdMessage", { title }),
      }),
    createFailed: () =>
      notifyNotification({
        id: "playlist:create-failed",
        kind: "error",
        title: t("playlist.createFailedTitle"),
        message: t("playlist.createFailedMessage"),
      }),
    removed: (trackTitle, playlistTitle) =>
      notifyNotification({
        id: `playlist:removed:${playlistTitle}:${trackTitle}`,
        kind: "info",
        title: t("playlist.removedTitle"),
        message: t("playlist.removedMessage", { title: trackTitle, playlist: playlistTitle }),
      }),
    removeFailed: (trackTitle) =>
      notifyNotification({
        id: `playlist:remove-failed:${trackTitle}`,
        kind: "error",
        title: t("playlist.removeFailedTitle"),
        message: t("playlist.removeFailedMessage", { title: trackTitle }),
      }),
  };
}

/** Poster for the add-to-playlist picker success path (picker-local). */
export function notifyPlaylistAdded(
  resolve: ResolveStrings,
  trackTitle: string,
  playlistTitle: string,
  playlistId: string,
): void {
  const hasPlaylist = playlistTitle.trim().length > 0;
  notifyNotification({
    id: `playlist:added:${playlistId}`,
    kind: "success",
    // With the name: "Added to X". Without (create-flow, name not yet
    // reloaded): fall back to the existing addedToTitle copy rather than
    // a raw id.
    title: hasPlaylist
      ? resolve("playlist.addedToTitle", { title: playlistTitle })
      : resolve("playlist.addedToTitle", { title: trackTitle }),
    message: hasPlaylist ? trackTitle : undefined,
  });
}

export interface LikeNotifications {
  liked: (track: Track) => void;
  unliked: (track: Track) => void;
  failed: () => void;
}

/** Caller passes its own `t()`; nothing here reads locale. */
export function likeNotifications(t: ResolveStrings): LikeNotifications {
  return {
    liked: (track) => notifyLikeResult(true, true, track, t),
    unliked: (track) => notifyLikeResult(true, false, track, t),
    failed: () => notifyLikeResult(false, true, null, t),
  };
}

/**
 * Locale-free poster for the shared-likes toggle (provider path).
 *
 * The provider must not pull the locale graph on render — so the resolved
 * translator is passed in. Standalone `LikeButton` uses `likeNotifications`
 * with its own `t()` instead.
 */
export function notifyLikeResult(
  ok: boolean,
  nextLiked: boolean,
  track: Track | null,
  resolve?: ResolveStrings,
): void {
  const title = (key: string, params?: Record<string, string | number>): string => {
    if (resolve) {
      return resolve(key, params);
    }
    // Test/harness fallback (English copy mirrors en.ts exactly).
    const table: Record<string, string> = {
      "track.likedTitle": "Liked",
      "track.unlikedTitle": "Like removed",
      "track.likeFailedTitle": "Couldn't like this track",
      "track.likeFailedMessage": "Try again in a moment.",
    };
    let template = table[key] ?? key;
    if (params?.title !== undefined) {
      template = template.replace("{title}", String(params.title));
    }
    return template;
  };
  const message = (key: string, params?: Record<string, string | number>): string => {
    if (resolve) {
      return resolve(key, params);
    }
    if (key === "track.likedMessage") {
      return `Added “${params?.title ?? ""}” to your library.`;
    }
    if (key === "track.unlikedMessage") {
      return `Removed “${params?.title ?? ""}” from your library.`;
    }
    return title(key, params);
  };
  if (!ok) {
    notifyNotification({
      id: "like:failed",
      kind: "error",
      title: title("track.likeFailedTitle"),
      message: message("track.likeFailedMessage"),
    });
    return;
  }
  if (!track) {
    return;
  }
  notifyNotification({
    id: `like:${track.provider}:${track.providerTrackId ?? track.id}`,
    kind: nextLiked ? "success" : "info",
    title: title(nextLiked ? "track.likedTitle" : "track.unlikedTitle"),
    message: message(nextLiked ? "track.likedMessage" : "track.unlikedMessage", {
      title: track.title,
    }),
  });
}

export interface FollowNotifications {
  followed: (name: string) => void;
  unfollowed: (name: string) => void;
  failed: () => void;
}

/** Caller passes its own `t()`; nothing here reads locale. */
export function followNotifications(t: ResolveStrings): FollowNotifications {
  return {
    followed: (name) =>
      notifyNotification({
        id: `follow:${name}`,
        kind: "success",
        title: t("artist.followedTitle"),
        message: t("artist.followedMessage", { name }),
      }),
    unfollowed: (name) =>
      notifyNotification({
        id: `follow:${name}`,
        kind: "info",
        title: t("artist.unfollowedTitle"),
        message: t("artist.unfollowedMessage", { name }),
      }),
    failed: () =>
      notifyNotification({
        id: "follow:failed",
        kind: "error",
        title: t("artist.followFailedTitle"),
        message: t("artist.followFailedMessage"),
      }),
  };
}
