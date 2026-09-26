import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import type { MusicEngine } from "@/lib/music/music-engine";
import { createRadioSession } from "@/lib/radio/session";
import {
  getRadioSession,
  setRadioSession,
  subscribeRadioSession,
} from "@/lib/radio/instance";

vi.mock("@/app/actions/radio", () => ({
  startTrackRadioAction: vi.fn(),
  startArtistRadioAction: vi.fn(),
  startDiscoveryRadioAction: vi.fn(),
  extendRadioBatchAction: vi.fn(),
}));

import { extendRadioBatchAction, startTrackRadioAction } from "@/app/actions/radio";

/**
 * The holder is the ONLY notification channel both radio surfaces use.
 *
 * `radio-controls.tsx` and `queue-panel.tsx` both register
 * `subscribeRadioSession` as their `useSyncExternalStore` subscribe function
 * and read `getRadioSession()?.getState()`. If the holder does not fire when
 * the session's state changes, React never re-renders and the radio UI freezes
 * on whatever it first painted.
 *
 * That is not hypothetical: it is exactly what happened, and it was invisible
 * to every other test because each of them drove the session object directly
 * rather than through the holder. `RadioSession.subscribe` had no callers
 * anywhere in the repository.
 */
describe("radio session holder subscription", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setRadioSession(null);
  });

  function makeTrack(id: string): Track {
    return {
      id,
      provider: "youtube",
      providerTrackId: id,
      title: `Track ${id}`,
      artistId: "a1",
      artistName: "Artist",
    };
  }

  function makeEngine() {
    const queue: Track[] = [];
    let currentIndex = 0;
    return {
      playCollection: vi.fn((tracks: Track[]) => {
        queue.length = 0;
        queue.push(...tracks);
        currentIndex = 0;
      }),
      setIndex: (index: number) => {
        currentIndex = index;
      },
      queue: {
        add: vi.fn((track: Track) => {
          queue.push(track);
        }),
        get items() {
          return queue;
        },
        get currentIndex() {
          return currentIndex;
        },
        get length() {
          return queue.length;
        },
      },
    } as unknown as MusicEngine;
  }

  it("notifies subscribers when the session's own state changes", async () => {
    // The regression in one assertion. Before the fix the listener count here
    // stayed at zero for the entire life of the station, so the queue panel
    // rendered "Finding more tracks…" indefinitely while the state machine had
    // already reached `exhausted`.
    const session = createRadioSession();
    setRadioSession(session);
    const listener = vi.fn();
    const unsubscribe = subscribeRadioSession(listener);
    listener.mockClear();

    vi.mocked(startTrackRadioAction).mockResolvedValue({
      ok: true,
      station: { tracks: [makeTrack("t1"), makeTrack("t2")] },
    });
    // Configured BEFORE the start: `startFromTracks` kicks the first extension
    // as a fire-and-forget, so a mock installed afterwards is never the one
    // that answers it.
    vi.mocked(extendRadioBatchAction).mockResolvedValue({
      ok: true,
      batch: { tracks: [], exhausted: true },
    });

    const engine = makeEngine();
    await session.startTrackRadio(engine, makeTrack("t1"), { key: "radio.labelFromTrack" });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it("reports the live state a re-render would read", async () => {
    // The holder must expose the SAME object the session publishes, so a
    // subscriber woken by the forwarding call reads the new state rather than
    // the previous one.
    const session = createRadioSession();
    setRadioSession(session);
    vi.mocked(startTrackRadioAction).mockResolvedValue({
      ok: true,
      station: { tracks: [makeTrack("t1"), makeTrack("t2")] },
    });
    // Two empty batches is the documented exhaustion threshold, and the
    // extension is kicked inside `startFromTracks`, so the mock must already be
    // answering before the start resolves.
    vi.mocked(extendRadioBatchAction).mockResolvedValue({
      ok: true,
      batch: { tracks: [], exhausted: true },
    });

    const seen: Array<{ generating: boolean; exhausted: boolean }> = [];
    const unsubscribe = subscribeRadioSession(() => {
      const state = getRadioSession()?.getState();
      if (state) {
        seen.push({ generating: state.generating, exhausted: state.exhausted });
      }
    });

    const engine = makeEngine();
    await session.startTrackRadio(engine, makeTrack("t1"), { key: "radio.labelFromTrack" });
    await vi.waitFor(() => {
      expect(session.getState().exhausted).toBe(true);
    });
    unsubscribe();

    // The terminal state must have been observed through the holder, which is
    // the only way the panel can ever render "Radio ran out of recommendations."
    expect(seen.some((entry) => entry.exhausted)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ generating: false, exhausted: true });
  });

  it("stops forwarding once the session is replaced or cleared", async () => {
    // A disposed station must not keep waking subscribers: replacing the
    // session detaches the old forwarding subscription.
    vi.mocked(startTrackRadioAction).mockResolvedValue({
      ok: true,
      station: { tracks: [makeTrack("t1"), makeTrack("t2")] },
    });
    vi.mocked(extendRadioBatchAction).mockResolvedValue({
      ok: true,
      batch: { tracks: [], exhausted: true },
    });

    const first = createRadioSession();
    setRadioSession(first);
    const listener = vi.fn();
    const unsubscribe = subscribeRadioSession(listener);
    // Make `first` genuinely active, so a later queue note reaches `set()`.
    await first.startTrackRadio(makeEngine(), makeTrack("t1"), { key: "radio.labelFromTrack" });

    const second = createRadioSession();
    setRadioSession(second);
    listener.mockClear();

    // Drive the OLD session: a wholesale replacement clears it through `set()`.
    // Nothing should reach the holder any more.
    first.noteQueueChanged(["youtube:completely-different-keys"]);
    expect(listener).not.toHaveBeenCalled();

    // The new session still forwards.
    await second.startTrackRadio(makeEngine(), makeTrack("t9"), { key: "radio.labelFromTrack" });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it("notifies when the holder is written, and again when it is cleared", () => {
    // The original purpose of the holder notification (mirroring
    // `music/instance.ts`): a component that mounts after the station started
    // must still learn that an instance exists.
    const listener = vi.fn();
    const unsubscribe = subscribeRadioSession(listener);
    setRadioSession(createRadioSession());
    expect(listener).toHaveBeenCalledTimes(1);
    setRadioSession(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getRadioSession()).toBeNull();
    unsubscribe();
  });
});
