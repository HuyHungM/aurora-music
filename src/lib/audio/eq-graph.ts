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

import { EQ_BAND_FREQUENCIES, EQ_BAND_Q, dbToLinear } from "./eq";

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

  constructor(private readonly deps: EqGraphDeps) {}

  get isEngaged(): boolean {
    return this.engaged;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Why the EQ is not running, or `null` when it is (or has not tried). */
  get unsupportedReason(): EqUnsupportedReason | null {
    return this.failure;
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
   * IDEMPOTENT, and deliberately so: the store may call this on every
   * configuration change including the ones that happen before the user has
   * interacted with anything, and each of those must be a no-op rather than a
   * second context (addendum §27, §28).
   *
   * Returns whether audio is actually being processed. `false` is a supported
   * outcome, not an error: the caller keeps playing and the interface says the
   * EQ is unavailable.
   */
  async engage(state: EqGraphState): Promise<boolean> {
    if (this.disposed || this.engaged) {
      return this.engaged;
    }
    if (this.failure) {
      return false;
    }

    const element = this.deps.getElement();
    if (element === null || element === undefined) {
      return this.decline("no-element");
    }

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
      filters = state.bands.map((band) => {
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

    // --- THE ONE-WAY DOOR --------------------------------------------------
    // iOS/Safari (addendum §34): the context may start suspended, and audio
    // stays silent until it is resumed from a user gesture. The resume is
    // awaited and its failure is tolerated rather than propagated - the graph
    // is still correctly wired, the context will start on the next gesture, and
    // throwing here would turn a normal mobile lifecycle into an error state.
    // Critically, this never calls `play()`: resuming a context is not
    // playback, so it cannot trip an autoplay policy or start a second stream.
    await context.resume().catch(() => undefined);

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
    this.apply(state);
    return true;
  }

  /**
   * Pushes a new configuration into the EXISTING nodes (addendum §28).
   *
   * No node is created, destroyed or reconnected. A preset change is ten
   * parameter writes and nothing else, which is what makes switching presets
   * instant and what makes a slider drag free of allocation churn (§30).
   */
  apply(state: EqGraphState): void {
    const context = this.context;
    if (!context || !this.engaged) {
      return;
    }
    const now = context.currentTime;
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
