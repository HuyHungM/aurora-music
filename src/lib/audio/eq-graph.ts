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
 *   1. the element exists                                  - touches nothing
 *   2. the browser has seen a user gesture                 - touches nothing
 *   3. the element HAS a source, and that source is READABLE - touches nothing
 *   4. create the context            - inert
 *   5. build the ten filters         - inert, nothing is feeding them
 *   6. build the preamp and wire it   - inert
 *   7. connect the preamp to the destination
 *   8. ONLY NOW re-home the element
 *
 * Every failure mode before step 8 leaves the element playing directly and
 * untouched, which is the whole of addendum §33's "fail gracefully and keep
 * audio playback functional". If step 8 itself throws, the element is not
 * re-homed (that is what throwing means here) and the inert chain is torn down.
 *
 * ---------------------------------------------------------------------------
 * STEP 3 EXISTS BECAUSE "THE ELEMENT IS FINE" IS NOT "THE AUDIO WILL BE"
 * ---------------------------------------------------------------------------
 *
 * The first seven steps make the graph structurally perfect and the listener
 * completely silent. That is not a contradiction: it is what a
 * `MediaElementAudioSourceNode` does when the element's current resource is
 * cross-origin and the response carries no `Access-Control-Allow-Origin`. The
 * spec says the node then outputs silence, browsers implement it, and Chrome
 * says so in the console: "MediaElementAudioSource outputs zeroes due to CORS
 * access restrictions". Measured on Aurora's own provider stream: a
 * fully-built, `running`, fully-connected graph, ten filters at exactly the
 * right gains, preamp at exactly the right linear value, the element still
 * `paused:false` with `currentTime` advancing and `volume:1` - and an analyser
 * reading exactly 0 at the source node and 0 at the preamp. Injecting a DC
 * offset into the first filter came out the far end attenuated by precisely the
 * configured headroom, which is what proved the chain was healthy and the
 * SOURCE was the thing producing nothing.
 *
 * `crossOrigin = "anonymous"` is not the fix on its own: without an
 * `Access-Control-Allow-Origin` header the element then fails to load at all
 * (`MEDIA_ERR_SRC_NOT_SUPPORTED`), which is a worse outcome than silence. It is
 * also not Aurora's to set — the attribute belongs to whoever owns media
 * delivery, and setting it unconditionally here would break every stream that
 * works today.
 *
 * So the graph asks the only question the specification lets it ask — CAN WEB
 * AUDIO READ THIS SOURCE? — before it takes the door, and declines when the
 * answer is no. That question is answerable without a network request, from the
 * resource's origin and the element's own CORS state; {@link sourceVerdict} is
 * the whole of it. Declining leaves the element playing directly, which is the
 * one arrangement in which the listener still hears their music. The equalizer
 * is not disabled by this: the same code engages, and is audible, the moment
 * media delivery is something Web Audio may read — a same-origin resource, or a
 * stream served with CORS headers from an element that opted in.
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
  /**
   * Subscribes to "the element's current source has changed", returning the
   * function that unsubscribes.
   *
   * This is the retry trigger for the DEFERRED case (an equalizer switched on
   * before anything is playing has no source to inspect, and must not open the
   * door on a source it has not seen) and the trigger for the post-engagement
   * audit (a source that arrives after the door is open, which cannot be undone
   * and can only be reported).
   *
   * A dependency for the same reason `createContext` is: this module is tested
   * in Node, where there is no element to attach anything to.
   */
  onSourceChange?: (handler: () => void) => () => void;
  /**
   * The document's origin, as a string, or `null` when there is none.
   *
   * Only ever consulted for a SOURCE that is not obviously readable, and only
   * as a comparison: a source on this origin is readable by definition, because
   * no CORS check is performed for a same-origin media request.
   */
  documentOrigin?: () => string | null;
  /**
   * Reported when a source that arrived AFTER the door was opened turns out to
   * be unreadable. Never a reason to tear anything down - the door cannot be
   * un-rung - so this exists to make an already-lost signal say so.
   */
  onSourceUnreadable?: (url: string) => void;
}

export type EqUnsupportedReason =
  | "no-web-audio"
  | "no-element"
  | "no-source"
  /**
   * The element's current source is cross-origin and does not allow Web Audio
   * to read it, so re-homing the element would replace the music with silence.
   *
   * The one reason here that is not about the BROWSER. It is a property of the
   * media delivery path, it is measured rather than assumed, and it is
   * reported as such - "this stream cannot be processed" rather than "this
   * browser cannot process audio", which would be a lie about a browser that is
   * working exactly as specified.
   */
  | "cors-tainted";

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
  /**
   * Set when there is no source to inspect yet, rather than when something is
   * wrong. Same shape as `awaitingGesture` and for the same reason: an
   * equalizer switched on before anything is playing is not a failure, and
   * calling it one would put an error in front of a healthy interface.
   */
  private awaitingSource = false;
  /** Detaches the element source-change subscription. */
  private sourceDetach: (() => void) | null = null;
  /**
   * The last source verdict, for the last URL asked about.
   *
   * ONE entry, not a map. A track's readability is a property of that track's
   * response, so re-asking is how a page accumulates a request per skip, and
   * a session-long map would be a leak in a module with no cleanup story.
   * Comparing URLs also keeps the post-engagement audit from re-probing the
   * URL it just probed.
   */
  private probedUrl: string | null = null;
  private probedReadable = false;
  /** The document origin, or `null` when there is no document. */
  private origin: string | null | undefined;
  /**
   * The URL that arrived after the door was opened and cannot be read.
   *
   * Not a `failure`: the graph is up, the curve is being applied, and the
   * listener's volume is untouched. What is lost is the signal, so this is a
   * reporting fact rather than a state the graph could recover from.
   */
  private unreadableSource: string | null = null;
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

  /**
   * True while the graph is waiting for the element to have a source it can
   * inspect. `false` in every state that a caller should report as an error,
   * for the same reason {@link isAwaitingGesture} is.
   */
  get isAwaitingSource(): boolean {
    return this.awaitingSource;
  }

  /**
   * The source that arrived after engagement and cannot be read, as a reason -
   * or `null`. Reported separately from {@link unsupportedReason} because the
   * graph is engaged while this is set, and an interface that said "unsupported"
   * about a running graph would be describing a state that does not exist.
   */
  get sourceUnreadableReason(): EqUnsupportedReason | null {
    return this.unreadableSource === null ? null : "cors-tainted";
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
    awaitingSource: boolean;
    sourceUnreadable: boolean;
    failure: EqUnsupportedReason | null;
  } {
    return {
      engaged: this.engaged,
      contextState: this.context?.state ?? "none",
      filterCount: this.filters.length,
      preampConnected: this.preamp !== null,
      awaitingGesture: this.awaitingGesture,
      awaitingSource: this.awaitingSource,
      sourceUnreadable: this.unreadableSource !== null,
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

    // --- IS THERE ANYTHING TO RE-HOME, AND MAY WEB AUDIO READ IT? ---------
    //
    // Both answers leave the element playing directly, and both are asked
    // BEFORE the context exists, so a source that cannot be used costs one
    // comparison rather than a context, a clock and a ten-filter chain.
    //
    // "No source yet" is a deferral rather than a decline because it is the
    // ordinary state of a listener who switches the equalizer on before
    // pressing play. Declining there would be both wrong and self-defeating:
    // the failure is permanent by design, so the very first engagement would
    // burn the graph's only chance on a page that had nothing to play yet.
    // `not-yet` is deferred for the same reason: the CORS check has not
    // reported yet, and a decline now would be a permanent one.
    const sourceUrl = elementSourceUrl(element);
    if (sourceUrl === null) {
      return this.awaitSource("the element has no source yet");
    }
    const verdict = sourceVerdict(sourceUrl, element, this.documentOrigin());
    if (verdict === "not-yet") {
      return this.awaitSource("the element's CORS check has not reported yet");
    }
    if (verdict === "unreadable") {
      // THE ANSWER THAT PROTECTS THE MUSIC. The element was NOT touched, so it
      // is still playing straight to the speakers, and the interface is told
      // why the equalizer is not running - in the same breath as the fact that
      // the music is.
      return this.decline("cors-tainted");
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
    this.awaitingSource = false;
    this.lastApplied = safeState;
    // From here the element can be handed a DIFFERENT source - a track change
    // sets `src` on the same element - and that new source is a source this
    // graph never inspected. The door cannot be closed again, so the honest
    // response is to notice and say so rather than to keep claiming success.
    this.watchSource();
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
   * Deliberate, retryable stop: there is no source to inspect yet. NOT a
   * `failure` - see `awaitingSource`.
   */
  private awaitSource(why: string): false {
    this.awaitingSource = true;
    this.watchSource();
    logger.info("Equalizer waiting for a source it can read", {
      event: "eq_audio_context_state",
      audioContextState: "none",
      engaged: false,
      awaitingSource: true,
      failureStage: why,
    });
    return false;
  }

  /**
   * Asks whether Web Audio may read `url`, and remembers the answer per URL.
   *
   * The decision itself is {@link sourceVerdict} — synchronous, networkless and
   * a pure function of facts the element already exposes. What this method adds
   * is the CACHE and the LOGGING, both of which exist for the same reason: an
   * audit that re-asked the network on every media event would be a page that
   * cannot play a track. The cache is ONE entry rather than a map, so a
   * long-lived session cannot accumulate a request - or a string - per skip.
   *
   * The verdict is cached, but the element's own state is NOT: the whole point
   * of the `not-yet` answer is that the same URL can move from "not yet" to a
   * definite one, so a cached `not-yet` is never served again.
   */
  private verdictFor(url: string): SourceVerdict {
    if (this.probedUrl !== url) {
      this.probedUrl = url;
      this.probedReadable = false;
    }
    const element = this.deps.getElement();
    const verdict = sourceVerdict(url, element, this.documentOrigin());
    if (verdict === "readable") {
      this.probedReadable = true;
    }
    if (!this.probedReadable && verdict === "unreadable") {
      logger.warn("Equalizer source cannot be read by Web Audio", {
        event: "eq_source_unreadable",
        // The HOST, not the URL: this is a network log and a stream URL is a
        // bearer token for the listener's media.
        sourceHost: hostOf(url),
        engaged: this.engaged,
        audioContextState: this.context?.state ?? "none",
      });
    }
    return verdict;
  }

  /**
   * The document's origin, read once and cached.
   *
   * A DEPENDENCY rather than a global read, for the same reason
   * `createContext` and `getElement` are: this module is tested in Node, where
   * there is no document and therefore no origin to compare a source against.
   * Answering `null` — which makes every URL cross-origin, and therefore
   * cautious — is the right production behaviour when the dep is absent, and
   * the wrong test behaviour, so the tests supply the origin explicitly instead
   * of the module reaching for a global that only exists in a browser.
   */
  private documentOrigin(): string | null {
    if (this.origin === undefined) {
      this.origin = this.deps.documentOrigin?.() ?? null;
    }
    return this.origin;
  }

  /**
   * One subscription, serving two purposes, because both are about the same
   * event and a second listener on one element is a second thing to leak.
   *
   * Before engagement it is the retry for a deferred attempt; after it, it is
   * the audit. `dispose()` detaches it, which is the only place a listener
   * could otherwise outlive the graph.
   */
  private watchSource(): void {
    if (this.sourceDetach || this.disposed) {
      return;
    }
    const subscribe = this.deps.onSourceChange;
    if (!subscribe) {
      return;
    }
    this.sourceDetach = subscribe(() => {
      this.onSourceChanged();
    });
  }

  private onSourceChanged(): void {
    if (this.disposed) {
      return;
    }
    if (this.engaged) {
      this.auditSource();
      return;
    }
    if (!this.awaitingSource) {
      return;
    }
    // One-shot, exactly like the gesture retry: the deferred attempt gets
    // exactly one more chance per event, and if it needs to wait again it
    // subscribes again. A listener that re-engages on every event of a busy
    // page would be an unbounded retry loop wearing a listener's clothes.
    this.clearSourceRetry();
    if (this.requested) {
      void this.engage(this.requested);
    }
  }

  /**
   * The post-engagement audit, and the limit of what can honestly be done
   * about a source that arrives after the door.
   *
   * The door cannot be closed, so an unreadable source here cannot be repaired
   * - there is no second element to move the music onto and no way to return
   * this one to direct output. What CAN be done is to stop claiming success:
   * the fact is recorded, reported once, and put in front of the listener.
   *
   * This is deliberately a report and not a teardown. Tearing the graph down
   * here would leave the element re-homed into a closed context, which is the
   * same silence with less information.
   */
  private auditSource(): void {
    const element = this.deps.getElement();
    const url = elementSourceUrl(element);
    if (url === null) {
      // The element was emptied, which `PlayerEngine` does when it stops. There
      // is nothing to be wrong about until a source arrives.
      if (this.unreadableSource !== null) {
        this.unreadableSource = null;
      }
      return;
    }
    // Three answers, kept as three. Collapsing `not-yet` into "unreadable"
    // here is the bug this call site is written to avoid: it would put a "this
    // stream cannot be read" notice in front of a listener whose next track
    // reports on its CORS check one event from now, and a notice that has to
    // retract itself is worse than no notice at all.
    const verdict = this.verdictFor(url);
    if (verdict === "not-yet") {
      return;
    }
    const readable = verdict === "readable";
    const previous = this.unreadableSource;
    if (readable) {
      this.unreadableSource = null;
      if (previous !== null) {
        logger.info("Equalizer source is readable again", {
          event: "eq_source_readable",
          sourceHost: hostOf(url),
          engaged: true,
          audioContextState: this.context?.state ?? "none",
        });
      }
      return;
    }
    // `not-yet` is deliberately NOT a report. A source whose CORS check has not
    // reported yet is a source nobody knows anything about, and announcing it
    // as lost would put a "this stream cannot be read" notice in front of a
    // listener whose track is about to become perfectly processable.
    if (previous === url) {
      return;
    }
    this.unreadableSource = url;
    logger.warn("Equalizer lost the signal on a source it cannot read", {
      event: "eq_source_unreadable_after_engage",
      sourceHost: hostOf(url),
      engaged: true,
      audioContextState: this.context?.state ?? "none",
      filterCount: this.filters.length,
    });
    this.deps.onSourceUnreadable?.(url);
  }

  private clearSourceRetry(): void {
    const detach = this.sourceDetach;
    this.sourceDetach = null;
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
    this.awaitingSource = false;
    this.unreadableSource = null;
    this.clearGestureRetry();
    this.clearSourceRetry();
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
    // A decline is final, so nothing is left waiting for an event that would
    // only be declined again.
    this.awaitingSource = false;
    this.awaitingGesture = false;
    this.clearGestureRetry();
    this.clearSourceRetry();
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

/**
 * The element's current source URL, or `null` when it has none.
 *
 * `currentSrc` is the resolved URL and is the honest answer; `src` is the
 * attribute, which may be a relative path the element has not resolved yet, and
 * is read only as a fallback for a test double that models a source without
 * modelling `currentSrc`.
 *
 * An element is read structurally and never cast to `HTMLAudioElement`: the
 * resolver's declared return type is `unknown` precisely because it can be a
 * test double, and a double is not allowed to make this module throw.
 */
function elementSourceUrl(element: unknown): string | null {
  if (typeof element !== "object" || element === null) {
    return null;
  }
  const candidate = element as { currentSrc?: unknown; src?: unknown };
  for (const value of [candidate.currentSrc, candidate.src]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** A stream URL is a bearer token for the listener's media; logs get a host. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || "(no host)";
  } catch {
    return "(unparseable)";
  }
}

/**
 * What Web Audio can do with a source: `yes`, `no`, or `not yet`.
 *
 * THREE ANSWERS, NOT TWO, and the third is why this is a function of the
 * ELEMENT and not only of the URL.
 *
 * `MediaElementAudioSourceNode` is specified to output zeroes when the media
 * resource is cross-origin and the element did not make a CORS-mode request
 * for it. That rule is decidable WITHOUT A NETWORK REQUEST, from two facts the
 * element already exposes:
 *
 *   - the resource's origin, compared with the document's; and
 *   - whether the element opted into CORS at all (`crossOrigin`).
 *
 * So a cross-origin source on an element with no `crossOrigin` is `no`, and
 * deterministically so. There is nothing to test and nothing to wait for, and
 * in particular nothing that could go wrong slowly.
 *
 * WHEN THE ANSWER IS `not yet`. An element that DID opt into CORS only knows
 * whether its CORS check passed once the load has got far enough to report it,
 * and until then `readyState` is `HAVE_NOTHING` — which means "no", but means
 * it for a different reason: the question has not been asked yet. Reporting
 * that as `no` would decline on a source that is about to be readable, and
 * since a decline is permanent by design, that would be a self-inflicted
 * one-way door of exactly the kind this file exists to avoid. So it is a third
 * answer, and the caller treats it as a deferral.
 *
 * WHY NOT ASK THE NETWORK. An earlier version of this probe issued its own
 * ranged, `mode: "cors"` `fetch` and read the answer from whether it resolved.
 * That was measuring the wrong thing, and the mistake was caught by the test
 * rather than by review: Aurora's CSP is `connect-src 'self' ws: wss:`, so the
 * probe's own request was blocked by the page's policy before it left the
 * browser — a `TypeError` that looks exactly like a CORS refusal, and that
 * would have declined the equalizer for sources Web Audio could read perfectly
 * well. A probe must not inherit the app's policy and call the result a fact
 * about the media.
 */
type SourceVerdict = "readable" | "unreadable" | "not-yet";

function sourceVerdict(
  url: string,
  element: unknown,
  origin: string | null,
): SourceVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url, origin ?? undefined);
  } catch {
    // An unparseable source cannot be reasoned about, and the two available
    // answers are not equivalent. Fail closed, as everywhere else here.
    return "unreadable";
  }

  // Same-origin, or not a network fetch at all. `blob:` and `data:` are
  // decoded by the element itself with no CORS check in the path, so there is
  // no taint to inherit.
  const scheme = parsed.protocol.replace(":", "");
  if (scheme === "blob" || scheme === "data") {
    return "readable";
  }
  if (origin !== null && parsed.origin === origin) {
    return "readable";
  }

  // Cross-origin. The element must have asked for it in CORS mode, or the
  // node will be fed zeroes no matter what the server said.
  const media = element as {
    crossOrigin?: unknown;
    readyState?: unknown;
    error?: unknown;
  } | null;
  const mode = typeof media?.crossOrigin === "string" ? media.crossOrigin : "";
  if (mode !== "anonymous" && mode !== "use-credentials") {
    return "unreadable";
  }

  // It DID opt in, so the CORS check has run or is about to. The element is
  // the authority on the outcome: a failed check surfaces as a media error
  // with nothing loaded, and there is no other way for a passed one to look.
  const errored = media?.error !== null && media?.error !== undefined;
  if (errored) {
    return "unreadable";
  }
  const readyState = typeof media?.readyState === "number" ? media.readyState : 0;
  return readyState > 0 ? "readable" : "not-yet";
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
    documentOrigin: () => {
      const view = (globalThis as { location?: { origin?: unknown } }).location;
      return typeof view?.origin === "string" ? view.origin : null;
    },
    onSourceChange: (handler) => {
      const element = getCanonicalMediaElement();
      if (typeof element !== "object" || element === null) {
        // No element to watch. A supported answer rather than a failure: the
        // graph is not engaged, and an equalizer that cannot find the
        // application's element declines before reaching this.
        return () => undefined;
      }
      const target = element as {
        addEventListener?: (type: string, listener: () => void) => void;
        removeEventListener?: (type: string, listener: () => void) => void;
      };
      if (
        typeof target.addEventListener !== "function" ||
        typeof target.removeEventListener !== "function"
      ) {
        return () => undefined;
      }
      // Bound once, because the guard above narrows the PROPERTIES and
      // TypeScript will not carry that narrowing into a closure - the disposer
      // runs long after the guard, and re-checking there would be the honest way
      // to say "nothing about this object can be trusted later".
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      // `loadstart` fires for every way a media element can be given a new
      // resource - a changed `src`, a changed `<source>` child, or an explicit
      // `load()` - and `emptied` covers the engine's own `src = ""` teardown.
      //
      // The middle three are for the OTHER direction: a source that opted into
      // CORS is only decidable once the element has reported on its check, and
      // those are the events on which that report changes. `error` is the
      // failure case of the same question, and it is the one that turns a
      // deferral into a decline.
      const events = [
        "loadstart",
        "emptied",
        "loadedmetadata",
        "canplay",
        "error",
      ] as const;
      for (const name of events) {
        add(name, handler);
      }
      return () => {
        for (const name of events) {
          remove(name, handler);
        }
      };
    },
    onSourceUnreadable: (url) => {
      sourceUnreadableListener?.(url);
    },
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

/**
 * Told when a source that arrived after engagement cannot be read.
 *
 * A REGISTRATION rather than a dependency, for the same reason the element
 * resolver above is one: the graph must not know that a store exists. The
 * store registers once at module load and the graph calls whoever is
 * registered, so the dependency still points one way and the graph is still
 * testable in Node with no store in sight.
 */
let sourceUnreadableListener: ((url: string) => void) | null = null;

export function setEqSourceUnreadableListener(
  listener: ((url: string) => void) | null,
): void {
  sourceUnreadableListener = listener;
}

export function setEqElementResolver(resolver: () => unknown): void {
  elementResolver = resolver;
}

function getEngineMediaElement(): unknown {
  if (elementResolver) {
    return elementResolver();
  }
  return null;
}
