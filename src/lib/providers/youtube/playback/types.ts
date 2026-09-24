/**
 * Narrow internal boundary around youtubei.js for playback resolution.
 *
 * SERVER-ONLY. These types are the ONLY shape the resolver stack may use:
 * no youtubei.js class, session, player, cookie, or token type may leak
 * past this module. The resolver depends on `YouTubePlaybackClient`, never
 * on the library itself, so tests inject fakes and library upgrades touch
 * exactly one adapter file.
 */

/** One normalized audio/video format candidate from player information. */
export interface PlaybackFormatCandidate {
  /** Deciphered, directly usable media URL. Always present. */
  url: string;
  /** Full MIME type as reported (may include codecs parameter). */
  mimeType?: string;
  /** Bits per second as reported. */
  bitrate?: number;
  /** Approximate media duration in milliseconds as reported. */
  durationMs?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Normalized video playback information for one exact video id. */
export interface PlaybackMediaInfo {
  videoId: string;
  title?: string;
  /** Media duration in milliseconds when reliably reported. */
  durationMs?: number;
  isPrivate?: boolean;
  isLiveContent?: boolean;
  isUpcoming?: boolean;
  /** When the underlying stream URLs expire (authoritative when present). */
  expiresAt?: Date;
  formats: PlaybackFormatCandidate[];
}

export interface YouTubePlaybackClient {
  /**
   * Returns playback information for EXACTLY the given video id.
   * Never searches, never substitutes, never returns another video.
   * Throws normalized engine errors (see youtube-resolver mapping).
   */
  getMediaInfo(videoId: string): Promise<PlaybackMediaInfo>;
}
