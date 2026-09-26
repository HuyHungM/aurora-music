import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import type { MusicEngine } from "@/lib/music/music-engine";
import { createRadioSession } from "@/lib/radio/session";

vi.mock("@/app/actions/radio", () => ({
  startTrackRadioAction: vi.fn(),
  startArtistRadioAction: vi.fn(),
  startDiscoveryRadioAction: vi.fn(),
  extendRadioBatchAction: vi.fn(),
}));

import {
  extendRadioBatchAction,
  startTrackRadioAction,
} from "@/app/actions/radio";

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
        return [...queue];
      },
      get length() {
        return queue.length;
      },
      get currentIndex() {
        return currentIndex;
      },
      get playOrder() {
        return queue.map((_, index) => index);
      },
    },
    getQueue: () => queue,
  };
}

describe("radio session override semantics (Phase 41)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extendRadioBatchAction).mockResolvedValue({
      ok: true,
      batch: { tracks: [], exhausted: true },
    });
  });

  const seedLabel = { key: "radio.labelFromTrack", params: { title: "Seed" } };

  async function startSession() {
    const session = createRadioSession();
    const engine = makeEngine() as unknown as MusicEngine;
    vi.mocked(startTrackRadioAction).mockResolvedValue({
      ok: true,
      station: {
        tracks: [makeTrack("seed"), makeTrack("r1"), makeTrack("r2")],
      },
    });
    await session.startTrackRadio(engine, makeTrack("seed"), seedLabel);
    return { session, engine };
  }

  it("starts a station through the engine without touching playback internals", async () => {
    const { session, engine } = await startSession();
    expect(session.getState().active).toBe(true);
    expect(session.getState().label).toEqual(seedLabel);
    expect(engine.playCollection).toHaveBeenCalledTimes(1);
    expect(session.getState().playedKeys).toContain("youtube:seed");
  });

  it("tolerates manual add/remove/reorder without ending the session", async () => {
    const { session } = await startSession();
    const base = ["youtube:seed", "youtube:r1", "youtube:r2"];
    session.noteQueueChanged([...base, "youtube:manual"]);
    expect(session.getState().active).toBe(true);
    session.noteQueueChanged(["youtube:seed", "youtube:r2"]);
    expect(session.getState().active).toBe(true);
    session.noteQueueChanged(["youtube:r2", "youtube:seed", "youtube:r1"]);
    expect(session.getState().active).toBe(true);
  });

  it("ends the session on wholesale replacement", async () => {
    const { session } = await startSession();
    session.noteQueueChanged(["youtube:other"]);
    expect(session.getState().active).toBe(false);
  });

  it("ends the session on clear and never refills a cleared queue", async () => {
    const { session, engine } = await startSession();
    // The start kick may have fired into the tiny test catalog; isolate
    // the clear behavior from it.
    vi.mocked(extendRadioBatchAction).mockClear();
    session.noteQueueChanged([]);
    expect(session.getState().active).toBe(false);
    session.maybeExtend(engine);
    await Promise.resolve();
    expect(extendRadioBatchAction).not.toHaveBeenCalled();
  });

  it("extends when the queue runs low and stops after consecutive empty batches", async () => {
    // Six-track station: 5 remaining at start, so the start kick stays
    // quiet and each generation below is explicitly triggered.
    const session = createRadioSession();
    const engine = makeEngine() as unknown as MusicEngine;
    const tracks = ["seed", "r1", "r2", "r3", "r4", "r5"].map((id) => makeTrack(id));
    vi.mocked(startTrackRadioAction).mockResolvedValue({
      ok: true,
      station: { tracks },
    });
    await session.startTrackRadio(engine, tracks[0] as Track, {
      key: "radio.labelDiscovery",
    });
    expect(extendRadioBatchAction).not.toHaveBeenCalled();
    expect(session.getState().generatedTotal).toBe(6);

    // Advance near exhaustion: the first empty batch chains straight
    // into the second (skipped-generation re-check), exhausting the
    // station without further triggers.
    (engine as unknown as { setIndex: (index: number) => void }).setIndex(3);
    session.maybeExtend(engine);
    await vi.waitFor(() => {
      expect(extendRadioBatchAction).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(session.getState().exhausted).toBe(true);
    });

    // Exhausted sessions never generate again.
    session.maybeExtend(engine);
    await Promise.resolve();
    expect(extendRadioBatchAction).toHaveBeenCalledTimes(2);
  });

  it("keeps recent stations in memory for the radio page", async () => {
    const { session } = await startSession();
    expect(session.getState().recent.map((entry) => entry.label)).toEqual([
      seedLabel,
    ]);
  });
});
