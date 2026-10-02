/**
 * PlaybackController: orchestration between PlaybackResolver and the
 * existing PlayerEngine.
 *
 * ```text
 * TrackIdentity
 *     ↓
 * PlaybackController
 *     ↓
 * PlaybackResolver
 *     ↓
 * AudioSource
 *     ↓
 * existing PlayerEngine
 *     ↓
 * HTMLAudioElement
 * ```
 *
 * The controller owns NO queue, NO persistent state, and NO recently-played
 * logic — those stay with the player store. It owns the ACTIVE resolved
 * source (memory only), transport intent (wantPlay), resolution
 * generations, and the ephemeral recovery machine (Phase 16).
 * Identities are never mutated; URLs are never persisted.
 *
 * Single playback path (Phase 11): the ONLY way a URL reaches PlayerEngine
 * is `withPlaybackSource` carrying a freshly resolved AudioSource. Legacy
 * `streamUrl`/`previewUrl` fields are never read as playback input here —
 * not even as a fallback. A track without a resolvable YouTube source
 * reports the existing unavailable state; the queue stays valid.
 *
 * Race model: every logical load claims a monotonic generation. A resolver
 * result applies ONLY when its generation is still current. Pause/next/stop
 * during resolution win by flag or by superseding generation — stale
 * results become inert, never cancelled (promises are ignored, not aborted).
 *
 * Recovery model (Phase 16): a mid-playback engine failure or a conservatively
 * detected stall starts ONE recovery cycle for the current generation —
 * duplicate signals collapse into it. Each cycle re-resolves the SAME stable
 * identity (same source order, no matcher, no new sources) up to
 * MAX_RECOVERY_ATTEMPTS rounds with bounded backoff, reloading at the saved
 * position (latest user seek wins). Permanent failures end the cycle
 * immediately; exhaustion reports the final error and records a suppression
 * so the same dead source cannot start a fresh spontaneous cycle. Any new
 * load, stop, or shutdown supersedes pending work; pause wins on transport
 * intent (the pending load completes paused, never autoplays).
 *
 * Expiry model: expired sources are never loaded. Play/resume against a
 * missing or expired source re-resolves the same stable identity once per
 * request (user-initiated paths stay single-shot). Mid-playback expiration
 * surfaces reactively as an engine error or stall — never via polling.
 */

import type {
  AudioSource,
  Track,
  TrackIdentity,
} from "@/lib/domain";
import {
  ExtractorError,
  PlaybackResolutionError,
  isAudioSourceExpired,
  isSourceType,
  mergeSourceReference,
  toTrackIdentity,
} from "@/lib/domain";
import type { SourceReference } from "@/lib/domain";
import type { PlayerErrorKind } from "@/lib/player/engine";
import { PlayerError } from "@/lib/player/engine";
import {
  createResolutionGuard,
  withPlaybackSource,
} from "@/lib/player/playback-source";
import type { PlaybackResolver } from "./resolver";
import {
  MAX_RECOVERY_ATTEMPTS,
  SEEK_STALL_GRACE_MS,
  STALL_PROGRESS_EPSILON_S,
  STALL_THRESHOLD_MS,
  clampResumePosition,
  classifyFailure,
  delayForRecoveryAttempt,
  idleDiagnostics,
} from "./recovery";
import { logger } from "@/lib/diagnostics/logger";
import type {
  FailureCategory,
  RecoveryDiagnostics,
} from "./recovery";

export interface ControllerEngineEventPayload {
  currentTime?: number;
  duration?: number;
  error?: PlayerError;
}

export type ControllerEngineEvent =
  | "error"
  | "timeupdate"
  | "waiting"
  | "stalled"
  | "playing"
  | "pause"
  | "ended"
  | "loadedmetadata"
  | "canplay";

export interface ControllerEngine {
  load(track: Track, autoplay: boolean): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  /** Exact element position/duration for resume capture. */
  snapshot(): { currentTime: number; duration: number };
  on(
    event: ControllerEngineEvent,
    listener: (payload: ControllerEngineEventPayload) => void,
  ): () => void;
}

export interface ControllerError {
  kind: PlayerErrorKind;
  message: string;
}

/** `(callback, delayMs) => cancel`. Injected for deterministic tests. */
export type RecoverySchedule = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface PlaybackControllerDeps {
  resolver: PlaybackResolver;
  engine: ControllerEngine;
  reportError: (error: ControllerError) => void;
  now?: () => number;
  schedule?: RecoverySchedule;
  /** Clears the user-facing error when a recovery cycle takes over. */
  clearError?: () => void;
  /**
   * Called once when a URL is recorded dead after an exhausted recovery
   * cycle. The implementation invalidates the server-side resolution cache
   * entry so the next attempt re-resolves instead of replaying the cached
   * poison. Fire-and-forget: it must never throw into the controller.
   */
  reportDeadSource?: (ref: { source: string; id: string }) => void;
}

export interface LoadTrackOptions {
  autoplay?: boolean;
}

export interface PlaybackController {
  /** Loads a legacy track: canonicalize, resolve, bridge-load. */
  loadTrack(track: Track, options?: LoadTrackOptions): void;
  /** Resume intent: play loaded source, or re-resolve when missing/expired. */
  ensurePlaying(): Promise<void>;
  /**
   * Background resolution for a track that is LIKELY next. Never reports
   * errors, never touches the engine or recovery: on success the source waits
   * in a one-entry slot that `loadTrack` consumes when (and only when) the
   * same identity arrives with a live, unsuppressed URL. Total fire-and-forget
   * for the caller — failures vanish, stale arrivals fill a slot that key
   * validation will refuse.
   */
  prefetchTrack(track: Track): void;
  /** Pause intent: synchronous engine pause; defeats pending autoplay. */
  pause(): void;
  /** Records a user seek request for pending resolutions. */
  notifySeekRequest(seconds: number): void;
  /** Invalidates pending work and pauses. Queues call this on clear. */
  stop(): void;
  currentGeneration(): number;
  /** True while a recovery cycle awaits its outcome. */
  isRecovering(): boolean;
  /** URL-free diagnostics for the current or most recent cycle. */
  getRecoveryDiagnostics(): RecoveryDiagnostics;
  /** Invalidates everything, detaches listeners, drops references. */
  shutdown(): void;
}

interface ActiveCycle {
  generation: number;
  /** Stable `provider:id` — never a URL. */
  trackKey: string;
  /** Resolve+reload rounds started (bounded by MAX_RECOVERY_ATTEMPTS). */
  attemptsUsed: number;
  /** Per-round token: stale round results drop even within a generation. */
  round: number;
  phase: "resolving" | "awaiting" | "backoff";
  /** Engine position captured when the cycle started. */
  resumePosition: number;
  failures: FailureCategory[];
  lastFailureCategory: FailureCategory | null;
}

interface FinishedCycle {
  trackKey: string;
  attemptsUsed: number;
  failures: FailureCategory[];
  result: "recovered" | "failed";
  updatedAtMs: number;
}

function isCarriedSourceReference(value: unknown): value is SourceReference {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SourceReference>;
  return (
    isSourceType(candidate.source) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  );
}

function identityFromTrack(track: Track): TrackIdentity | null {
  let base: TrackIdentity;
  try {
    base = toTrackIdentity(track);
  } catch {
    return null;
  }
  // Restore explicitly merged sources carried by search-handoff tracks
  // (`metadata.sources`, written by the TrackIdentity→Track adapter).
  // This is restoration, not matching: only well-formed references are
  // accepted, and merge semantics (primary preserved, deduped) apply.
  const carried = track.metadata?.sources;
  if (!Array.isArray(carried)) {
    return base;
  }
  let current = base;
  for (const entry of carried) {
    if (isCarriedSourceReference(entry)) {
      current = mergeSourceReference(current, {
        source: entry.source,
        id: entry.id,
        ...(typeof entry.url === "string" ? { url: entry.url } : {}),
        ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
      });
    }
  }
  return current;
}

function identityKey(identity: TrackIdentity): string {
  return `${identity.primarySource.source}:${identity.primarySource.id}`;
}

function toControllerError(error: unknown): ControllerError {
  if (error instanceof PlaybackResolutionError) {
    return { kind: "unavailable", message: error.message };
  }
  if (error instanceof ExtractorError) {
    return { kind: "unavailable", message: error.message };
  }
  if (error instanceof PlayerError) {
    return { kind: error.kind, message: error.message };
  }
  return { kind: "playback", message: "Playback failed unexpectedly." };
}

function defaultSchedule(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export function createPlaybackController(
  deps: PlaybackControllerDeps,
): PlaybackController {
  const { resolver, engine, reportError } = deps;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const clearError = deps.clearError ?? (() => undefined);
  const reportDeadSource = deps.reportDeadSource;
  const guard = createResolutionGuard();

  /**
   * L1 in-flight coalescing for source resolution, keyed by stable identity
   * (`provider:id`). Identical concurrent resolutions share ONE promise, so a
   * duplicate click or a double-fired effect spends one upstream call instead
   * of two. The entry is deleted the moment the promise settles (success or
   * failure), so this never becomes a cache: a later, genuinely new load
   * always resolves fresh. A settled promise is shared too, but only across
   * callers that were already awaiting it.
   */
  const inFlight = new Map<string, Promise<AudioSource>>();

  let disposed = false;
  let wantPlay = false;
  let pendingSeek: { generation: number; seconds: number } | null = null;
  let activeIdentity: TrackIdentity | null = null;
  let activeSource: AudioSource | null = null;
  let hasLoadedSource = false;
  let hasPlayedOnce = false;
  let lastDuration = 0;
  /**
   * Generation that installed the currently loaded source. `ended` arrives
   * on the source this points at, so it is the only generation allowed to
   * tear that source's transport intent down. See `onEnded`.
   */
  let sourceGeneration: number | null = null;

  // --- Recovery machine (Phase 16, ephemeral) ---
  let cycle: ActiveCycle | null = null;
  let lastFinished: FinishedCycle | null = null;
  let suppressedFailures: Array<{ generation: number; url: string }> = [];
  let diagnosticsAt = now();

  /**
   * One-entry prefetch slot: a resolved source for an identity that has not
   * been loaded yet. Consumption validates key + expiry + suppression at the
   * moment of use, so a stale arrival can fill this and still never play.
   * Deliberately ONE entry, not a map: the only consumer is the next load,
   * and anything older is trivia the next prefetch overwrites.
   */
  let prefetched: { key: string; source: AudioSource } | null = null;

  // --- Stall observation ---
  // wantPlay is transport INTENT; elementPaused tracks the element itself.
  // They are separate on purpose: an element pause event (media keys,
  // autoplay blocks, superseded autoplay races) must stop stall monitoring
  // without clobbering the intent a newer load just recorded.
  let elementPaused = false;
  let lastProgressAt = 0;
  let lastEventAt = 0;
  let lastProgressPosition = -1;
  let waitingFlag = false;
  let seekGraceUntil = 0;
  let stallTimerCancel: (() => void) | null = null;
  const pendingTimerCancels = new Set<() => void>();

  function isCurrent(generation: number): boolean {
    return !disposed && guard.isCurrent(generation);
  }

  function touchDiagnostics(): void {
    diagnosticsAt = now();
  }

  function later(
    delayMs: number,
    generation: number,
    fn: () => void,
  ): void {
    const cancel = schedule(() => {
      pendingTimerCancels.delete(cancel);
      if (!isCurrent(generation)) {
        return;
      }
      fn();
    }, delayMs);
    pendingTimerCancels.add(cancel);
  }

  function clearPendingTimers(): void {
    for (const cancel of [...pendingTimerCancels]) {
      try {
        cancel();
      } catch {
        // Timer already fired; nothing to cancel.
      }
    }
    pendingTimerCancels.clear();
  }

  function disarmStallTimer(): void {
    if (stallTimerCancel) {
      try {
        stallTimerCancel();
      } catch {
        // Timer already fired; nothing to cancel.
      }
      stallTimerCancel = null;
    }
  }

  function armStallTimer(delayMs: number = STALL_THRESHOLD_MS): void {
    disarmStallTimer();
    if (disposed) {
      return;
    }
    const generation = guard.current();
    stallTimerCancel = schedule(() => {
      stallTimerCancel = null;
      onStallTimer(generation);
    }, delayMs);
  }

  /**
   * Records element progress. The waiting flag clears ONLY on genuine
   * progress: frozen timeupdates must not erase the stall evidence, or a
   * position frozen at 100s with a prior waiting signal would never trip
   * detection. Backward jumps (loop/restart) also count as progress.
   */
  function noteProgress(position: number | undefined): void {
    const at = now();
    lastEventAt = at;
    if (typeof position !== "number" || !Number.isFinite(position)) {
      return;
    }
    if (
      lastProgressPosition < 0 ||
      position - lastProgressPosition >= STALL_PROGRESS_EPSILON_S ||
      position < lastProgressPosition - STALL_PROGRESS_EPSILON_S
    ) {
      lastProgressAt = at;
      lastProgressPosition = position;
      waitingFlag = false;
    }
  }

  /** Fresh playback phase (playing started, metadata arrived). */
  function resetProgressBaseline(): void {
    const at = now();
    lastProgressAt = at;
    lastEventAt = at;
    lastProgressPosition = -1;
    waitingFlag = false;
  }

  function resetStallBaseline(): void {
    resetProgressBaseline();
    seekGraceUntil = 0;
  }

  function isSuppressed(generation: number, url: string | null): boolean {
    if (!url) {
      return false;
    }
    return suppressedFailures.some(
      (entry) => entry.generation === generation && entry.url === url,
    );
  }

  function snapshotPosition(): { position: number; duration: number } {
    try {
      const snap = engine.snapshot();
      const position =
        Number.isFinite(snap.currentTime) && snap.currentTime > 0
          ? snap.currentTime
          : 0;
      const duration =
        Number.isFinite(snap.duration) && snap.duration > 0
          ? snap.duration
          : 0;
      return { position, duration };
    } catch {
      return { position: 0, duration: 0 };
    }
  }

  function activeCycle(generation: number): ActiveCycle | null {
    if (!cycle || cycle.generation !== generation || !isCurrent(generation)) {
      return null;
    }
    return cycle;
  }

  function startRecoveryCycle(category: FailureCategory): void {
    if (disposed || !activeIdentity || !activeSource) {
      return;
    }
    const generation = guard.current();
    if (activeCycle(generation) || isSuppressed(generation, activeSource.url)) {
      return;
    }
    const snap = snapshotPosition();
    if (snap.duration > 0) {
      lastDuration = snap.duration;
    }
    cycle = {
      generation,
      trackKey: identityKey(activeIdentity),
      attemptsUsed: 0,
      round: 0,
      phase: "backoff",
      resumePosition: snap.position,
      failures: [category],
      lastFailureCategory: category,
    };
    touchDiagnostics();
    // Take over error surfacing: the store clears its transient error and
    // stays silent until this cycle reports its final outcome (or the
    // element plays again, which clears it too).
    clearError();
    logger.warn("Playback recovery started", {
      event: "playback_recovery_started",
      trackKey: cycle.trackKey,
      category,
    });
    armStallTimer();
    scheduleRecoveryRound(cycle, 1);
  }

  function scheduleRecoveryRound(target: ActiveCycle, attempt: number): void {
    target.phase = "backoff";
    touchDiagnostics();
    later(delayForRecoveryAttempt(attempt), target.generation, () => {
      const current = activeCycle(target.generation);
      if (!current || current !== target) {
        return;
      }
      void runRecoveryRound(current);
    });
  }

  async function runRecoveryRound(target: ActiveCycle): Promise<void> {
    if (!activeIdentity) {
      return;
    }
    if (target.attemptsUsed >= MAX_RECOVERY_ATTEMPTS) {
      finalizeCycle(false, {
        kind: "playback",
        message: "Playback failed unexpectedly.",
      });
      return;
    }
    target.attemptsUsed += 1;
    target.round += 1;
    target.phase = "resolving";
    touchDiagnostics();
    const { generation, round } = target;
    // Seed the resume position; an explicit user seek recorded for this
    // generation later overwrites it (latest intent wins).
    if (!pendingSeek || pendingSeek.generation !== generation) {
      pendingSeek = {
        generation,
        seconds: clampResumePosition(target.resumePosition, lastDuration),
      };
    }
    let source: AudioSource;
    try {
      source = await resolver.resolve(activeIdentity);
    } catch (error) {
      if (!isCurrent(generation) || activeCycle(generation)?.round !== round) {
        return;
      }
      onRoundResolveFailure(error);
      return;
    }
    if (!isCurrent(generation) || activeCycle(generation)?.round !== round) {
      return;
    }
    if (isAudioSourceExpired(source, now())) {
      // A freshly resolved source that is already expired cannot help;
      // report without spending further rounds on the same staleness.
      finalizeCycle(false, {
        kind: "unavailable",
        message: "This track has no playable stream right now.",
      });
      return;
    }
    activeSource = source;
    sourceGeneration = generation;
    hasLoadedSource = true;
    hasPlayedOnce = false;
    elementPaused = false;
    const autoplay = wantPlay;
    engine.load(withPlaybackSource(identityToLegacyTrack(activeIdentity), source), autoplay && wantPlay);
    target.phase = "awaiting";
    touchDiagnostics();
    if (pendingSeek && pendingSeek.generation === generation) {
      const seconds = pendingSeek.seconds;
      pendingSeek = null;
      engine.seek(seconds);
    }
    armStallTimer();
  }

  function onRoundResolveFailure(error: unknown): void {
    if (!cycle) {
      return;
    }
    const classification = classifyFailure(error);
    if (
      classification.category === "permanent" ||
      classification.category === "autoplay" ||
      classification.category === "aborted"
    ) {
      finalizeCycle(false, toControllerError(error));
      return;
    }
    onRoundFailure(classification.category, toControllerError(error));
  }

  function onRoundFailure(
    category: FailureCategory,
    finalError: ControllerError,
  ): void {
    if (!cycle) {
      return;
    }
    cycle.failures.push(category);
    cycle.lastFailureCategory = category;
    touchDiagnostics();
    if (cycle.attemptsUsed >= MAX_RECOVERY_ATTEMPTS) {
      finalizeCycle(false, finalError);
      return;
    }
    logger.debug("Playback recovery round failed", {
      event: "playback_recovery_attempt",
      trackKey: cycle.trackKey,
      attempt: cycle.attemptsUsed,
      category,
    });
    scheduleRecoveryRound(cycle, cycle.attemptsUsed + 1);
  }

  function finalizeCycle(
    recovered: boolean,
    finalError: ControllerError | null = null,
  ): void {
    const finished = cycle;
    cycle = null;
    if (!recovered || !wantPlay) {
      // A failed track is dead: no monitoring until new user action.
      // A paused recovery succeeded: nothing audible to monitor.
      disarmStallTimer();
    }
    if (finished) {
      lastFinished = {
        trackKey: finished.trackKey,
        attemptsUsed: finished.attemptsUsed,
        failures: [...finished.failures],
        result: recovered ? "recovered" : "failed",
        updatedAtMs: now(),
      };
    }
    touchDiagnostics();
    if (recovered) {
      // Fresh budget for later unrelated failures; success wipes the
      // suppression record for this generation.
      suppressedFailures = [];
      if (finished) {
        logger.info("Playback recovery succeeded", {
          event: "playback_recovery_succeeded",
          trackKey: finished.trackKey,
          attempts: finished.attemptsUsed,
        });
      }
      return;
    }
    if (activeSource) {
      suppressedFailures.push({
        generation: finished?.generation ?? guard.current(),
        url: activeSource.url,
      });
      if (suppressedFailures.length > 8) {
        suppressedFailures.splice(0, suppressedFailures.length - 8);
      }
      // The URL this cycle died on is overwhelmingly likely to be the same
      // signed URL the server cache still holds for this video. Telling the
      // server invalidates that entry so the next attempt re-resolves instead
      // of replaying the cached poison. Best-effort and guarded: the lock must
      // survive a reporting failure, and only youtube identities resolve
      // server-side at all.
      try {
        const youtube = activeIdentity?.sources.find(
          (entry) => entry.source === "youtube",
        );
        if (youtube) {
          reportDeadSource?.({ source: "youtube", id: youtube.id });
        }
      } catch {
        // Reporting must never break the terminal path it annotates.
      }
    }
    if (finalError) {
      logger.error("Playback recovery exhausted", {
        event: "playback_recovery_failed",
        trackKey: finished?.trackKey ?? null,
        attempts: finished?.attemptsUsed ?? 0,
        category: finished?.lastFailureCategory ?? "unknown",
        message: finalError.message,
      });
      reportError(finalError);
    }
  }

  function onStallTimer(generation: number): void {
    if (!isCurrent(generation)) {
      return;
    }
    if (!wantPlay || elementPaused || !hasLoadedSource || !hasPlayedOnce) {
      return;
    }
    const at = now();
    if (at < seekGraceUntil) {
      armStallTimer();
      return;
    }
    const noProgress = at - lastProgressAt >= STALL_THRESHOLD_MS;
    const signaled = waitingFlag || at - lastEventAt >= STALL_THRESHOLD_MS;
    if (!noProgress || !signaled) {
      armStallTimer();
      return;
    }
    const current = activeCycle(generation);
    if (current) {
      // The pending round produced no progress: consume budget once.
      // Duplicate bursts collapse here — only one outcome per round, and
      // backoff waits are never cut short by a second consumption.
      if (current.phase === "backoff") {
        armStallTimer();
        return;
      }
      // Invalidate a possibly hung resolver promise before retrying so a
      // late arrival drops instead of double-loading.
      current.round += 1;
      current.phase = "backoff";
      onRoundFailure("transient", {
        kind: "playback",
        message: "Playback stalled and could not recover.",
      });
      return;
    }
    if (!activeIdentity || !activeSource) {
      return;
    }
    if (isSuppressed(generation, activeSource.url)) {
      return;
    }
    startRecoveryCycle("transient");
  }

  function onEngineError(payload: { error?: PlayerError }): void {
    if (disposed) {
      return;
    }
    const classification = classifyFailure(payload.error);
    // Autoplay blocks need a user gesture: the store surfaces them (never
    // suppressed) and the controller stays out of the way.
    if (classification.category === "autoplay") {
      return;
    }
    // Superseded loads are not failures.
    if (classification.category === "aborted") {
      return;
    }
    const generation = guard.current();
    const current = activeCycle(generation);
    if (current) {
      // In-flight guard (§39): concurrent bursts for the same round
      // collapse — only the outstanding round consumes the signal, once.
      if (current.phase !== "awaiting") {
        return;
      }
      current.phase = "backoff";
      if (
        classification.category === "permanent"
      ) {
        finalizeCycle(false, toControllerError(payload.error));
        return;
      }
      onRoundFailure(classification.category, toControllerError(payload.error));
      return;
    }
    if (!activeIdentity || !activeSource) {
      return;
    }
    if (isSuppressed(generation, activeSource.url)) {
      return;
    }
    if (classification.category === "permanent") {
      // Nothing a fresh resolution could fix differently; the store has
      // already surfaced this error.
      return;
    }
    startRecoveryCycle(classification.category);
  }

  function onPlaying(): void {
    if (disposed) {
      return;
    }
    hasPlayedOnce = true;
    elementPaused = false;
    resetProgressBaseline();
    armStallTimer();
    if (cycle && isCurrent(cycle.generation)) {
      finalizeCycle(true);
    }
  }

  function onLoaded(): void {
    if (disposed) {
      return;
    }
    lastEventAt = now();
    lastProgressAt = now();
    waitingFlag = false;
    // A paused recovery load completes without ever playing: metadata is
    // its success signal (autoplay stays off per latest intent).
    if (cycle && isCurrent(cycle.generation) && !wantPlay) {
      finalizeCycle(true);
    }
  }

  function onBufferingStall(): void {
    if (disposed) {
      return;
    }
    waitingFlag = true;
    lastEventAt = now();
    armStallTimer();
  }

  function onElementPause(): void {
    if (disposed) {
      return;
    }
    // Element-level pause (media keys, autoplay blocks, superseded
    // autoplay races) stops stall monitoring. Transport INTENT is left
    // untouched: a newer load recorded its own wantPlay after this event
    // was queued, and clobbering it would break autoplay races.
    elementPaused = true;
    disarmStallTimer();
  }

  function onEnded(): void {
    if (disposed) {
      return;
    }
    // The store's own `ended` handler is subscribed first (player-host binds
    // the store before constructing this controller) and advances the queue
    // synchronously, so by the time this handler runs the store has already
    // claimed a NEWER generation carrying autoplay intent. Everything below
    // belongs to the generation that loaded the ended source, and autoplay is
    // applied as `autoplay && wantPlay` after an await — so clearing it here
    // would strand the freshly advanced track loaded but paused, silently
    // breaking gapless auto-advance on every natural transition. Bail out when
    // a newer generation owns the state; the old cycle was already reset by
    // `loadIdentity` -> `resetRecoveryForNewWork`.
    if (sourceGeneration !== null && sourceGeneration !== guard.current()) {
      return;
    }
    wantPlay = false;
    elementPaused = true;
    disarmStallTimer();
    // An ended source has no pending outcome worth recovering: cancel the
    // cycle AND its scheduled rounds so no timer outlives the lifecycle.
    clearPendingTimers();
    cycle = null;
  }

  function resetRecoveryForNewWork(): void {
    clearPendingTimers();
    disarmStallTimer();
    cycle = null;
    lastFinished = null;
    suppressedFailures = [];
    elementPaused = false;
    resetStallBaseline();
    touchDiagnostics();
  }

  /**
   * Resolves an identity through the in-flight coalescer. The first caller
   * for a key starts the upstream resolution; every concurrent caller with
   * the same key awaits that same promise.
   */
  function resolveIdentity(identity: TrackIdentity): Promise<AudioSource> {
    const key = identityKey(identity);
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = resolver.resolve(identity);
    inFlight.set(key, promise);
    const release = () => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    };
    // A rejection handler here is required: it clears the entry and keeps a
    // failed shared promise from surfacing as an unhandled rejection.
    promise.then(release, release);
    return promise;
  }

  /** True when this exact URL was recorded as dead by a terminal cycle. */
  function isUrlSuppressed(url: string): boolean {
    return suppressedFailures.some((entry) => entry.url === url);
  }

  async function resolveAndLoad(
    identity: TrackIdentity,
    track: Track | null,
    autoplay: boolean,
    generation: number,
  ): Promise<void> {
    let source: AudioSource;
    try {
      source = await resolveIdentity(identity);
    } catch (error) {
      if (!isCurrent(generation)) {
        return;
      }
      // The store advanced `currentTrack` and cleared `isPlaying` BEFORE
      // resolution, so the UI already shows the new track as paused-with-error
      // while the previous track's audio is still coming out of the element.
      // That is two surfaces disagreeing about what is playing — and it is
      // worse than cosmetic here: the cross-tab ownership host reads
      // `isPlaying: false` and broadcasts a `release()`, so a second tab claims
      // the session and both tabs emit audio.
      //
      // Pausing here makes the element agree with what the UI is showing. Only
      // on THIS path: `ensurePlaying`'s retry deliberately keeps the old track
      // audible while a fresh resolution is attempted, and that is a different
      // branch below.
      engine?.pause();
      activeSource = null;
      sourceGeneration = null;
      hasLoadedSource = false;
      reportError(toControllerError(error));
      return;
    }
    if (!isCurrent(generation)) {
      return;
    }
    applyResolvedSource(identity, track, autoplay, generation, source);
  }

  /**
   * Installs an already-resolved source: the shared terminal path for a fresh
   * resolution AND for a consumed prefetch. The expiry re-check is
   * load-bearing here, not paranoia: a prefetched source can sit in the slot
   * while the user finishes the current track, and handing an expired URL to
   * the element is exactly what the cache layer refused to do.
   */
  function applyResolvedSource(
    identity: TrackIdentity,
    track: Track | null,
    autoplay: boolean,
    generation: number,
    source: AudioSource,
  ): void {
    if (isAudioSourceExpired(source, now())) {
      activeSource = null;
      sourceGeneration = null;
      hasLoadedSource = false;
      reportError({ kind: "unavailable", message: "This track has no playable stream right now." });
      return;
    }
    activeSource = source;
    sourceGeneration = generation;
    hasLoadedSource = true;
    const playable = track ?? identityToLegacyTrack(identity);
    engine.load(withPlaybackSource(playable, source), autoplay && wantPlay);
    if (pendingSeek && pendingSeek.generation === generation) {
      const seconds = pendingSeek.seconds;
      pendingSeek = null;
      engine.seek(seconds);
    }
  }

  /**
   * Minimal legacy Track view for the engine bridge. Used only when the
   * caller resolved an identity without handing over its source Track
   * (recovery path). Never persisted, never identity.
   */
  function identityToLegacyTrack(identity: TrackIdentity): Track {
    const primary = identity.primarySource;
    return {
      id: primary.id,
      provider: primary.source,
      providerTrackId: primary.id,
      title: identity.title,
      artistId: identity.artists[0]?.id ?? primary.id,
      artistName: identity.artists[0]?.name ?? "Unknown artist",
      providerUrl: primary.url,
    };
  }

  function prefetchTrack(track: Track): void {
    if (disposed) {
      return;
    }
    const identity = identityFromTrack(track);
    if (!identity) {
      return;
    }
    const key = identityKey(identity);
    logger.debug("Playback prefetch started", {
      event: "playback_prefetch_started",
      trackKey: key,
    });
    // Already playing this with a live source: nothing to warm.
    if (
      activeIdentity &&
      identityKey(activeIdentity) === key &&
      hasLoadedSource &&
      activeSource &&
      !isAudioSourceExpired(activeSource, now()) &&
      !isUrlSuppressed(activeSource.url)
    ) {
      return;
    }
    // Already warmed and still good: do not spend a second resolution.
    if (
      prefetched &&
      prefetched.key === key &&
      !isAudioSourceExpired(prefetched.source, now()) &&
      !isUrlSuppressed(prefetched.source.url)
    ) {
      return;
    }
    // Through the SAME coalescer as real loads, so a prefetch racing the
    // actual tap shares one upstream promise instead of doubling it.
    void resolveIdentity(identity).then(
      (source) => {
        if (disposed) {
          return;
        }
        // Validated at consume time too, but a dead-on-arrival source must
        // not even occupy the slot: it could only ever be refused later.
        if (isAudioSourceExpired(source, now()) || isUrlSuppressed(source.url)) {
          return;
        }
        prefetched = { key, source };
        logger.debug("Playback prefetch stored", {
          event: "playback_prefetch_succeeded",
          trackKey: key,
        });
      },
      () => {
        // Silence is the contract: a prefetch exists to make the likely case
        // faster, never to surface the unlikely case. The real load, if the
        // user ever taps, reports its own failure through the normal path.
        logger.debug("Playback prefetch failed", {
          event: "playback_prefetch_failed",
          trackKey: key,
        });
      },
    );
  }

  function loadIdentity(
    identity: TrackIdentity,
    track: Track | null,
    autoplay: boolean,
  ): void {
    const generation = guard.claim();
    wantPlay = autoplay;
    pendingSeek = null;
    activeIdentity = identity;
    activeSource = null;
    // `sourceGeneration` deliberately survives here. It marks the generation
    // that installed the source the element is still playing, and `onEnded`
    // reads it to tell "my source just ended" apart from "a newer load
    // already took over". Clearing it at claim time would erase exactly the
    // evidence onEnded needs. It is re-pointed in resolveAndLoad once the new
    // source is actually installed, and cleared by stop()/shutdown().
    hasLoadedSource = false;
    hasPlayedOnce = false;
    resetRecoveryForNewWork();
    // A prefetched source for THIS identity skips the resolution round trip
    // entirely — but only when it is still the right answer: same key, live
    // URL, never recorded dead. Anything else falls through to a fresh
    // resolve, and the slot survives for a later load that does match.
    const key = identityKey(identity);
    const slot = prefetched;
    if (
      slot &&
      slot.key === key &&
      !isAudioSourceExpired(slot.source, now()) &&
      !isUrlSuppressed(slot.source.url)
    ) {
      prefetched = null;
      logger.debug("Playback consumed a prefetched source", {
        event: "playback_prefetch_consumed",
        trackKey: key,
      });
      applyResolvedSource(identity, track, autoplay, generation, slot.source);
      return;
    }
    void resolveAndLoad(identity, track, autoplay, generation);
  }

  /**
   * Re-loads a track whose identity already owns a fresh, live source.
   *
   * Re-clicking the track that is already resolved used to spend a full
   * upstream resolution for an identical identity. When the active source is
   * the same identity, still unexpired and not recorded dead, reinstall it
   * directly: the engine reload still restarts the media, but no network work
   * happens. This is the "reuse a valid resolved source" path (never a cache:
   * expiry and the suppression record both force a fresh resolve).
   */
  function loadReusingSource(track: Track, autoplay: boolean): void {
    if (!activeSource) {
      return;
    }
    const generation = guard.claim();
    wantPlay = autoplay;
    pendingSeek = null;
    sourceGeneration = generation;
    hasLoadedSource = true;
    hasPlayedOnce = false;
    resetRecoveryForNewWork();
    const source = activeSource;
    touchDiagnostics();
    logger.debug("Playback source reused", {
      event: "playback_source_reused",
      trackKey: activeIdentity ? identityKey(activeIdentity) : null,
    });
    engine.load(withPlaybackSource(track, source), autoplay && wantPlay);
    armStallTimer();
  }

  const unsubscribers: Array<() => void> = [
    engine.on("error", (payload) => onEngineError(payload)),
    engine.on("timeupdate", (payload) => {
      if (disposed) {
        return;
      }
      noteProgress(payload.currentTime);
    }),
    engine.on("waiting", () => onBufferingStall()),
    engine.on("stalled", () => onBufferingStall()),
    engine.on("playing", () => onPlaying()),
    engine.on("pause", () => onElementPause()),
    engine.on("ended", () => onEnded()),
    engine.on("loadedmetadata", (payload) => {
      if (disposed) {
        return;
      }
      if (typeof payload.duration === "number" && payload.duration > 0) {
        lastDuration = payload.duration;
      }
      onLoaded();
    }),
    engine.on("canplay", () => {
      if (!disposed) {
        onLoaded();
      }
    }),
  ];

  return {
    loadTrack(track: Track, options: LoadTrackOptions = {}): void {
      if (disposed) {
        return;
      }
      const autoplay = options.autoplay ?? true;
      const identity = identityFromTrack(track);
      if (!identity) {
        // No provider identity at all: immediately unavailable without a
        // wasted network call. Same end state as the engine's own
        // unavailable path (error set, not playing, not loading).
        guard.claim();
        wantPlay = autoplay;
        resetRecoveryForNewWork();
        reportError({
          kind: "unavailable",
          message: "This track has no playable stream right now.",
        });
        return;
      }
      // Re-clicking the track that already owns a fresh, live source reuses
      // it instead of spending another upstream resolution (same identity,
      // unexpired, not recorded dead).
      if (
        activeIdentity &&
        identityKey(activeIdentity) === identityKey(identity) &&
        hasLoadedSource &&
        activeSource &&
        !isAudioSourceExpired(activeSource, now()) &&
        !isUrlSuppressed(activeSource.url)
      ) {
        loadReusingSource(track, autoplay);
        return;
      }
      // Resolvable or not, resolution is the only path: an identity
      // without a YouTube-capable source fails at the match stage inside
      // the resolver. Legacy streamUrl/previewUrl fields are never read.
      loadIdentity(identity, track, autoplay);
    },

    prefetchTrack(track: Track): void {
      prefetchTrack(track);
    },

    async ensurePlaying(): Promise<void> {
      if (disposed) {
        return;
      }
      wantPlay = true;
      // A source recorded as dead by a terminal recovery cycle must never
      // replay on user retry: a tap after exhaustion performs one fresh
      // single-shot resolution (gesture-backed) instead of replaying the
      // known-dead URL. Fresh and unknown sources play directly.
      if (
        hasLoadedSource &&
        activeSource &&
        !isAudioSourceExpired(activeSource, now()) &&
        !isSuppressed(guard.current(), activeSource.url)
      ) {
        try {
          await engine.play();
        } catch (error) {
          reportError(toControllerError(error));
        }
        return;
      }
      if (activeIdentity) {
        const generation = guard.claim();
        pendingSeek = null;
        // A user-initiated fresh resolve is new work: new source, new
        // baseline. (Active recovery cycles, if any, are superseded by
        // the claimed generation.)
        hasPlayedOnce = false;
        resetRecoveryForNewWork();
        await resolveAndLoad(activeIdentity, null, true, generation);
        return;
      }
      try {
        await engine.play();
      } catch (error) {
        reportError(toControllerError(error));
      }
    },

    pause(): void {
      wantPlay = false;
      elementPaused = true;
      disarmStallTimer();
      engine.pause();
    },

    notifySeekRequest(seconds: number): void {
      if (!Number.isFinite(seconds)) {
        return;
      }
      pendingSeek = { generation: guard.current(), seconds };
      seekGraceUntil = now() + SEEK_STALL_GRACE_MS;
      lastProgressAt = now();
      lastEventAt = now();
      lastProgressPosition = seconds;
      waitingFlag = false;
    },

    stop(): void {
      guard.claim();
      wantPlay = false;
      elementPaused = true;
      pendingSeek = null;
      activeIdentity = null;
      activeSource = null;
      sourceGeneration = null;
      hasLoadedSource = false;
      hasPlayedOnce = false;
      prefetched = null;
      resetRecoveryForNewWork();
      engine.pause();
    },

    currentGeneration(): number {
      return guard.current();
    },

    isRecovering(): boolean {
      return cycle !== null;
    },

    getRecoveryDiagnostics(): RecoveryDiagnostics {
      if (cycle) {
        return {
          phase:
            cycle.phase === "awaiting" ? "awaiting-outcome" : cycle.phase,
          trackKey: cycle.trackKey,
          attemptsUsed: cycle.attemptsUsed,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          lastFailureCategory: cycle.lastFailureCategory,
          updatedAtMs: diagnosticsAt,
        };
      }
      if (lastFinished) {
        return {
          phase: lastFinished.result === "recovered" ? "recovered" : "failed",
          trackKey: lastFinished.trackKey,
          attemptsUsed: lastFinished.attemptsUsed,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          lastFailureCategory:
            lastFinished.failures[lastFinished.failures.length - 1] ?? null,
          updatedAtMs: lastFinished.updatedAtMs,
        };
      }
      return idleDiagnostics(now());
    },

    shutdown(): void {
      disposed = true;
      guard.claim();
      wantPlay = false;
      pendingSeek = null;
      activeIdentity = null;
      activeSource = null;
      sourceGeneration = null;
      hasLoadedSource = false;
      hasPlayedOnce = false;
      prefetched = null;
      clearPendingTimers();
      disarmStallTimer();
      cycle = null;
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // Detach is best-effort; shutdown must not throw.
        }
      }
    },
  };
}
