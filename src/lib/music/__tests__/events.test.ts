import { describe, expect, it, vi } from "vitest";
import { createMusicEventEmitter } from "@/lib/music/events";

describe("MusicEventEmitter", () => {
  it("delivers typed events to subscribers and unsubscribes", () => {
    const emitter = createMusicEventEmitter();
    const onStart = vi.fn();
    const anyListener = vi.fn();
    const offStart = emitter.on("trackStart", onStart);
    const offAny = emitter.subscribe(anyListener);

    emitter.emit("trackStart", {
      track: undefined as never,
      index: 0,
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(anyListener).toHaveBeenCalledTimes(1);
    expect(anyListener.mock.calls[0]?.[0]).toBe("trackStart");

    offStart();
    offAny();
    emitter.emit("trackStart", { track: undefined as never, index: 1 });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(anyListener).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount()).toBe(0);
  });

  it("supports off() and clear()", () => {
    const emitter = createMusicEventEmitter();
    const listener = vi.fn();
    emitter.on("queueEnd", listener);
    emitter.off("queueEnd", listener);
    emitter.emit("queueEnd", { queue: [] });
    expect(listener).not.toHaveBeenCalled();

    emitter.on("queueEnd", listener);
    emitter.clear();
    emitter.emit("queueEnd", { queue: [] });
    expect(listener).not.toHaveBeenCalled();
    expect(emitter.listenerCount()).toBe(0);
  });

  it("isolates throwing listeners and reports once via error", () => {
    const emitter = createMusicEventEmitter();
    const good = vi.fn();
    const onError = vi.fn();
    emitter.on("trackStart", () => {
      throw new Error("boom");
    });
    emitter.on("trackStart", good);
    emitter.on("error", onError);

    emitter.emit("trackStart", { track: undefined as never, index: 0 });
    expect(good).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      error: expect.objectContaining({ name: "ListenerError" }),
    });
  });

  it("never recurses when error listeners throw", () => {
    const emitter = createMusicEventEmitter();
    const onError = vi.fn(() => {
      throw new Error("nested");
    });
    emitter.on("error", onError);
    emitter.emit("trackStart", { track: undefined as never, index: 0 });
    expect(onError).not.toHaveBeenCalled();
    // Emitting error directly still notifies once without looping.
    emitter.emit("error", {
      error: { name: "E", code: "ENGINE_ERROR", message: "m", retryable: false },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
