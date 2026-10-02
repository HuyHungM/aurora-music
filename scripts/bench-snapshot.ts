/**
 * Snapshot-path benchmark.
 *
 * Measures the cost of one `engine.getState()` — the call every
 * `useMusicEngineState` subscriber makes on every store notification.
 *
 * Run with: `bun run bench:snapshot [queueSize] [subscribers]`
 * (defaults: 200 entries, 40 subscribers)
 *
 * Wired to a package script so the number quoted in ARCHITECTURE.md §20.3
 * (165.9 us → 4.65 us per snapshot, i.e. 24.8 ms → 0.8 ms of CPU per second
 * at 4 Hz with a 200-entry queue) can be reproduced rather than taken on
 * trust. It is not part of any gate: it prints, it asserts nothing, and its
 * numbers are machine-dependent.
 */
import { createMusicEngine } from "../src/lib/music/music-engine";
import { createQueueManager } from "../src/lib/music/queue-manager";
import { fakeEnv, fakeSignals } from "../src/lib/music/__tests__/fake-facade-env";
import type { Track } from "@/lib/domain/track";

const QUEUE_SIZE = Number(process.argv[2] ?? 200);
const SUBSCRIBERS = Number(process.argv[3] ?? 40);
const ITERATIONS = 20_000;

function makeTrack(id: string): Track {
  return {
    provider: "youtube",
    providerTrackId: `yt-${id}`,
    title: `Track ${id}`,
    artistId: `art-${id}`,
    artistName: `Artist ${id}`,
    albumId: `alb-${id}`,
    albumName: `Album ${id}`,
    artworkUrl: `https://img.example/${id}.jpg`,
    duration: 200,
    explicit: false,
    genres: ["pop"],
    metadata: { sources: [{ provider: "youtube", id: `yt-${id}` }] },
  } as unknown as Track;
}

const env = fakeEnv();
const tracks = Array.from({ length: QUEUE_SIZE }, (_, i) => makeTrack(String(i)));
env.state.queue = tracks;
env.state.playOrder = tracks.map((_, i) => i);
env.state.position = 0;
env.state.currentTrack = tracks[0];

const manager = createQueueManager({
  getState: () => env.state,
  actions: env.actions,
});
const engine = createMusicEngine({
  getState: () => env.state,
  actions: env.actions,
  engine: fakeSignals(),
  search: { search: async () => ({ tracks: [], artists: [], albums: [] }) } as never,
  lookup: { getTrack: async () => null },
  queue: manager,
  subscribeStore: () => () => {},
});
engine.initialize();

function time(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < 2000; i += 1) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const tick = () => {
  // A timeupdate: currentTime changes, queue identity does not.
  env.state.currentTime += 0.25;
};

const oneSnapshot = time(() => engine.getState(), ITERATIONS);
const tickAndSnapshot = time(() => {
  tick();
  engine.getState();
}, ITERATIONS);

const usPerCall = (totalMs: number) => (totalMs * 1000) / ITERATIONS;
const perSecond = (usPerCall(tickAndSnapshot) * SUBSCRIBERS * 4) / 1000;
const perMinute = perSecond * 60;

console.log(`queue=${QUEUE_SIZE} subscribers=${SUBSCRIBERS} iterations=${ITERATIONS}`);
console.log(`getState()            ${oneSnapshot.toFixed(1)} ms total   ${usPerCall(oneSnapshot).toFixed(2)} us/call`);
console.log(`timeupdate + getState ${tickAndSnapshot.toFixed(1)} ms total   ${usPerCall(tickAndSnapshot).toFixed(2)} us/tick`);
console.log(`projected 4Hz x ${SUBSCRIBERS} subs:   ${perSecond.toFixed(1)} ms CPU/s   ${perMinute.toFixed(1)} s CPU/min`);