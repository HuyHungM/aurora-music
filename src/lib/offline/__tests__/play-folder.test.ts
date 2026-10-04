import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareOfflineTracks,
  playlistForFolder,
} from "@/lib/offline/tracks";
import type { OfflineTrackFile } from "@/lib/offline/types";
import {
  remainingQueue,
  setPlaybackController,
  usePlayerStore,
} from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface } from "@/lib/player/__tests__/fake-audio";

/**
 * Play Folder.
 *
 * The ordering half is pure and tested directly. The queue half is NOT
 * re-tested here: a folder session is `playCollection`, which lands in the same
 * `replaceQueue` an album or a playlist uses, so the progression guarantees come
 * from `queue-progression.test.ts` and are asserted HERE only where the folder
 * adds something — the order it hands over, and that a folder of local tracks
 * survives the same transition an online one does.
 */

function file(name: string, folder: string | null = null, id?: string): OfflineTrackFile {
  return { id: id ?? `${folder ?? ""}/${name}`, name, folder };
}

const folder = (...names: string[]) => names.map((name) => file(name));

describe("folder playlist ordering", () => {
  it("sorts numerically, so 10 follows 2", () => {
    // THE case. Plain lexicographic ordering puts "10 - Outro" second, which
    // would play the last track of an album second. `02` and `2` both read as
    // the number 2, so the remainder of the name breaks that tie — measured, not
    // assumed.
    const tracks = playlistForFolder(
      folder("10 - Outro.mp3", "02 - Song A.mp3", "01 - Intro.mp3", "2 - Song B.mp3"),
    );
    // Titles come from `parseFileName`, which splits `"01 - Intro"` on the first
    // `" - "`, so the leading number lands in the ARTIST slot. The ORDER is what
    // this test is about, so it is asserted on the file names.
    expect(tracks.map((track) => track.id)).toEqual([
      "/01 - Intro.mp3",
      "/02 - Song A.mp3",
      "/2 - Song B.mp3",
      "/10 - Outro.mp3",
    ]);
  });

  it("groups by folder, and orders the folders themselves", () => {
    const tracks = playlistForFolder([
      file("02.mp3", "Album B"),
      file("01.mp3", "Album A"),
      file("01.mp3", "Album B"),
      file("02.mp3", "Album A"),
    ]);
    expect(tracks.map((track) => track.id)).toEqual([
      "Album A/01.mp3",
      "Album A/02.mp3",
      "Album B/01.mp3",
      "Album B/02.mp3",
    ]);
  });

  it("puts files at the folder root before files in subfolders", () => {
    // A root file has `folder: null`, which sorts as the empty string and so
    // leads — the same order the scanner produces, so the list a listener reads
    // and the queue they get are the same list.
    const tracks = playlistForFolder([
      file("02.mp3", "Album A"),
      file("01.mp3", null),
    ]);
    expect(tracks.map((track) => track.id)).toEqual(["/01.mp3", "Album A/02.mp3"]);
  });

  it("keeps a stable order for files whose sort keys tie", () => {
    const a = file("Song.mp3", "A", "first");
    const b = file("Song.mp3", "A", "second");
    expect(compareOfflineTracks(a, b)).toBe(0);
    const tracks = playlistForFolder([a, b, file("Song.mp3", "A", "third")]);
    expect(tracks.map((track) => track.id)).toEqual(["first", "second", "third"]);
  });

  it("excludes files that are not audio", () => {
    // A real folder contains cover art and notes, and a queue that tried to play
    // them would stall on an unreadable file.
    const tracks = playlistForFolder(
      folder("01.mp3", "cover.jpg", "notes.txt", "02.flac", "album.nfo"),
    );
    expect(tracks.map((track) => track.title)).toEqual(["01", "02"]);
  });

  it("handles an empty or all-unsupported folder without throwing", () => {
    expect(playlistForFolder([])).toEqual([]);
    expect(playlistForFolder(folder("readme.md", "cover.png"))).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const input = folder("03.mp3", "01.mp3", "02.mp3");
    const before = input.map((f) => f.id);
    playlistForFolder(input);
    expect(input.map((f) => f.id)).toEqual(before);
  });

  it("gives every track local source identity, so nothing is sent to a provider", () => {
    // Offline guarantee: a local file must never be mistaken for a stream.
    for (const track of playlistForFolder(folder("01.mp3", "02.mp3"))) {
      expect(track.provider).toBe("local");
      expect(track.artistId).toBe("local");
    }
  });

  it("keeps each file's folder-relative path as its id", () => {
    const tracks = playlistForFolder([
      file("01.mp3", "Album A/Disc 1"),
    ]);
    expect(tracks[0]?.id).toBe("Album A/Disc 1/01.mp3");
    expect(tracks[0]?.providerTrackId).toBe("Album A/Disc 1/01.mp3");
  });
});

/* -------------------------------------------------------------------------- */

function stubController(): void {
  setPlaybackController(null);
}

function mountEngine(): { surface: FakeAudioSurface; dispose: () => void } {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  return { surface, dispose: usePlayerStore.getState().bindEngine(engine) };
}

function setRepeat(mode: "off" | "all" | "one"): void {
  for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== mode; i += 1) {
    usePlayerStore.getState().cycleRepeat();
  }
}

function startAt(surface: FakeAudioSurface, titles: string[]): void {
  const store = usePlayerStore.getState();
  // Assert the preconditions rather than letting a leaked preference show up as
  // a confusing title mismatch three assertions later.
  expect(store.repeat, "repeat leaked into this test").toBe("off");
  expect(store.shuffle, "shuffle leaked into this test").toBe(false);
  const tracks = titles.map((title, index) => ({
    id: `local-${index}`,
    provider: "local" as const,
    providerTrackId: `local-${index}`,
    title,
    artistId: "local",
    artistName: "—",
    // A resolvable object URL, because that is what the local resolver hands the
    // engine at runtime. Without one the engine takes its "no stream" path,
    // reports the track unavailable, and the queue never advances — which would
    // make every progression test below assert nothing at all.
    streamUrl: `blob:local/${index}`,
  }));
  expect(tracks).toHaveLength(titles.length);
  store.replaceQueue(tracks, { startIndex: 0, autoplay: true });
  surface.dispatch(EventEnum.play);
  expect(
    usePlayerStore.getState().queue.map((track) => track.title),
    "the folder entered the queue in the wrong order or lost tracks",
  ).toEqual(titles);
}

function completeTrack(surface: FakeAudioSurface): void {
  surface.dispatch(EventEnum.ended);
  if (usePlayerStore.getState().isLoading) {
    surface.dispatch(EventEnum.play);
  }
}

const title = () => usePlayerStore.getState().currentTrack?.title ?? null;
const remaining = () =>
  remainingQueue({
    ...usePlayerStore.getState(),
    repeat: usePlayerStore.getState().repeat === "all" ? "queue" : "off",
  }).map((entry) => entry.track.title);

beforeEach(() => {
  // Reset the PREFERENCES directly rather than through `toggleShuffle` /
  // `cycleRepeat`. Both actions are deliberately guarded on a non-empty queue —
  // `toggleShuffle` returns early when `playOrder.length === 0` — so calling
  // them after `clearQueue` is a silent no-op and the preference leaks into every
  // later test. Measured: shuffle left on by one test reordered the next, which
  // surfaced as a folder test reporting track 4 where track 3 was expected.
  usePlayerStore.setState({ shuffle: false, repeat: "off" });
  usePlayerStore.getState().clearQueue();
});
afterEach(() => {
  usePlayerStore.getState().bindEngine(null);
  setPlaybackController(null);
  vi.unstubAllGlobals();
});

describe("folder queue progression", () => {
  const TITLES = ["01 - Intro", "02 - Song A", "03 - Song B", "10 - Outro"];

  it("starts the first track and queues the rest, excluding the current one", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      expect(title()).toBe("01 - Intro");
      expect(remaining()).toEqual(["02 - Song A", "03 - Song B", "10 - Outro"]);
    } finally {
      dispose();
    }
  });

  it("consumes exactly one track per completion, in folder order", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      completeTrack(surface);
      expect([title(), remaining()]).toEqual([
        "02 - Song A",
        ["03 - Song B", "10 - Outro"],
      ]);
      completeTrack(surface);
      expect([title(), remaining()]).toEqual(["03 - Song B", ["10 - Outro"]]);
    } finally {
      dispose();
    }
  });

  it("stops after the last track with Loop Queue OFF, and never returns to A", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      const played: Array<string | null> = [];
      for (let i = 0; i < 6; i += 1) {
        completeTrack(surface);
        played.push(title());
      }
      expect(played).toEqual([
        "02 - Song A",
        "03 - Song B",
        "10 - Outro",
        "10 - Outro",
        "10 - Outro",
        "10 - Outro",
      ]);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(remaining()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("a duplicate completion does not skip the next track", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("02 - Song A");
      // Two more reports for the same completion, with nothing started between.
      surface.dispatch(EventEnum.ended);
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("02 - Song A");
      expect(remaining()).toEqual(["03 - Song B", "10 - Outro"]);
    } finally {
      dispose();
    }
  });

  it("rapid Next presses consume one track each, in order", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      usePlayerStore.getState().next();
      usePlayerStore.getState().next();
      usePlayerStore.getState().next();
      expect(title()).toBe("10 - Outro");
      expect(remaining()).toEqual([]);
      usePlayerStore.getState().next();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });

  it("Loop Track repeats without consuming the folder", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      setRepeat("one");
      completeTrack(surface);
      expect(title()).toBe("01 - Intro");
      completeTrack(surface);
      expect(title()).toBe("01 - Intro");
      expect(remaining()).toEqual(["02 - Song A", "03 - Song B", "10 - Outro"]);
    } finally {
      dispose();
    }
  });

  it("Loop Queue repeats the folder's sequence intentionally", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      setRepeat("all");
      for (const expected of ["02 - Song A", "03 - Song B", "10 - Outro", "01 - Intro"]) {
        completeTrack(surface);
        expect(title()).toBe(expected);
      }
    } finally {
      dispose();
    }
  });

  it("shuffle neither loses nor duplicates a track", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      usePlayerStore.getState().toggleShuffle();
      const visited: string[] = [title() as string];
      for (let i = 0; i < 4; i += 1) {
        completeTrack(surface);
        visited.push(title() as string);
      }
      // Four completions for four tracks: each heard exactly once.
      expect(new Set(visited).size).toBe(4);
      expect(visited).toHaveLength(5);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });

  it("switching to another context replaces the folder session", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      completeTrack(surface);
      // An album, a playlist or a search result: the same replace path.
      usePlayerStore.getState().replaceQueue(
        [
          {
            id: "yt-1",
            provider: "youtube",
            providerTrackId: "yt-1",
            title: "Online Track",
            artistId: "yt-a",
            artistName: "Someone",
            streamUrl: "https://example.invalid/yt-1.m4a",
          },
        ],
        { startIndex: 0, autoplay: true },
      );
      surface.dispatch(EventEnum.play);
      expect(title()).toBe("Online Track");
      // No folder track survives to be replayed behind it.
      expect(remaining()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("previous does not duplicate folder tracks", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, TITLES);
      completeTrack(surface);
      completeTrack(surface);
      expect(title()).toBe("03 - Song B");
      usePlayerStore.getState().prev();
      expect(title()).toBe("02 - Song A");
      const state = usePlayerStore.getState();
      expect(state.queue.filter((t) => t.title === "02 - Song A")).toHaveLength(1);
      expect(remaining()).toEqual(["03 - Song B", "10 - Outro"]);
    } finally {
      dispose();
    }
  });
});
