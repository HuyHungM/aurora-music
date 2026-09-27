/**
 * A fake Web Audio implementation, shared by the tests that need one.
 *
 * WHY IT IS SHARED. The equalizer's defect was a broken CHAIN - a store action
 * that never reached an `AudioParam` - and a chain is only worth asserting over
 * end to end. `eq-graph.test.ts` exercises the graph in isolation;
 * `eq-store.test.ts` primes the same singleton with these fakes so it can prove
 * that `choosePreset()` ends up as a number on a filter. Two copies of the fake
 * would be two descriptions of the same contract, and they would drift.
 *
 * THE FAKE IS FAITHFUL ABOUT THE TWO THINGS THAT MATTER. It records every
 * scheduled automation event rather than collapsing to a final value, because
 * "did it ramp" is a question about the schedule and not about the destination.
 * And `createMediaElementSource` THROWS when asked to, because that is what a
 * browser does when the element cannot be re-homed, and the
 * order-of-operations guarantee under test is only meaningful if the throw is
 * real.
 *
 * This file lives under `__tests__` on purpose: the quality gates that count
 * `new Audio()` and `new AudioContext()` sites exclude test sources, so that a
 * gate is never satisfied by deleting the thing it protects.
 */

import type {
  EqAudioContext,
  EqAudioParam,
  EqBiquadNode,
  EqGainNode,
  EqNode,
} from "@/lib/audio/eq-graph";

export interface ScheduledEvent {
  kind: "cancel" | "set" | "ramp";
  value: number;
  time: number;
}

export class FakeParam implements EqAudioParam {
  value: number;
  readonly events: ScheduledEvent[] = [];

  constructor(initial: number) {
    this.value = initial;
  }

  setValueAtTime(value: number, startTime: number): EqAudioParam {
    this.value = value;
    this.events.push({ kind: "set", value, time: startTime });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): EqAudioParam {
    this.value = value;
    this.events.push({ kind: "ramp", value, time: endTime });
    return this;
  }

  cancelScheduledValues(cancelTime: number): EqAudioParam {
    this.events.push({ kind: "cancel", value: this.value, time: cancelTime });
    return this;
  }
}

export class FakeNode implements EqNode {
  readonly connections: EqNode[] = [];
  disconnectCount = 0;

  connect(destination: EqNode): EqNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

export class FakeBiquad extends FakeNode implements EqBiquadNode {
  type = "peaking";
  readonly frequency = new FakeParam(350);
  readonly gain = new FakeParam(0);
  readonly Q = new FakeParam(1);
}

export class FakeGain extends FakeNode implements EqGainNode {
  readonly gain = new FakeParam(1);
}

export class FakeContext implements EqAudioContext {
  sampleRate = 48_000;
  currentTime = 10;
  state = "suspended";
  readonly destination: EqNode = new FakeNode();
  readonly filters: FakeBiquad[] = [];
  readonly gains: FakeGain[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  sourceCalls = 0;
  sourcedElement: unknown = null;
  /** Set to make `createMediaElementSource` throw, as a browser would. */
  sourceThrows = false;

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }

  createBiquadFilter(): EqBiquadNode {
    const node = new FakeBiquad();
    this.filters.push(node);
    return node;
  }

  createGain(): EqGainNode {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createMediaElementSource(element: unknown): EqNode {
    this.sourceCalls += 1;
    if (this.sourceThrows) {
      throw new Error("InvalidStateError: cannot re-home this element");
    }
    this.sourcedElement = element;
    return new FakeNode();
  }
}

/** The canonical media element, as the resolver hands it to the graph. */
export function fakeAudioElement(): { tagName: "AUDIO" } {
  return { tagName: "AUDIO" };
}
