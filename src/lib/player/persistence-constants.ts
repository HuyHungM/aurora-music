/** How often the authenticated playback checkpoint is written (ms). */
export const PLAYBACK_CHECKPOINT_INTERVAL_MS = 12_000;

/** Minimum position delta (seconds) before a checkpoint write is issued. */
export const PLAYBACK_POSITION_THRESHOLD_S = 2;

/** How long a restored position remains eligible for binding after track restore. */
export const RESTORE_SEEK_GRACE_MS = 5_000;
