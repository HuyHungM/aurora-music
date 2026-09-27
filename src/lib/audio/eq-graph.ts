/**
 * The Aurora EQ audio graph (Phase 53 addendum).
 *
 * WHAT THE ARCHITECTURE WAS BEFORE, STATED PLAINLY, BECAUSE IT DECIDES
 * EVERYTHING HERE.
 *
 * `PlayerEngine` owns exactly one `AudioSurface` - created lazily by
 * `getDefaultEngine()` as `new Audio()` - and that element's output goes
 * STRAIGHT to the speakers. Aurora had no `AudioContext`, no Web Audio node and
 * no DSP of any kind before this file. So the pipeline the addendum describes
 * (`HTMLMediaElement -> AudioContext/DSP -> EQ -> preamp -> destination`) is
 * being BUILT here, not extended: the second stage did not exist.
 *
 * It is built as the minimum that can carry a real-time EQ without a second
 * playback authority:
 *
 *   HTMLAudioElement  ->  MediaElementAudioSourceNode
 *                      ->  BiquadFilterNode x10  (the bands, in order)
 *                      ->  GainNode              (the preamp)
 *                      ->  AudioContext.destination
 *
 * No second audio element. No second `AudioContext`. No second engine, no second
 * store, no second `play()`. The element, the `PlayerEngine`, the
 * `PlaybackController` and the media session are all untouched, and the EQ is a
 * pass-through they happen to route through. Playback does not know the EQ
 * exists, which is why a track change, a resolver retry or a queue transition
 * cannot reset it: there is nothing in that path that owns EQ state.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IRREVERSIBLE STEP, AND WHY THE ORDER BELOW IS WHAT IT IS
 * ---------------------------------------------------------------------------
 *
 * `createMediaElementSource(element)` RE-HOMES the element's output into the
 * graph. There is no supported way to put it back: once it has been called, the
 * element's audio reaches the speakers only by travelling through the context.
 * The spec says so, and browsers implement it so.
 *
 * That makes this a one-way door, and it means the order of operations is not
 * stylistic:
 *
 *   1. create the context            - inert
 *   2. build the ten filters         - inert, nothing is feeding them
 *   3. build the preamp and wire it   - inert
 *   4. connect the preamp to the destination
 *   5. ONLY NOW re-home the element
 *
 * Every failure mode before step 5 leaves the element playing directly and
 * untouched, which is the whole of addendum §33's "fail gracefully and keep
 * audio playback functional". If step 5 itself throws, the element is not
 * re-homed (that is what throwing means here) and the inert chain is torn down.
 * There is no ordering in which this module can leave somebody with no sound.
 *
 * THE COROLLARY, and the reason bypass is not a disconnect: once engaged, the
 * graph is permanent for the life of the page. Turning the EQ off sets every
 * band to 0 dB and the preamp to 0 dB and leaves the graph in place. Tearing it
 * down would not restore direct playback - it would produce SILENCE, which is
 * addendum §12's exact failure mode.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY WEB AUDIO CALL GOES THROUGH AN INJECTABLE DEPENDENCY
 * ---------------------------------------------------------------------------
 *
 * Vitest runs in Node and jsdom, neither of which has a working
 * `AudioContext`. If this module reached for the global directly, the parts
 * worth testing - that a preset change does not rebuild the graph, that a
 * parameter change is ramped rather than stepped, that bypass is unity rather
 * than a disconnect, that a failure never touches the element - would be
 * untestable, and they are the parts that are actually risky. So the context
 * and the element arrive as constructor dependencies, and `createEqGraph` is a
 * pure factory that a test can drive with a fake.
 */

import { logger } from "@/lib/diagnostics/logger";
import {
  EQ_BAND_FREQUENCIES,
  EQ_BAND_GAIN_MAX_DB,
  EQ_BAND_GAIN_MIN_DB,
  EQ_BAND_Q,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
  dbToLinear,
} from "./eq";

/* ==========================================================================
   DEPENDENCY SEAMS
   ========================================================================== */

/** The slice of `AudioParam` this module uses. */
export interface EqAudioParam {
  value: number;
  setValueAtTime(value: number, startTime: number): EqAudioParam;
  linearRampToValueAtTime(value: number, endTime: number): EqAudioParam;
  cancelScheduledValues(cancelTime: number): EqAudioParam;
}

export interface EqNode {
  connect(destination: EqNode): EqNode;
  disconnect(): void;
}

export interface EqBiquadNode extends EqNode {
  type: string;
  frequency: EqAudioParam;
  gain: EqAudioParam;
  Q: EqAudioParam;
}

export interface EqGainNode extends EqNode {
  gain: EqAudioParam;
}

export interface EqAudioContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  /** `running` | `suspended` | `closed` - mirrors the real API. */
  readonly state: string;
  readonly destination: EqNode;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBiquadFilter(): EqBiquadNode;
  createGain(): EqGainNode;
  createMediaElementSource(element: unknown): EqNode;
}

export interface EqGraphDeps {
  /**
   * Produces the ONE context. Called at most once per graph; a second call is a
   * bug, not a retry, and `createEqGraph` asserts that in its own tests.
   */
  createContext: () => EqAudioContext;
  /**
   * The canonical media element, or `null` when there is not one.
   *
   * Returning `null` is a supported, expected answer - it is what a server
   * render, a test with a fake audio surface, or a browser with no Web Audio
   * all look like - and it means the EQ stays disengaged rather than reaching
   * for an element of its own. An EQ that cannot find the application's audio
   * element must never create a second one.
   */
  getElement: () => unknown;
  /** Reported when the graph declines to engage. */
  onUnsupported?: (reason: EqUnsupportedReason) => void;
  /**
   * How long `engage()` waits for `AudioContext.resume()` to settle before it
   * stops waiting (test seam for {@link EQ_RESUME_TIMEOUT_MS}).
   *
   * The wait is BOUNDED deliberately. A `resume()` issued without a user
   * activation does not reject in every browser - Chromium keeps the promise
   * pending until a gesture arrives - and an unbounded `await` there would
   * leave `engage()` in flight forever. While it was in flight the store would
   * start another one on the next configuration change, and each of those
   * would build a second `AudioContext` and a second ten-filter chain.
   */
  resumeTimeoutMs?: number;
  /**
   * Subscribes to "the browser has just been given a user gesture", returning
   * the function that unsubscribes (§23's retry path).
   *
   * It is a dependency for the same reason `createContext` is: this module is
   * tested in Node, where there is no `document` to attach anything to, and a
   * graph whose only retry mechanism were a hard-coded `document.addEventListener`
   * would be untestable at the exact point where getting it wrong costs the
   * listener their audio. Returning nothing (or a no-op disposer) simply means
   * the graph never retries, which is a supported answer rather than a crash.
   */
  onUserGesture?: (handler: () => void) => () => void;
}

export type EqUnsupportedReason =
  | "no-web-audio"
  | "no-element"
  | "no-source";

/* ==========================================================================
   THE GRAPH
   ========================================================================== */

/**
 * Ramp length for every automated parameter change (addendum §29).
 *
 * 30 ms. Long enough to be inaudible as a step - a hard gain jump is a click,
 * and a hard filter sweep is a "zipper" - and short enough that the EQ still
 * feels like it responds to a slider rather than to a release. It is applied to
 * gain, to frequency and to Q alike, because a filter whose centre frequency
 * jumps while its gain is already changing produces an audible artefact that
 * smoothing only one of the two would not fix.
 */
export const EQ_RAMP_SECONDS = 0.03;

/**
 * How long a single engagement attempt waits for the context to start
 * (bugfix: mode switching without audio loss).
 *
 * WHY A BOUND EXISTS AT ALL. `AudioContext.resume()` is the last thing that
 * happens before the element is re-homed, and its behaviour when it is called
 * without a user activation is NOT uniform: Safari rejects, Chromium keeps the
 * promise pending until the first gesture. An unbounded `await` on the pending
 * form never returns, so `engage()` would sit in flight indefinitely and the
 * store - which pushes on every configuration change - would start another
 * engagement alongside it. Two engagements mean two contexts, two ten-filter
 * chains, and two calls to `createMediaElementSource` on one element, of which
 * exactly one can succeed.
 *
 * WHY ONE SECOND. The successful case resolves in a microtask, so this never
 * delays an engagement that was going to work; it only caps the case where the
 * browser is telling us, politely, "not yet". At the timeout the attempt gives
 * up WITHOUT touching the element, and the next user gesture starts a fresh
 * one under conditions the browser will accept.
 */
export const EQ_RESUME_TIMEOUT_MS = 1_000;

export interface EqGraphState {
  bands: readonly { frequency: number; gain: number; q: number }[];
  preampDb: number;
}

export class EqGraph {
  private context: EqAudioContext | null = null;
  private filters: EqBiquadNode[] = [];
  private preamp: EqGainNode | null = null;
  private source: EqNode | null = null;
  private engaged = false;
  private disposed = false;
  private failure: EqUnsupportedReason | null = null;

  /** The newest configuration anyone has asked for. The latest one wins. */
  private requested: EqGraphState | null = null;
  /**
   * The single engagement in flight, if there is one.
   *
   * WITHOUT THIS the store's fire-and-forget `push()` starts a second full
   * engagement the moment the first one has to wait - which it always has to,
   * because `engage()` awaits `resume()`. The second one builds a second
   * context and a second chain, then loses the race for the element and
   * reports `no-source`, which `decline()` stores PERMANENTLY. One in-flight
   * build, ever.
   */
  private inflight: Promise<boolean> | null = null;
  /**
   * Set when the graph is deliberately waiting for a user gesture rather than
   * having failed. Not a `failure`: nothing is wrong, the browser has simply
   * not been given a gesture yet, and the attempt repeats on the next one.
   */
  private awaitingGesture = false;
  /** Detaches the one-shot gesture listeners. */
  private gestureDetach: (() => void) | null = null;
  /** The last curve known to have been written successfully (§19 rollback). */
  private lastApplied: EqGraphState | null = null;

  constructor(private readonly deps: EqGraphDeps) {}

  get isEngaged(): boolean {
    return this.engaged;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * True while the graph is waiting for a user gesture before it may open the
   * one-way door. `false` in every state that a caller should report as an
   * error.
   */
  get isAwaitingGesture(): boolean {
    return this.awaitingGesture;
  }

  /** Why the EQ is not running, or `null` when it is (or has not tried). */
  get unsupportedReason(): EqUnsupportedReason | null {
    return this.failure;
  }

  /**
   * A cheap structural health check (§23), for diagnostics rather than for
   * control flow. It reads state that already exists - no scheduling, no
   * traversal of the node graph, nothing that could run per frame.
   */
  health(): {
    engaged: boolean;
    contextState: string;
    filterCount: number;
    preampConnected: boolean;
    awaitingGesture: boolean;
    failure: EqUnsupportedReason | null;
  } {
    return {
      engaged: this.engaged,
      contextState: this.context?.state ?? "none",
      filterCount: this.filters.length,
      preampConnected: this.preamp !== null,
      awaitingGesture: this.awaitingGesture,
      failure: this.failure,
    };
  }

  /** The live sample rate, or `null` before engagement. */
  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /** How many filter nodes exist. Ten when engaged, and never more. */
  get nodeCount(): number {
    return this.filters.length;
  }

  /**
   * Brings the graph up and points it at the current configuration.
   *
   * THREE QUESTIONS, ANSWERED SEPARATELY. The previous implementation asked
   * only the first, and conflating them is what made mode switching lose
   * audio:
   *
   *   1. is the graph BUILT?              -> `build()`, once, ever
   *   2. is it TOLD the current curve?    -> `apply()`, on every change
   *   3. is the context PRODUCING audio?  -> checked before the one-way door
   *
   * Question 1 used to swallow 2: `engage()` returned `this.engaged` when the
   * graph was already up, and because the store routes EVERY enabled-state
   * change through this method, a preset switch, a band drag, an A/B release
   * and an EQ re-enable all updated the interface and nothing else. The graph
   * kept playing whatever curve it already had - after a bypass, permanently
   * flat.
   *
   * IDEMPOTENT about building (addendum §27, §28): the store may call this on
   * every configuration change, including ones that happen before the user has
   * interacted with anything, and none of those may produce a second context.
   *
   * Returns whether audio is actually being processed. `false` is a supported
   * outcome, not an error: the caller keeps playing and the interface says the
   * EQ is unavailable.
   */
  async engage(state: EqGraphState): Promise<boolean> {
    // The newest request always wins, even when it arrives while a build is
    // still in flight (§18).
    this.requested = state;

    if (this.disposed) {
      return false;
    }

    if (this.engaged) {
      this.applyRequested();
      return true;
    }

    if (this.failure) {
      return false;
    }

    // ONE BUILD AT A TIME. Waiting here rather than starting alongside the
    // in-flight attempt is what stops a second `AudioContext`, a second
    // ten-filter chain, and a second `createMediaElementSource` call on an
    // element that can only ever be associated with one.
    if (this.inflight) {
      const ok = await this.inflight;
      if (ok) {
        this.applyRequested();
      }
      return ok;
    }

    const build = this.build(state);
    this.inflight = build;
    try {
      const ok = await build;
      if (ok) {
        this.applyRequested();
      }
      return ok;
    } finally {
      if (this.inflight === build) {
        this.inflight = null;
      }
    }
  }

  /**
   * Writes the NEWEST requested configuration, if the graph is up to take it.
   *
   * The newest rather than the one that was in flight when the build started:
   * a listener who moves two sliders in the half second it takes to engage
   * should hear the second value, not the first.
   */
  private applyRequested(): void {
    if (this.disposed || !this.engaged || !this.requested) {
      return;
    }
    this.apply(this.requested);
  }

  /**
   * One attempt at bringing the graph up. Never called twice concurrently.
   *
   * THE ORDER IS THE WHOLE DESIGN. The element is the LAST thing touched and
   * it is touched exactly once: `createMediaElementSource` cannot be undone,
   * so every step that can fail has to happen while the element is still
   * playing directly.
   */
  private async build(state: EqGraphState): Promise<boolean> {
    const element = this.deps.getElement();
    if (element === null || element === undefined) {
      return this.decline("no-element");
    }

    // A context created before the first user gesture cannot be started, and
    // a started context is the precondition for everything below. Deferring
    // HERE means no context is allocated at all on a page whose equalizer is
    // on by persistence: nothing can be playing before a gesture, so nothing
    // is lost by waiting for one.
    if (!userActivationSeen()) {
      return this.awaitGesture("no user activation yet");
    }

    const safeState = sanitizeGraphState(state, true);

    let context: EqAudioContext;
    try {
      context = this.deps.createContext();
    } catch {
      return this.decline("no-web-audio");
    }
    if (!context) {
      return this.decline("no-web-audio");
    }

    // --- INERT FROM HERE TO THE LAST STEP ---------------------------------
    let filters: EqBiquadNode[] = [];
    let preamp: EqGainNode | null = null;
    try {
      filters = safeState.bands.map((band) => {
        const node = context.createBiquadFilter();
        node.type = "peaking";
        ramp(node.frequency, band.frequency, context.currentTime);
        ramp(node.gain, band.gain, context.currentTime);
        ramp(node.Q, band.q, context.currentTime);
        return node;
      });
      for (let i = 0; i < filters.length - 1; i += 1) {
        filters[i]!.connect(filters[i + 1]!);
      }

      preamp = context.createGain();
      // The LAST filter feeds the preamp. Connecting the first one instead is
      // a bug that looks fine: filter 0's output would split, the preamp would
      // receive a signal that had passed through exactly one band, and filters
      // 1-9 would be a dead branch that cost CPU and changed nothing. Only the
      // node graph shows it.
      const last = filters[filters.length - 1];
      if (last) {
        last.connect(preamp);
      }
      preamp.connect(context.destination);
    } catch {
      // Nothing was ever connected to the element, so tearing this down
      // cannot affect what the listener hears.
      safeDisconnect(filters);
      safeDisconnectOne(preamp);
      void context.close().catch(() => undefined);
      return this.decline("no-web-audio");
    }

    // --- THE ONE-WAY DOOR, AND THE GUARD IN FRONT OF IT --------------------
    // Resuming is not playback: it never calls `play()`, so it cannot trip an
    // autoplay policy or start a second stream (addendum §34).
    //
    // It CAN fail, and it CAN simply not settle - Chromium keeps the promise
    // pending until a gesture arrives, Safari rejects with NotAllowedError.
    // The previous implementation treated both as "close enough": it swallowed
    // the failure, waited however long the browser felt like, and re-homed the
    // element regardless. Re-homing into a context that never started is
    // SILENCE, and it is unrecoverable - nothing in this feature ever calls
    // `resume()` a second time, and `engage()` will not build again once the
    // graph reports itself engaged. No mode switch could bring the audio back.
    //
    // So the door is opened only when the context has actually said `running`.
    await awaitResume(context, this.deps.resumeTimeoutMs ?? EQ_RESUME_TIMEOUT_MS);

    if (context.state !== "running") {
      // The element was NOT touched, so it is still playing directly. Discard
      // the inert chain, release the context, and try again on the next
      // gesture - by which point the browser has a reason to say yes.
      safeDisconnect(filters);
      safeDisconnectOne(preamp);
      void context.close().catch(() => undefined);
      return this.awaitGesture(`context is ${context.state}`);
    }

    let source: EqNode;
    try {
      source = context.createMediaElementSource(element);
    } catch {
      // The element was NOT re-homed, so it is still playing directly. The
      // inert chain is safe to discard.
      safeDisconnect(filters);
      safeDisconnectOne(preamp);
      void context.close().catch(() => undefined);
      return this.decline("no-source");
    }

    const first = filters[0];
    if (first) {
      source.connect(first);
    } else {
      source.connect(preamp);
    }

    this.context = context;
    this.filters = filters;
    this.preamp = preamp;
    this.source = source;
    this.engaged = true;
    this.awaitingGesture = false;
    this.lastApplied = safeState;
    logger.info("Equalizer engaged", {
      event: "eq_audio_context_state",
      audioContextState: context.state,
      filterCount: filters.length,
      preamp: round(safeState.preampDb),
      maxBandGain: round(maxBandGainDb(safeState.bands)),
      engaged: true,
    });
    // The health check runs here and nowhere else - on the transition into the
    // graph, not per animation frame (§23). A filter count that is not ten, or
    // a preamp that never got connected, is invisible until playback is wrong.
    const health = this.health();
    logger.info("Equalizer graph health at engagement", {
      event: "eq_audio_graph_health",
      engaged: health.engaged,
      audioContextState: health.contextState,
      filterCount: health.filterCount,
      preampConnected: health.preampConnected,
      awaitingGesture: health.awaitingGesture,
      failure: health.failure,
    });
    return true;
  }

  /**
   * Deliberate, retryable stop: the graph is fine, the browser just wants a
   * gesture first. NOT a `failure` - `failure` is permanent by design, and a
   * suspended context at page load is an ordinary lifecycle state.
   */
  private awaitGesture(why: string): false {
    this.awaitingGesture = true;
    this.scheduleGestureRetry();
    logger.info("Equalizer waiting for a user gesture", {
      event: "eq_audio_context_state",
      audioContextState: "suspended",
      engaged: false,
      awaitingGesture: true,
      failureStage: why,
    });
    return false;
  }

  /**
   * One-shot: the next gesture re-runs the engagement that was deferred.
   *
   * It detaches BEFORE re-engaging, so a gesture that does not manage to start
   * the context schedules a fresh listener instead of a growing set of them.
   * Cleared by `dispose()`, which is the only place a listener could otherwise
   * outlive the graph.
   */
  private scheduleGestureRetry(): void {
    const subscribe = this.deps.onUserGesture;
    if (this.gestureDetach || this.disposed || !subscribe) {
      return;
    }
    const handler = (): void => {
      this.clearGestureRetry();
      if (this.disposed || this.engaged || this.failure || !this.requested) {
        return;
      }
      void this.engage(this.requested);
    };
    this.gestureDetach = subscribe(handler);
  }

  private clearGestureRetry(): void {
    const detach = this.gestureDetach;
    this.gestureDetach = null;
    detach?.();
  }

  /**
   * Pushes a new configuration into the EXISTING nodes (addendum §28).
   *
   * No node is created, destroyed or reconnected. A preset change is ten
   * parameter writes and nothing else, which is what makes switching presets
   * instant and what makes a slider drag free of allocation churn (§30).
   *
   * VALIDATED BEFORE IT IS WRITTEN (§9, §10). Web Audio treats a non-finite
   * value as an exception rather than as silence, so a configuration from a
   * hand-edited cookie must never reach a parameter: `sanitizeGraphState`
   * clamps what is finite into the model's own ranges and drops what is not,
   * so the graph keeps the number already in it. Anything it had to touch is
   * reported as `eq_parameter_sanitized`.
   *
   * ROLLED BACK ON FAILURE (§19). If a write throws, the previous curve is
   * written back and both the failure and the reversal are reported, so the
   * graph is never left half configured. A parameter write cannot disconnect
   * anything, so playback survives either outcome.
   */
  apply(state: EqGraphState): void {
    const context = this.context;
    if (!context || !this.engaged) {
      return;
    }
    const sanitized = sanitizeGraphState(state, false);
    // Captured before the write, so both the rollback and the "did anything
    // actually move" comparison below are against the curve that is playing.
    const previous = this.lastApplied;
    try {
      this.write(sanitized, context.currentTime);
    } catch (error) {
      let rollbackResult: "restored" | "failed" | "none" = "none";
      if (previous) {
        try {
          this.write(previous, context.currentTime);
          rollbackResult = "restored";
        } catch {
          // The rollback itself failed. Nothing can be done from here, and
          // nothing needs to be: the stable path is still connected.
          rollbackResult = "failed";
        }
      }
      logger.warn("Equalizer state could not be applied", {
        event: "eq_transition_error",
        failureStage: "write",
        rollbackResult,
        reason: error instanceof Error ? error.name : "unknown",
        filterCount: this.filters.length,
        audioContextState: context.state,
      });
      if (previous && rollbackResult === "restored") {
        logger.warn("Equalizer rolled back to the last curve it could write", {
          event: "eq_state_reverted",
          rollbackResult,
          failureStage: "write",
          preamp: round(previous.preampDb),
          maxBandGain: round(maxBandGainDb(previous.bands)),
          filterCount: this.filters.length,
          audioContextState: context.state,
        });
      }
      return;
    }
    this.lastApplied = sanitized;
    if (previous && sameGraphState(previous, sanitized)) {
      // Nothing moved. Re-applying an identical curve is not a state change,
      // and filling the log with it would bury the ones that were.
      return;
    }
    logger.info("Equalizer state applied", {
      event: "eq_state_applied",
      preamp: round(sanitized.preampDb),
      maxBandGain: round(maxBandGainDb(sanitized.bands)),
      filterCount: this.filters.length,
      audioContextState: context.state,
    });
  }

  /** The parameter writes themselves, separated so a failure can be rolled back. */
  private write(state: EqGraphState, now: number): void {
    // Nodes past the end of the supplied list are explicitly zeroed rather than
    // skipped. The graph has ten filters and the model always supplies ten
    // bands, so this cannot happen through the store - but "cannot happen
    // through the store" is not the same as "cannot happen", and skipping them
    // would leave a boost in the graph that nothing in the configuration
    // accounts for. That is a silent +3 dB at 8 kHz, which is the worst class
    // of bug this feature can have.
    this.filters.forEach((node, index) => {
      const band = state.bands[index];
      ramp(node.frequency, band?.frequency ?? node.frequency.value, now);
      ramp(node.gain, band?.gain ?? 0, now);
      ramp(node.Q, band?.q ?? node.Q.value, now);
    });
    if (this.preamp) {
      ramp(this.preamp.gain, dbToLinearSafe(state.preampDb), now);
    }
  }

  /**
   * Neutral path: unity gain through the same graph (addendum §12).
   *
   * The filters stay connected and the preamp stays connected. Nothing is torn
   * down, because nothing may be torn down.
   */
  bypass(): void {
    this.apply({
      bands: neutralBands(),
      preampDb: 0,
    });
  }

  /**
   * Releases the graph.
   *
   * Only safe to call when the element is being replaced or the page is going
   * away, and it is NOT how bypass works. `dispose()` here leaves the element
   * re-homed into a closed context, which is silence - which is why the only
   * caller is a test, and why `PlayerEngine.cleanup()` remains the thing that
   * actually stops audio.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.engaged = false;
    this.awaitingGesture = false;
    this.clearGestureRetry();
    this.requested = null;
    this.lastApplied = null;
    safeDisconnectOne(this.source);
    safeDisconnect(this.filters);
    safeDisconnectOne(this.preamp);
    this.source = null;
    this.filters = [];
    this.preamp = null;
    const context = this.context;
    this.context = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
  }

  private decline(reason: EqUnsupportedReason): false {
    this.failure = reason;
    logger.warn("Equalizer cannot engage", {
      event: "eq_audio_context_state",
      audioContextState: this.context?.state ?? "none",
      engaged: false,
      awaitingGesture: false,
      failureStage: reason,
      filterCount: this.filters.length,
    });
    this.deps.onUnsupported?.(reason);
    return false;
  }
}

/**
 * The band shape `bypass()` uses: the model's own centres and Q, all at 0 dB.
 *
 * Imported rather than rebuilt. A first version constructed these with
 * `20 * 2 ** n`, which yields 20, 40, 80 ... 20 480 - an octave grid that is NOT
 * the shipped one (31, 62, 125 ... 16 000). A bypassed EQ built on the wrong
 * centres is not flat, it is merely different, and nothing about the failure
 * would look like a frequency error. Taking the centres from `EQ_BAND_FREQUENCIES`
 * also means a future change to the band list cannot leave this behind.
 */
function neutralBands(): Array<{ frequency: number; gain: number; q: number }> {
  return EQ_BAND_FREQUENCIES.map((frequency) => ({
    frequency,
    gain: 0,
    q: EQ_BAND_Q,
  }));
}

/**
 * Has the browser seen a user gesture yet?
 *
 * Answers "no" ONLY when there is real evidence of none: the API is missing,
 * or it exists and says so. Every other case proceeds, because the check that
 * actually decides is `context.state` after `resume()` - this one just avoids
 * allocating a context that provably cannot start.
 */
function userActivationSeen(): boolean {
  if (typeof navigator === "undefined") {
    return true;
  }
  const activation = (
    navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }
  ).userActivation;
  if (!activation) {
    return true;
  }
  return activation.hasBeenActive;
}

/**
 * `context.resume()`, bounded - see {@link EQ_RESUME_TIMEOUT_MS} for why.
 *
 * The `async` wrapper is load-bearing: a resume implementation that throws
 * synchronously would otherwise escape before `Promise.race` ever sees it, and
 * a thrown exception out of `engage()` would strand `inflight` set forever.
 */
async function awaitResume(
  context: EqAudioContext,
  timeoutMs: number,
): Promise<void> {
  const resumed = (async () => {
    await context.resume();
  })().catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      resumed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * Clamps a requested state into values Web Audio will accept (§9, §10).
 *
 * WHAT HAPPENS TO A VALUE THAT CANNOT BE USED, and why it is not one rule.
 *
 *   REJECTED, NOT REWRITTEN - on apply. A non-finite gain, frequency or Q is
 *   passed through so that `ramp()` drops it before it can reach an
 *   `AudioParam`, and the parameter simply keeps the number already in the
 *   graph. That is the known-good value (§19), and "nothing is scheduled" is
 *   the observable form of it: rewriting it to a finite number would schedule
 *   a real move to a curve the listener never asked for. For gain this also
 *   lands on the right answer with no work at all, because a
 *   `BiquadFilterNode`'s own default is 0 dB.
 *
 *   REPLACED - on build, and only for frequency and Q. There is no "already
 *   in the graph" to keep at that point, and the node's own defaults are 350 Hz
 *   and Q 1, neither of which is one of Aurora's bands. The canonical centre
 *   and the model's Q are used instead, so a fresh graph can never come up on
 *   a frequency Aurora does not have.
 *
 *   preampDb -> 0 dB (unity) whenever it is not finite, which is the model's
 *   own `dbToLinearSafe` answer: a preamp nobody can describe must neither
 *   amplify nor attenuate. A FINITE preamp is clamped to
 *   PREAMP_MIN_DB..PREAMP_MAX_DB (-12..0), so a hand-edited cookie cannot ask
 *   for gain the signal has no headroom for.
 *
 *   gain (finite) -> clamped to the model's EQ_BAND_GAIN_*_DB (-12..+12).
 *
 * `fresh` is true only while the graph is being built for the first time.
 */
function sanitizeGraphState(state: EqGraphState, fresh: boolean): EqGraphState {
  let corrected = 0;

  const bands = state.bands.map((band, index) => {
    const canonical = EQ_BAND_FREQUENCIES[index] as number | undefined;

    const frequency = usableFrequency(band.frequency)
      ? band.frequency
      : fresh && canonical !== undefined
        ? canonical
        : band.frequency;

    const q = usableQ(band.q) ? band.q : fresh ? EQ_BAND_Q : band.q;

    const gain = Number.isFinite(band.gain)
      ? Math.min(EQ_BAND_GAIN_MAX_DB, Math.max(EQ_BAND_GAIN_MIN_DB, band.gain))
      : band.gain;

    if (frequency !== band.frequency) corrected += 1;
    if (q !== band.q) corrected += 1;
    if (gain !== band.gain) corrected += 1;
    return { frequency, gain, q };
  });

  const preampDb = Number.isFinite(state.preampDb)
    ? Math.min(PREAMP_MAX_DB, Math.max(PREAMP_MIN_DB, state.preampDb))
    : 0;
  if (preampDb !== state.preampDb) corrected += 1;

  if (corrected > 0) {
    logger.warn("Equalizer parameter sanitized before it reached the graph", {
      event: "eq_parameter_sanitized",
      parameters: corrected,
      preamp: round(preampDb),
      filterCount: bands.length,
    });
  }

  return { bands, preampDb };
}

function usableFrequency(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function usableQ(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** The largest BOOST in a curve, in dB. Negative-only curves report 0. */
function maxBandGainDb(bands: readonly { gain: number }[]): number {
  return bands.reduce((max, band) => Math.max(max, band.gain), 0);
}

/** True when two sanitized states would write exactly the same numbers. */
function sameGraphState(a: EqGraphState, b: EqGraphState): boolean {
  if (a.preampDb !== b.preampDb || a.bands.length !== b.bands.length) {
    return false;
  }
  return a.bands.every((band, index) => {
    const other = b.bands[index];
    return (
      other !== undefined &&
      band.frequency === other.frequency &&
      band.gain === other.gain &&
      band.q === other.q
    );
  });
}

/** Diagnostics are readable numbers on a log line, not 3.0000000000000004. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Schedules a parameter move as a short linear ramp.
 *
 * `cancelScheduledValues` first, then an explicit anchor at the current value,
 * then the ramp - the standard three-step, and all three are load-bearing. A
 * ramp with no anchor ramps from whatever the last scheduled event left (or from
 * zero, which is an audible full-scale jump on the first change), and a ramp
 * without a cancel stacks on top of the previous one, so a dragged slider ends
 * up chasing a queue of stale targets.
 */
function ramp(param: EqAudioParam, value: number, now: number): void {
  if (!Number.isFinite(value)) {
    return;
  }
  const start = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(start, now);
  if (start !== value) {
    param.linearRampToValueAtTime(value, now + EQ_RAMP_SECONDS);
  }
}

/** dB -> linear, from the model, so the graph and the arithmetic cannot disagree. */
function dbToLinearSafe(db: number): number {
  return Number.isFinite(db) ? dbToLinear(db) : 1;
}

function safeDisconnect(nodes: EqNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // Already disconnected; nothing to do.
    }
  }
}

function safeDisconnectOne(node: EqNode | null): void {
  if (!node) {
    return;
  }
  try {
    node.disconnect();
  } catch {
    // Already disconnected; nothing to do.
  }
}

/* ==========================================================================
   THE SINGLETON
   ========================================================================== */

let singleton: EqGraph | null = null;

/**
 * The one graph (addendum §26, §27).
 *
 * A module-level singleton rather than a React context or a store field, for
 * two reasons: it must outlive every component that touches it (mounting the
 * settings panel must not be what decides whether audio is processed), and it
 * must be reachable from the store without the store importing React.
 *
 * The context is created LAZILY, on the first configuration that actually needs
 * it. Nothing here runs on a React render, on a track change, or on a component
 * mount, which is what §27 forbids and what keeps a page load from spinning up
 * an audio graph nobody asked for.
 */
export function getEqGraph(deps?: EqGraphDeps): EqGraph {
  if (!singleton) {
    singleton = new EqGraph(deps ?? productionDeps());
  }
  return singleton;
}

/** Test seam. Does not touch audio; there is no graph to stop. */
export function resetEqGraphForTests(): void {
  singleton?.dispose();
  singleton = null;
}

function productionDeps(): EqGraphDeps {
  return {
    createContext: () => {
      const Ctor =
        typeof window === "undefined"
          ? undefined
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext);
      if (!Ctor) {
        throw new Error("Web Audio is unavailable");
      }
      return new Ctor() as unknown as EqAudioContext;
    },
    getElement: () => getCanonicalMediaElement(),
    onUserGesture: (handler) => {
      if (typeof document === "undefined") {
        return () => undefined;
      }
      // CAPTURE, so the retry runs before anything that might stop propagation
      // on its way up, and the three events between them cover mouse, pen, key
      // and touch. A gesture is exactly what the browser is waiting for; the
      // retry must not be lost because one menu swallowed the click.
      const options = { capture: true } as const;
      const events = ["pointerdown", "keydown", "touchend"] as const;
      for (const name of events) {
        document.addEventListener(name, handler, options);
      }
      return () => {
        for (const name of events) {
          document.removeEventListener(name, handler, options);
        }
      };
    },
  };
}

/**
 * The application's own audio element, and nothing else.
 *
 * It is asked for through `PlayerEngine` rather than created here, because
 * `getDefaultEngine()` owns the single instance and a second `new Audio()` here
 * would be a second playback path - the thing §26 names first. Returns `null`
 * when the engine is not on the client yet, or when its surface is a test
 * double rather than a real element, and `null` is a supported answer.
 */
function getCanonicalMediaElement(): unknown {
  if (typeof window === "undefined") {
    return null;
  }
  return getEngineMediaElement();
}

/**
 * Indirection so this module does not import the engine factory directly.
 *
 * `setEqElementResolver` is called once by the app shell at startup. The indirection
 * exists to keep the dependency pointing one way: the EQ reads the engine, and
 * the engine knows nothing about the EQ.
 */
let elementResolver: (() => unknown) | null = null;

export function setEqElementResolver(resolver: () => unknown): void {
  elementResolver = resolver;
}

function getEngineMediaElement(): unknown {
  if (elementResolver) {
    return elementResolver();
  }
  return null;
}
